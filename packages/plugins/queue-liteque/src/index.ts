import path from "node:path";
import Database from "better-sqlite3";
import {
  buildDBClient,
  SqliteQueue as LQ,
  Runner as LQRunner,
  migrateDB,
  RetryAfterError,
} from "liteque";

import type { PluginProvider } from "@saiye/shared/plugins";
import type {
  DequeuedJob,
  EnqueueOptions,
  Queue,
  QueueClient,
  QueueOptions,
  Runner,
  RunnerFuncs,
  RunnerOptions,
} from "@saiye/shared/queueing";
import serverConfig from "@saiye/shared/config";
import {
  QueueRetryAfterError,
  queueOptionsEqual,
} from "@saiye/shared/queueing";

/**
 * liteque 跑在 better-sqlite3 同步驱动上，但宿主代码以 async 回调使用其
 * 事务。better-sqlite3 >=12 拒绝返回 Promise 的事务函数——这里在原型上
 * 打补丁，用 BEGIN/COMMIT/ROLLBACK（嵌套时 SAVEPOINT）围绕被 await 的
 * 回调模拟旧语义；同实例上的顶层 async 事务经 promise 链串行化。
 * （原实现位于 @saiye/db/drizzle.ts，主库迁移 PG 后随队列插件迁移。）
 */
patchDatabaseTransactions();

function patchDatabaseTransactions() {
  const proto = Database.prototype as unknown as {
    transaction?: unknown;
    __asyncTransactionsPatched?: boolean;
  };
  if (proto.__asyncTransactionsPatched) {
    return;
  }
  proto.__asyncTransactionsPatched = true;

  let savepointSeq = 0;
  const txnTails = new WeakMap<object, Promise<unknown>>();
  proto.transaction = function (
    this: Database.Database,
    fn: (...args: unknown[]) => unknown,
  ) {
    const run =
      (behavior: "deferred" | "immediate" | "exclusive") =>
      async (...args: unknown[]) => {
        if (this.inTransaction) {
          // Nested call: run inside the enclosing transaction as a savepoint.
          const savepoint = `sp_async_${savepointSeq++}`;
          this.exec(`savepoint ${savepoint}`);
          try {
            const result = await fn(...args);
            this.exec(`release ${savepoint}`);
            return result;
          } catch (err) {
            if (this.inTransaction) {
              this.exec(`rollback to ${savepoint}; release ${savepoint}`);
            }
            throw err;
          }
        }
        // Top-level call: serialize against other top-level async
        // transactions on this instance.
        const prev = txnTails.get(this) ?? Promise.resolve();
        const task = prev.then(async () => {
          this.exec(`begin ${behavior}`);
          try {
            const result = await fn(...args);
            this.exec("commit");
            return result;
          } catch (err) {
            if (this.inTransaction) {
              this.exec("rollback");
            }
            throw err;
          }
        });
        txnTails.set(
          this,
          task.then(
            () => undefined,
            () => undefined,
          ),
        );
        return task;
      };
    const variants = {
      deferred: run("deferred"),
      immediate: run("immediate"),
      exclusive: run("exclusive"),
    };
    return Object.assign(run("deferred"), variants);
  };
}

class LitequeQueueWrapper<T> implements Queue<T> {
  constructor(
    private readonly _name: string,
    private readonly lq: LQ<T>,
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
    const job = await this.lq.enqueue(payload, options);
    // liteque returns a Job with numeric id
    return job ? String(job.id) : undefined;
  }

  async stats() {
    return this.lq.stats();
  }

  async cancelAllNonRunning(): Promise<number> {
    return this.lq.cancelAllNonRunning();
  }

  // Internal accessor for runner
  get _impl(): LQ<T> {
    return this.lq;
  }
}

class LitequeQueueClient implements QueueClient {
  private db = buildDBClient(path.join(serverConfig.dataDir, "queue.db"), {
    walEnabled: serverConfig.database.walMode,
  });

  private queues = new Map<string, LitequeQueueWrapper<unknown>>();

  async prepare(): Promise<void> {
    migrateDB(this.db);
  }

  async start(): Promise<void> {
    // No-op for sqlite
  }

  createQueue<T>(name: string, options: QueueOptions): Queue<T> {
    const existing = this.queues.get(name);
    if (existing) {
      if (!queueOptionsEqual(existing.opts, options)) {
        throw new Error(`Queue ${name} already exists with different options`);
      }
      return existing as LitequeQueueWrapper<T>;
    }
    const lq = new LQ<T>(name, this.db, {
      defaultJobArgs: { numRetries: options.defaultJobArgs.numRetries },
      keepFailedJobs: options.keepFailedJobs,
    });
    const wrapper = new LitequeQueueWrapper<T>(name, lq, options);
    this.queues.set(name, wrapper);
    return wrapper;
  }

  createRunner<T, R = void>(
    queue: Queue<T>,
    funcs: RunnerFuncs<T, R>,
    opts: RunnerOptions<T>,
  ): Runner<T> {
    const name = queue.name();
    let wrapper = this.queues.get(name);
    if (!wrapper) {
      throw new Error(`Queue ${name} not found`);
    }

    // Wrap the run function to translate QueueRetryAfterError to liteque's RetryAfterError
    const wrappedRun = async (job: DequeuedJob<T>): Promise<R> => {
      try {
        return await funcs.run(job);
      } catch (error) {
        if (error instanceof QueueRetryAfterError) {
          // Translate to liteque's native RetryAfterError
          // This will cause liteque to retry after the delay without counting against attempts
          throw new RetryAfterError(error.delayMs);
        }
        // Re-throw any other errors
        throw error;
      }
    };

    const runner = new LQRunner<T, R>(
      wrapper._impl,
      {
        run: wrappedRun,
        onComplete: funcs.onComplete,
        onError: funcs.onError,
      },
      {
        pollIntervalMs: opts.pollIntervalMs ?? 1000,
        timeoutSecs: opts.timeoutSecs,
        concurrency: opts.concurrency,
        validator: opts.validator,
      },
    );

    return {
      run: () => runner.run(),
      stop: () => runner.stop(),
      runUntilEmpty: () => runner.runUntilEmpty(),
    };
  }

  async shutdown(): Promise<void> {
    // No-op for sqlite
  }
}

export class LitequeQueueProvider implements PluginProvider<QueueClient> {
  private client: QueueClient | null = null;

  async getClient(): Promise<QueueClient | null> {
    if (!this.client) {
      const client = new LitequeQueueClient();
      this.client = client;
    }
    return this.client;
  }
}
