import "dotenv/config";

import path from "path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import serverConfig from "@karakeep/shared/config";

import dbConfig from "./drizzle.config";
import { instrumentDatabase } from "./instrumentation";
import * as schema from "./schema";

/**
 * The app (and liteque, the queue backend) uses drizzle's sync better-sqlite3
 * driver with async transaction callbacks (`db.transaction(async (tx) => ...)`)
 * . better-sqlite3 <12 tolerated this (committing at the first await point);
 * better-sqlite3 >=12 throws "Transaction function cannot return a promise".
 * Emulate the old behavior with proper semantics instead: drive
 * BEGIN/COMMIT/ROLLBACK (or SAVEPOINT when nested) around the awaited
 * callback.
 *
 * Since only one transaction can be open on a connection at a time,
 * concurrent top-level async transactions on the same instance are
 * serialized through a per-instance promise chain; calls made while a
 * transaction is already open (nested) use SAVEPOINTs instead.
 *
 * Patched on the prototype (not per instance) so that Database instances
 * created inside dependencies (e.g. liteque's queue.db client) are covered
 * too.
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

const sqlite = new Database(dbConfig.dbCredentials.url);

if (serverConfig.database.walMode) {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
} else {
  sqlite.pragma("journal_mode = DELETE");
}
sqlite.pragma("cache_size = -65536");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("temp_store = MEMORY");

instrumentDatabase(sqlite);

export const db = drizzle(sqlite, { schema });
export type DB = typeof db;

export function getInMemoryDB(runMigrations: boolean) {
  const mem = new Database(":memory:");
  const db = drizzle(mem, { schema, logger: false });
  if (runMigrations) {
    migrate(db, { migrationsFolder: path.resolve(__dirname, "./drizzle") });
  }
  return db;
}
