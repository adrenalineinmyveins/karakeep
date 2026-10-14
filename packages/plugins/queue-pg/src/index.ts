import { and, eq, inArray, sql } from "drizzle-orm";
import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

import type { PluginProvider } from "@saiye/shared/plugins";
import serverConfig from "@saiye/shared/config";
import logger from "@saiye/shared/logger";
import {
  QueueRetryAfterError,
  queueOptionsEqual,
} from "@saiye/shared/queueing";

import type {
  DequeuedJob,
  DequeuedJobError,
  EnqueueOptions,
  Queue,
  QueueClient,
  QueueOptions,
  Runner,
  RunnerFuncs,
  RunnerOptions,
} from "@saiye/shared/queueing";

/** 队列用的最小 DB 形状（兼容 postgres-js / pglite 驱动的 drizzle 实例） */
type QueueDb = PgDatabase<PgQueryResultHKT>;

/**
 * D0-b 队列 PG 化：liteque（sqlite 单文件）的 Postgres 后端。
 * 多实例安全：任务领取用 `FOR UPDATE SKIP LOCKED`（多 worker 进程/
 * 容器并发领取同一表互不冲突）；任务超时用 expireAt 租约回收僵尸行。
 * 语义对齐 liteque：幂等键忽略重复入队、成功后删行、numRetries 重试
 * （指数退避）、keepFailedJobs 决定永久失败是否保留、RetryAfter 不计次。
 */

// ── 表结构 ────────────────────────────────────────────

