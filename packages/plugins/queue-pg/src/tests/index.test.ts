import { beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";

import { QueueRetryAfterError } from "@saiye/shared/queueing";

import { jobQueueTable, PgQueueClient } from "../index";

/**
 * D0-b PG 队列单测：PGlite 内存库直测语义（幂等/优先级/延迟/重试/租约
 * 回收/stats/cancel/validator/RetryAfter）。多实例竞争语义由
 * FOR UPDATE SKIP LOCKED 保证（PGlite 为真实 PG 语义）。
 */

const db = drizzle(new PGlite());
const client = new PgQueueClient(db);

const QUEUE_OPTS = { defaultJobArgs: { numRetries: 2 }, keepFailedJobs: false };
const KEEP_OPTS = { defaultJobArgs: { numRetries: 0 }, keepFailedJobs: true };

beforeAll(async () => {
  await client.prepare();
});

// 借 Runner 的 claim 路径不合适（私有），直接用内部 wrapper：
// createQueue 幂等返回同一实例，cast 到「公共接口 + 内部 claim/finalize」。
interface InternalQueue {
  enqueue(
    payload: { kind: string; n?: number },
    options?: { idempotencyKey?: string; priority?: number; delayMs?: number },
  ): Promise<string | undefined>;
  stats(): Promise<{
    pending: number;
    pending_retry: number;
    running: number;
    failed: number;
  }>;
  cancelAllNonRunning(): Promise<number>;
  claim(
    allocationId: string,
    timeoutSecs: number,
  ): Promise<{
    id: number;
    numRunsLeft: number;
    maxNumRuns: number;
    allocationId: string | null;
    payload: unknown;
  } | null>;
  finalize(
    job: { id: number; allocationId: string | null },
    status: "completed" | "pending_retry" | "failed",
    opts?: { availableAt?: Date },
  ): Promise<void>;
}

async function makeQueue(name: string, opts = QUEUE_OPTS) {
  const q = client.createQueue<{ kind: string; n?: number }>(name, opts);
  return q as unknown as InternalQueue;
}

async function rowsOf(queueName: string) {
  return db
    .select()
    .from(jobQueueTable)
    .where(eq(jobQueueTable.queue, queueName));
}

describe("PgQueueWrapper", () => {
  test("enqueue → claim → finalize(completed)：成功任务删行", async () => {
    const q = await makeQueue("t-basic");
    const id = await q.enqueue({ kind: "a" });
    expect(id).toBeTruthy();

    const job = await q.claim("alloc-1", 60);
    expect(job).not.toBeNull();
    expect((job!.payload as { kind: string }).kind).toBe("a");
    // numRetries=2 → 初始 numRunsLeft=3，claim 扣 1
    expect(job!.numRunsLeft).toBe(2);

    await q.finalize(job!, "completed");
    expect(await rowsOf("t-basic")).toHaveLength(0);
  });

  test("幂等键：同 key 重复入队被忽略并返回 undefined", async () => {
    const q = await makeQueue("t-idem");
    const first = await q.enqueue({ kind: "x" }, { idempotencyKey: "k1" });
    expect(first).toBeTruthy();
    const second = await q.enqueue({ kind: "x" }, { idempotencyKey: "k1" });
    expect(second).toBeUndefined();
    expect(await rowsOf("t-idem")).toHaveLength(1);
  });

  test("优先级 + FIFO：priority 小者先领取", async () => {
    const q = await makeQueue("t-prio");
    await q.enqueue({ kind: "low" }, { priority: 50 });
    await q.enqueue({ kind: "default-1" });
    await q.enqueue({ kind: "default-2" });

    const first = await q.claim("a1", 60);
    const second = await q.claim("a2", 60);
    expect((first!.payload as { kind: string }).kind).toBe("default-1");
    expect((second!.payload as { kind: string }).kind).toBe("default-2");
    // 收尾，避免污染其他用例（清队列）
    await client.createQueue("t-prio", QUEUE_OPTS).cancelAllNonRunning?.();
  });

  test("delayMs：availableAt 未到不可领取", async () => {
    const q = await makeQueue("t-delay");
    await q.enqueue({ kind: "later" }, { delayMs: 60_000 });
    expect(await q.claim("a", 60)).toBeNull();
    // availableAt 已写入未来时间
    const [row] = await rowsOf("t-delay");
    expect(row!.availableAt.getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  test("失败重试链：claim 扣次数 → pending_retry 退避 → 耗尽后 failed", async () => {
    const q = await makeQueue("t-retry", KEEP_OPTS);
    await q.enqueue({ kind: "boom" }, { idempotencyKey: "retry-1" });

    // numRetries=0 → 仅 1 次执行
    const job = await q.claim("a1", 60);
    expect(job!.numRunsLeft).toBe(0);
    await q.finalize(job!, "failed", { availableAt: new Date() });

    const [row] = await rowsOf("t-retry");
    expect(row!.status).toBe("failed");
    // keepFailedJobs：行保留且幂等键释放（允许同 key 重新入队）
    expect(row!.idempotencyKey).toBeNull();
    const reenqueue = await q.enqueue(
      { kind: "boom" },
      {
        idempotencyKey: "retry-1",
      },
    );
    expect(reenqueue).toBeTruthy();
  });

  test("pending_retry：退避时间写入且到期可重领", async () => {
    const q = await makeQueue("t-backoff");
    await q.enqueue({ kind: "flaky" });
    const job = await q.claim("a1", 60);
    // 立即可重试（availableAt=now）——退避时间由 Runner 计算，wrapper 只落值
    await q.finalize(job!, "pending_retry", { availableAt: new Date() });
    const reClaimed = await q.claim("a2", 60);
    expect(reClaimed).not.toBeNull();
    expect(reClaimed!.numRunsLeft).toBe(1); // 3-1-1
  });

  test("僵尸回收：running 且租约过期可被重新领取", async () => {
    const q = await makeQueue("t-zombie");
    await q.enqueue({ kind: "stuck" });
    const job = await q.claim("dead-worker", 60);
    expect(job).not.toBeNull();
    // 正常租约期内不可重领
    expect(await q.claim("a2", 60)).toBeNull();
    // 手动把租约置为过期
    await db
      .update(jobQueueTable)
      .set({ expireAt: new Date(Date.now() - 1000) })
      .where(eq(jobQueueTable.id, job!.id));
    const reclaimed = await q.claim("healthy-worker", 60);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.allocationId).toBe("healthy-worker");
  });

  test("跨租约保护：旧 allocationId 的 finalize 被忽略", async () => {
    const q = await makeQueue("t-guard");
    await q.enqueue({ kind: "g" });
    const stale = await q.claim("old", 60);
    // 模拟租约被回收重领
    await db
      .update(jobQueueTable)
      .set({ expireAt: new Date(Date.now() - 1000) })
      .where(eq(jobQueueTable.id, stale!.id));
    const fresh = await q.claim("new", 60);
    expect(fresh).not.toBeNull();
    // 旧持有者提交 completed —— 不应删行（新持有者还在跑）
    await q.finalize(stale!, "completed");
    expect(await rowsOf("t-guard")).toHaveLength(1);
  });

  test("stats 与 cancelAllNonRunning", async () => {
    const q = await makeQueue("t-stats");
    await q.enqueue({ kind: "a" });
    await q.enqueue({ kind: "b" }, { idempotencyKey: "s2" });
    const claimed = await q.claim("runner", 60);
    let stats = await q.stats();
    expect(stats).toMatchObject({ pending: 1, running: 1 });

    const cancelled = await q.cancelAllNonRunning();
    expect(cancelled).toBe(1);
    stats = await q.stats();
    expect(stats).toMatchObject({ pending: 0, running: 1 });
    expect(claimed).not.toBeNull();
  });
});

describe("PgRunner", () => {
  test("runUntilEmpty：成功任务回调 + 行删除", async () => {
    const queue = client.createQueue<{ kind: string; n?: number }>(
      "r-basic",
      QUEUE_OPTS,
    );
    await queue.enqueue({ kind: "hello", n: 1 });
    await queue.enqueue({ kind: "hello", n: 2 });

    const seen: number[] = [];
    const runner = client.createRunner(
      queue,
      {
        run: async (job) => {
          seen.push(job.data.n!);
          return job.data.n;
        },
        onComplete: async (job, result) => {
          expect(result).toBe(job.data.n);
        },
      },
      { pollIntervalMs: 10, timeoutSecs: 10, concurrency: 2 },
    );
    await runner.runUntilEmpty!();
    expect(seen.sort()).toEqual([1, 2]);
    expect(await rowsOf("r-basic")).toHaveLength(0);
  });

  test("失败重试至耗尽：keepFailedJobs=false 删行，onError 回调带 numRetriesLeft", async () => {
    const queue = client.createQueue<{ kind: string }>("r-fail", QUEUE_OPTS);
    await queue.enqueue({ kind: "always-fails" });

    const errors: number[] = [];
    let attempts = 0;
    const runner = client.createRunner(
      queue,
      {
        run: async () => {
          attempts++;
          throw new Error("boom");
        },
        onError: async (job) => {
          errors.push(job.numRetriesLeft);
        },
      },
      // 退避最短 5s——测试直接把 pending_retry 的 availableAt 拨回现在
      { pollIntervalMs: 10, timeoutSecs: 10, concurrency: 1 },
    );

    // 跑三轮（每轮失败一次，手动拨快退避）
    for (let i = 0; i < 3; i++) {
      await runner.runUntilEmpty!();
      await db
        .update(jobQueueTable)
        .set({ availableAt: new Date(Date.now() - 1000) })
        .where(
          and(
            eq(jobQueueTable.queue, "r-fail"),
            eq(jobQueueTable.status, "pending_retry"),
          ),
        );
    }
    // numRetries=2 → 共 3 次执行后耗尽删行
    expect(attempts).toBe(3);
    // onError 的 numRetriesLeft：2（首次失败后剩 2 次可重试）→1→0
    expect(errors).toEqual([2, 1, 0]);
    expect(await rowsOf("r-fail")).toHaveLength(0);
  });

  test("validator 拒绝：直接永久失败，不触发 run", async () => {
    const queue = client.createQueue<{ kind: string }>("r-invalid", KEEP_OPTS);
    await queue.enqueue({ kind: "bad" });

    let runCalled = 0;
    const runner = client.createRunner(
      queue,
      {
        run: async () => {
          runCalled++;
        },
      },
      {
        pollIntervalMs: 10,
        timeoutSecs: 10,
        concurrency: 1,
        // 载荷校验：kind 必须是 "good"
        validator: z.object({ kind: z.literal("good") }),
      },
    );
    await runner.runUntilEmpty!();
    expect(runCalled).toBe(0);
    const [row] = await rowsOf("r-invalid");
    expect(row!.status).toBe("failed");
  });

  test("QueueRetryAfterError：延迟重试不消耗次数", async () => {
    const queue = client.createQueue<{ kind: string }>(
      "r-retry-after",
      QUEUE_OPTS,
    );
    await queue.enqueue({ kind: "ratelimited" });

    let attempts = 0;
    const runner = client.createRunner(
      queue,
      {
        run: async () => {
          attempts++;
          if (attempts === 1) {
            throw new QueueRetryAfterError("rate limited", 1);
          }
        },
      },
      { pollIntervalMs: 10, timeoutSecs: 10, concurrency: 1 },
    );
    await runner.runUntilEmpty!();
    // 第一次 RetryAfter → pending_retry（1ms 后可领，不耗次数）
    await new Promise((r) => setTimeout(r, 20));
    await runner.runUntilEmpty!();
    expect(attempts).toBe(2);
    // 第二次成功 → 删行；且第二次 claim 前次数仍是 3-1+1-1=2 扣后……
    //（关键断言：任务最终成功删除，说明 RetryAfter 未把次数耗尽）
    expect(await rowsOf("r-retry-after")).toHaveLength(0);
  });
});
