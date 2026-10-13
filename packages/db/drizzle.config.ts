import "dotenv/config";

import type { Config } from "drizzle-kit";

import serverConfig from "@saiye/shared/config";

// generate 只读 schema + dialect（不连库），统一按 PostgreSQL 方言生成；
// 迁移执行走 @saiye/db 的 runMigrations（postgres-js / PGlite 双驱动），
// 不经 drizzle-kit。url 仅供 studio 等直连工具使用。
const pgliteFile = serverConfig.dataDir
  ? `${serverConfig.dataDir}/pg.db`
  : "./pg.db";

export default {
  dialect: "postgresql",
  schema: "./schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: serverConfig.database.url ?? pgliteFile,
  },
} satisfies Config;