export const jobQueueTable = pgTable(
  "jobQueue",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    queue: text("queue").notNull(),
    payload: jsonb("payload").notNull(),
    // pending：待领取；running：执行中（expireAt 租约）；pending_retry：
    // 失败等待退避重试；failed：永久失败（仅 keepFailedJobs 时保留）
    status: text("status", {
      enum: ["pending", "running", "pending_retry", "failed"],
    })
      .notNull()
      .default("pending"),
    priority: integer("priority").notNull().default(0),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    availableAt: timestamp("availableAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // running 租约到期时间；过期即视为僵尸可被重新领取
    expireAt: timestamp("expireAt", { withTimezone: true }),
    // 领取者标识（进程内唯一），finalize 时校验防跨租约误提交
    allocationId: text("allocationId"),
    numRunsLeft: integer("numRunsLeft").notNull(),
    maxNumRuns: integer("maxNumRuns").notNull(),
    idempotencyKey: text("idempotencyKey"),
  },
  (t) => [
    index("jobQueue_claim_idx").on(t.queue, t.status, t.availableAt),
    uniqueIndex("jobQueue_idem_idx")
      .on(t.queue, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
  ],
);

type JobRow = typeof jobQueueTable.$inferSelect;

/** 重试退避：5s 起步指数递增，上限 10 分钟 */
function backoffMs(numRunsDone: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, numRunsDone - 1), 10 * 60_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function newAllocationId(): string {
  return `${process.pid}-${Math.random().toString(36).slice(2)}`;
}

// ── 队列（enqueue/stats/cancel/claim/finalize） ───────

class PgQueueWrapper<T> implements Queue<T> {
  constructor(
    private readonly _name: string,
    private readonly db: QueueDb,
    public readonly opts: QueueOptions,
  ) {}

  ensureInit(): Promise<void> {
    return Promise.resolve();
  }

  name(): string {
    return this._name;
  }

  async enqueue(
    payload: T,
    options?: EnqueueOptions,
  ): Promise<string | undefined> {
    const numRetries = this.opts.defaultJobArgs.numRetries;
    const rows = await this.db
      .insert(jobQueueTable)
      .values({
        queue: this._name,
        payload: payload as never,
        priority: options?.priority ?? 0,
        numRunsLeft: numRetries + 1,
        maxNumRuns: numRetries + 1,
        idempotencyKey: options?.idempotencyKey ?? null,
        ...(options?.delayMs
          ? { availableAt: new Date(Date.now() + options.delayMs) }
          : {}),
      })
      // 幂等键冲突（同 queue + key 已存在）→ 忽略并返回 undefined
      //（liteque 同语义；表上仅 PK 与该唯一索引，无 target 等效且更稳）
      .onConflictDoNothing()
      .returning({ id: jobQueueTable.id });
    return rows.length > 0 ? String(rows[0]!.id) : undefined;
  }

  async stats(): Promise<{
    pending: number;
    pending_retry: number;
    running: number;
    failed: number;
  }> {
    const result = await this.db.execute(sql`
      SELECT "status" AS status, count(*)::int AS n
      FROM "jobQueue" WHERE "queue" = ${this._name}
      GROUP BY "status"
    `);
    const rows = (
      result as unknown as { rows: { status: string; n: number }[] }
    ).rows;
    const byStatus = new Map(rows.map((r) => [r.status, r.n]));
    return {
      pending: byStatus.get("pending") ?? 0,
      pending_retry: byStatus.get("pending_retry") ?? 0,
      running: byStatus.get("running") ?? 0,
      failed: byStatus.get("failed") ?? 0,
    };
  }

  async cancelAllNonRunning(): Promise<number> {
    const rows = await this.db
      .delete(jobQueueTable)
      .where(
        and(
          eq(jobQueueTable.queue, this._name),
          inArray(jobQueueTable.status, ["pending", "pending_retry", "failed"]),
        ),
      )
      .returning({ id: jobQueueTable.id });
    return rows.length;
  }

  /**
   * 领取一个任务（多实例安全核心）：子查询按优先级/序锁定一行
   * （pending/pending_retry 到期可领；running 且租约过期的僵尸行可重领），
   * 原子置 running 并写租约。FOR UPDATE SKIP LOCKED 保证多 worker
   * 并发领取同一行时只有一个成功、其余跳过取下一行。
   */
  async claim(
    allocationId: string,
    timeoutSecs: number,
  ): Promise<JobRow | null> {
    const result = await this.db.execute(sql`
      UPDATE "jobQueue" AS j SET
        "status" = 'running',
        "allocationId" = ${allocationId},
        "expireAt" = now() + (${timeoutSecs} * interval '1 second') * 2,
        "numRunsLeft" = j."numRunsLeft" - 1
      WHERE j."id" = (
        SELECT c."id" FROM "jobQueue" c
        WHERE c."queue" = ${this._name}
          AND c."availableAt" <= now()
          AND (
            c."status" IN ('pending', 'pending_retry')
            OR (c."status" = 'running' AND c."expireAt" < now())
          )
        ORDER BY c."priority" ASC, c."id" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING j.*
    `);
    const rows = (result as unknown as { rows?: JobRow[] }).rows;
    return rows?.[0] ?? null;
  }

  /**
   * 任务终态提交（allocationId 校验：租约已被回收重领时忽略本次提交）。
   * - completed：删行（对齐 liteque，成功任务不占表）
   * - pending_retry：退避后重试；refundRetry 补回本次扣掉的次数（RetryAfter）
   * - failed：keepFailedJobs 时保留（并释放幂等键允许重新入队），否则删行
   */
  async finalize(
    job: JobRow,
    status: "completed" | "pending_retry" | "failed",
    opts?: { availableAt?: Date; error?: string },
  ): Promise<void> {
    const guard = and(
      eq(jobQueueTable.id, job.id),
      eq(jobQueueTable.allocationId, job.allocationId!),
    );
    if (status === "completed") {
      await this.db.delete(jobQueueTable).where(guard);
      return;
    }
    if (status === "pending_retry") {
      await this.db
        .update(jobQueueTable)
        .set({
          status: "pending_retry",
          availableAt: opts?.availableAt ?? new Date(),
          expireAt: null,
          allocationId: null,
        })
        .where(guard);
      return;
    }
    if (this.opts.keepFailedJobs) {
      await this.db
        .update(jobQueueTable)
        .set({
          status: "failed",
          expireAt: null,
          allocationId: null,
          // 释放幂等键：永久失败的任务允许同 key 重新入队
          idempotencyKey: null,
        })
        .where(guard);
    } else {
      await this.db.delete(jobQueueTable).where(guard);
    }
  }
}

// ── Runner（轮询 + 并发 + 超时） ──────────────────────

class PgRunner<T, R = void> implements Runner<T> {
  private stopping = false;
  /** in-flight 任务：promise（供 loop 等待）→ AbortController（stop 中止） */
  private inFlight = new Map<Promise<unknown>, AbortController>();

  constructor(
    private readonly queue: PgQueueWrapper<T>,
    private readonly funcs: RunnerFuncs<T, R>,
    private readonly opts: RunnerOptions<T>,
  ) {}

  async run(): Promise<void> {
    await this.loop(false);
  }

  async runUntilEmpty(): Promise<void> {
    await this.loop(true);
  }

  stop(): void {
    this.stopping = true;
    for (const controller of this.inFlight.values()) {
      controller.abort();
    }
  }

  private async loop(breakOnEmpty: boolean): Promise<void> {
    while (!this.stopping) {
      // 填满并发槽
      while (this.inFlight.size < this.opts.concurrency) {
        const job = await this.queue.claim(
          newAllocationId(),
          this.opts.timeoutSecs,
        );
        if (!job) {
          break;
        }
        this.spawn(job);
      }
      if (this.stopping) {
        break;
      }
      if (this.inFlight.size === 0) {
        if (breakOnEmpty) {
          return;
        }
        await sleep(this.opts.pollIntervalMs ?? 1000);
        continue;
      }
      // 任一完成即腾出槽位，立即回到领取循环
      await Promise.race(this.inFlight.keys());
    }
    // 优雅停机：等待 in-flight 结束（stop() 已 abort，任务会尽快退出）
    await Promise.allSettled([...this.inFlight.keys()]);
  }

  private spawn(job: JobRow): void {
    const controller = new AbortController();
    const promise = this.processJob(job, controller).finally(() => {
      this.inFlight.delete(promise);
    });
    // 错误已在 processJob 内消化；此处兜底吸收，避免 unhandled rejection
    promise.catch(() => undefined);
    this.inFlight.set(promise, controller);
  }

  private async processJob(
    job: JobRow,
    controller: AbortController,
  ): Promise<void> {
    const timeout = setTimeout(
      () => controller.abort(),
      this.opts.timeoutSecs * 1000,
    );
    const runNumber = job.maxNumRuns - job.numRunsLeft; // 含本次执行
    try {
      let data: T;
      if (this.opts.validator) {
        const parsed = this.opts.validator.safeParse(job.payload);
        if (!parsed.success) {
          // 载荷不合法：永久失败（重试无意义），不触发 run
          await this.queue.finalize(job, "failed", {
            error: `validation failed: ${parsed.error.message.slice(0, 500)}`,
          });
          await this.funcs.onError?.({
            id: String(job.id),
            priority: job.priority,
            error: new Error(`validation failed: ${parsed.error.message}`),
            runNumber,
            numRetriesLeft: 0,
          });
          return;
        }
        data = parsed.data;
      } else {
        data = job.payload as T;
      }

      const dequeued: DequeuedJob<T> = {
        id: String(job.id),
        data,
        priority: job.priority,
        runNumber,
        abortSignal: controller.signal,
      };
      const result = await this.funcs.run(dequeued);
      await this.queue.finalize(job, "completed");
      await this.funcs.onComplete?.(dequeued, result);
    } catch (error) {
      const jobError: DequeuedJobError<T> = {
        id: String(job.id),
        data: job.payload as T,
        priority: job.priority,
        error: error instanceof Error ? error : new Error(String(error)),
        runNumber,
        numRetriesLeft: Math.max(0, job.numRunsLeft),
      };
      if (error instanceof QueueRetryAfterError) {
        // 限流类延迟重试：不计次数（claim 扣掉的 run 补回）
        await this.queue.finalize(job, "pending_retry", {
          availableAt: new Date(Date.now() + error.delayMs),
        });
        await this.retryRefund(job);
      } else if (job.numRunsLeft > 0) {
        const runsDone = job.maxNumRuns - job.numRunsLeft;
        await this.queue.finalize(job, "pending_retry", {
          availableAt: new Date(Date.now() + backoffMs(runsDone)),
        });
      } else {
        await this.queue.finalize(job, "failed", {
          error: jobError.error.message,
        });
      }
      await this.funcs.onError?.(jobError);
    } finally {
      clearTimeout(timeout);
    }
  }

  /** RetryAfter 补回次数（独立小更新，防与 finalize 竞争写整行） */
  private async retryRefund(job: JobRow): Promise<void> {
    await this.db
      .update(jobQueueTable)
      .set({ numRunsLeft: job.numRunsLeft + 1 })
      .where(
        and(
          eq(jobQueueTable.id, job.id),
          eq(jobQueueTable.status, "pending_retry"),
        ),
      );
  }

  private get db() {
    // 透传给 retryRefund（仅状态校验用途）
    return (this.queue as unknown as { db: QueueDb }).db;
  }
}

// ── QueueClient ───────────────────────────────────────

export class PgQueueClient implements QueueClient {
  private queues = new Map<string, PgQueueWrapper<unknown>>();

  constructor(private readonly db: QueueDb) {}

  async prepare(): Promise<void> {
    // 幂等建表/索引（多实例并发 prepare 安全）
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS "jobQueue" (
        "id" bigserial PRIMARY KEY,
        "queue" text NOT NULL,
        "payload" jsonb NOT NULL,
        "status" text NOT NULL DEFAULT 'pending',
        "priority" integer NOT NULL DEFAULT 0,
        "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
        "availableAt" timestamp with time zone NOT NULL DEFAULT now(),
        "expireAt" timestamp with time zone,
        "allocationId" text,
        "numRunsLeft" integer NOT NULL,
        "maxNumRuns" integer NOT NULL,
        "idempotencyKey" text
      )
    `);
    await this.db.execute(
      sql`CREATE INDEX IF NOT EXISTS "jobQueue_claim_idx" ON "jobQueue" ("queue", "status", "availableAt")`,
    );
    await this.db.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS "jobQueue_idem_idx" ON "jobQueue" ("queue", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL`,
    );
  }

  async start(): Promise<void> {
    // No-op for PG
  }

  createQueue<T>(name: string, options: QueueOptions): Queue<T> {
    const existing = this.queues.get(name);
    if (existing) {
      if (!queueOptionsEqual(existing.opts, options)) {
        throw new Error(`Queue ${name} already exists with different options`);
      }
      return existing as PgQueueWrapper<T>;
    }
    const wrapper = new PgQueueWrapper<T>(name, this.db, options);
    this.queues.set(name, wrapper as PgQueueWrapper<unknown>);
    return wrapper;
  }

  createRunner<T, R = void>(
    queue: Queue<T>,
    funcs: RunnerFuncs<T, R>,
    opts: RunnerOptions<T>,
  ): Runner<T> {
    const wrapper = this.queues.get(queue.name());
    if (!wrapper) {
      throw new Error(`Queue ${queue.name()} not found`);
    }
    return new PgRunner<T, R>(wrapper as PgQueueWrapper<T>, funcs, {
      pollIntervalMs: opts.pollIntervalMs ?? 1000,
      timeoutSecs: opts.timeoutSecs,
      concurrency: opts.concurrency,
      validator: opts.validator,
    });
  }

  async shutdown(): Promise<void> {
    // 连接池由 postgres-js 进程级持有；此处无 per-client 资源需要释放
  }
}

// ── Provider（插件入口接线） ──────────────────────────

export class PgQueueProvider implements PluginProvider<QueueClient> {
  private client: QueueClient | null = null;

  /** DATABASE_URL 存在 = 服务器版 PG（PGlite 嵌入式单机场景不接管，仍走 liteque） */
  static isConfigured(): boolean {
    return !!serverConfig.database.url;
  }

  async getClient(): Promise<QueueClient | null> {
    if (!this.client) {
      const sqlClient = postgres(serverConfig.database.url!, {
        max: 10,
        // 队列连接与主库独立池：慢查询/长事务互不挤占
        idle_timeout: 20,
        connect_timeout: 10,
      });
      this.client = new PgQueueClient(drizzle(sqlClient));
      logger.info("PG queue client initialized (jobQueue table)");
    }
    return this.client;
  }
}
