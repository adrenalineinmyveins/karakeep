import { runMigrations } from "./drizzle";

await runMigrations();

// postgres-js 连接池保持事件循环存活，脚本无法自然退出
process.exit(0);
