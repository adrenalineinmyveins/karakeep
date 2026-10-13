import { ExtractTablesWithRelations } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import type { PgliteQueryResultHKT } from "drizzle-orm/pglite";

import * as schema from "./schema";

export { db, getDb, runMigrations } from "./drizzle";
export type { DB } from "./drizzle";
export * as schema from "./schema";

// This is exported here to avoid leaking driver-specific types outside of this package.
export type SaiyeDBTransaction = PgTransaction<
  PgliteQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/**
 * 判断唯一约束冲突。PG 的 23505 不区分 UNIQUE/PRIMARY KEY（SQLite 分
 * SQLITE_CONSTRAINT_UNIQUE / SQLITE_CONSTRAINT_PRIMARYKEY），调用方如需
 * 区分场景请结合业务上下文。drizzle 可能将驱动错误包成 DrizzleQueryError
 * （code 在 cause 上），postgres-js/PGlite 原生错误 code 在顶层——两者都查。
 */
export function isUniqueViolation(e: unknown): boolean {
  if (typeof e !== "object" || e === null) {
    return false;
  }
  if ((e as { code?: unknown }).code === "23505") {
    return true;
  }
  return isUniqueViolation((e as { cause?: unknown }).cause);
}
