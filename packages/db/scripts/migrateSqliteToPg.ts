/**
 * 一次性数据迁移：SQLite（db.db）→ PGlite（pg.db）。
 *
 * 从 drizzle schema 内省列集合，从归档的 SQLite snapshot（drizzle_sqlite_archive）
 * 读取每列的时间戳模式（秒/毫秒），完成值的方言转换：
 * - timestamp 列：SQLite integer（秒或毫秒）→ Date
 * - json 列：JSON 字符串 → 解析后的对象
 * - generated 列（如 bookmarkTags.normalizedName）跳过，由 PG 自动计算
 *
 * 用法：DATA_DIR=... pnpm --filter @saiye/db migrate:sqlite-to-pg
 * （源库 = ${DATA_DIR}/db.db，目标库 = ${DATA_DIR}/pg.db；目标库需已跑迁移）
 */
import "dotenv/config";

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";
import { getTableColumns, getTableName } from "drizzle-orm";
import type { Column } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";

import serverConfig from "@saiye/shared/config";

import * as schema from "../schema";

const dataDir = serverConfig.dataDir ?? "./data";
const sqlitePath = path.join(dataDir, "db.db");
const pglitePath = path.join(dataDir, "pg.db");

if (!fs.existsSync(sqlitePath)) {
  console.error(`SQLite 源库不存在: ${sqlitePath}`);
  process.exit(1);
}

const sqlite = new Database(sqlitePath, { readonly: true });
// 目标库双驱动：DATABASE_URL → postgres-js（sql.unsafe 对齐 PGlite 的
// query/exec 签名）；否则 PGlite 文件库
const databaseUrl = serverConfig.database.url;
const pglite = databaseUrl ? undefined : new PGlite(pglitePath);
const pgJs = databaseUrl ? postgres(databaseUrl, { max: 1 }) : undefined;

async function execSql(sql: string) {
  if (pgJs) await pgJs.unsafe(sql);
  else await pglite!.exec(sql);
}

async function runQuery(sql: string, params: unknown[]) {
  if (pgJs) await pgJs.unsafe(sql, params as never[]);
  else await pglite!.query(sql, params);
}

/**
 * 时间戳量级启发：秒级 [1e9, 1e11)（2001~5138 年）、毫秒级 [1e11, 1e14)
 * （1973~5138 年），区间不重叠，对真实数据判别可靠。SQLite snapshot 不
 * 保存 timestamp 的 mode（秒/毫秒），故用值域判定。
 */
function toTimestamp(v: unknown): Date {
  const n = Number(v);
  return new Date(n >= 1e11 ? n : n * 1000);
}

function convertValue(column: Column, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (
    column.columnType === "PgTimestamp" ||
    column.columnType === "PgTimestampString"
  ) {
    return toTimestamp(v);
  }
  // json 列：SQLite 存字符串，PG jsonb 需要解析后的值
  if (column.columnType === "PgJson" || column.columnType === "PgJsonb") {
    return typeof v === "string" ? JSON.parse(v) : v;
  }
  return v;
}

function isGenerated(col: Column): boolean {
  // drizzle 运行时把 generatedAlwaysAs 的结果存到 col.generated
  return (
    "generated" in col &&
    (col as { generated?: unknown }).generated !== undefined
  );
}

async function main() {
  // 禁用所有触发器（含 FK 强制）以任意顺序导入；PGlite 不支持
  // session_replicate_role，用 ALTER TABLE ... DISABLE TRIGGER ALL 等价
  const tableNames: string[] = [];
  for (const table of Object.values(schema)) {
    if (typeof table !== "object" || table === null) continue;
    try {
      const name = getTableName(table as PgTable);
      if (typeof name === "string" && name) {
        tableNames.push(name);
      }
    } catch {
      continue;
    }
  }
  for (const name of tableNames) {
    await execSql(`ALTER TABLE "${name}" DISABLE TRIGGER ALL;`);
  }

  let totalRows = 0;
  for (const table of Object.values(schema)) {
    if (typeof table !== "object" || table === null) continue;
    let name: string;
    try {
      name =
        getTableConfig(table as PgTable).name ?? getTableName(table as PgTable);
    } catch {
      continue; // 非 pgTable 导出（类型、枚举等）
    }

    // 跳过 generated 列（INSERT 不允许显式赋值）
    const insertable = Object.entries(getTableColumns(table as PgTable)).filter(
      ([, col]) => !isGenerated(col),
    );
    // INSERT 使用数据库列名（col.name，可能为 snake_case），而非 JS 属性名
    const colNames = insertable.map(([, col]) => col.name);
    const dbCols: Column[] = insertable.map(([, col]) => col);

    let rows: Record<string, unknown>[];
    try {
      const sqliteCols = dbCols.map((c) => `"${c.name}"`).join(", ");
      rows = sqlite
        .prepare(`SELECT ${sqliteCols} FROM "${name}"`)
        .all() as Record<string, unknown>[];
    } catch {
      // SQLite 里不存在该表（如尚未使用过的功能表）——跳过
      continue;
    }
    if (rows.length === 0) continue;

    const placeholders = colNames.map((_, i) => `$${i + 1}`).join(", ");
    const sqlText = `INSERT INTO "${name}" (${colNames.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
    for (const row of rows) {
      const values = dbCols.map((col) => convertValue(col, row[col.name]));
      await runQuery(sqlText, values);
    }
    totalRows += rows.length;
    console.log(`${name}: ${rows.length} 行`);
  }

  for (const name of tableNames) {
    await execSql(`ALTER TABLE "${name}" ENABLE TRIGGER ALL;`);
  }
  console.log(`完成，总行数: ${totalRows}`);
  await pglite?.close();
  await pgJs?.end({ timeout: 5 });
  sqlite.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
