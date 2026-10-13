import "dotenv/config";

import path from "path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as pgliteDrizzle } from "drizzle-orm/pglite";
import { migrate as pgliteMigrate } from "drizzle-orm/pglite/migrator";
import { drizzle as pgjsDrizzle } from "drizzle-orm/postgres-js";
import { migrate as pgjsMigrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import serverConfig from "@saiye/shared/config";

import * as schema from "./schema";

// 迁移目录解析必须是惰性的：Next/Turbopack 服务端 bundle 里
// import.meta.dirname 为 undefined（顶层求值会直接崩溃），而 tsx/vitest
// 的 ESM 环境里 __dirname 不存在——运行时按环境择一，最后兜底 cwd。
declare const __dirname: string | undefined;

function getMigrationsFolder(): string {
  const baseDir =
    import.meta.dirname ??
    (typeof __dirname !== "undefined" ? __dirname : process.cwd());
  return path.resolve(baseDir, "./drizzle");
}

/**
 * PGlite 驱动的 DB 实例类型。两种驱动（postgres-js / PGlite）在 drizzle
 * 层的查询 API 完全一致（select/insert/update/delete/transaction/relational
 * queries），仅原始结果集类型不同——业务代码不直接消费原始结果集，因此
 * postgres-js 实例统一收敛到此类型。
 */
export type DB = ReturnType<typeof buildPgliteDB>;

function buildPgliteDB(file: string) {
  // PGlite 无参构造 = 内存库；传 ":memory:" 会被当作文件路径
  const client = file === ":memory:" ? new PGlite() : new PGlite(file);
  return pgliteDrizzle(client, { schema });
}

function buildPgjsDB(url: string) {
  const client = postgres(url, { max: 10 });
  return pgjsDrizzle(client, { schema }) as unknown as DB;
}

function pgliteDbFile() {
  return serverConfig.dataDir
    ? path.join(serverConfig.dataDir, "pg.db")
    : "./pg.db";
}

// 单例必须挂在 globalThis：Turbopack dev 会为每个 route chunk 单独实例化
// 本模块（模块级 let 缓存随之失效），多个 PGlite 实例同时打开同一 pg.db
// 目录会互相踩踏，表现为查询成功但 PGlite WASM "Aborted()" 崩溃。
// globalThis 在同进程内跨模块图共享（Prisma 在 Next dev 下的同款做法）。
const globalForDb = globalThis as typeof globalThis & {
  __saiyeDbInstance?: DB;
};

export function getDb(): DB {
  if (!globalForDb.__saiyeDbInstance) {
    console.warn(
      `[db] new ${serverConfig.database.url ? "postgres-js" : "PGlite"} instance, target=${serverConfig.database.url ?? pgliteDbFile()}`,
    );
    globalForDb.__saiyeDbInstance = serverConfig.database.url
      ? buildPgjsDB(serverConfig.database.url)
      : buildPgliteDB(pgliteDbFile());
  }
  return globalForDb.__saiyeDbInstance;
}

export const db = getDb();

/** 按当前驱动运行迁移（db:migrate 脚本入口） */
export async function runMigrations(target: DB = db) {
  const migrationsFolder = getMigrationsFolder();
  if (serverConfig.database.url) {
    await pgjsMigrate(
      target as unknown as Parameters<typeof pgjsMigrate>[0],
      { migrationsFolder },
    );
  } else {
    await pgliteMigrate(
      target as unknown as Parameters<typeof pgliteMigrate>[0],
      { migrationsFolder },
    );
  }
}

/**
 * 测试用内存库（PGlite :memory:）。迁移是异步的，返回 Promise。
 */
export async function getInMemoryDB(runMigrations: boolean) {
  const db = buildPgliteDB(":memory:");
  if (runMigrations) {
    await pgliteMigrate(db, { migrationsFolder: getMigrationsFolder() });
  }
  return db;
}
