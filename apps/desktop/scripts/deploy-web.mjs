// 仅部署 web（standalone 五件套）到指定 runtime 目录，复刻 build.mjs step3_web。
// 用法：node apps/desktop/scripts/deploy-web.mjs <targetRuntimeWebDir> [more...]
// 例：node apps/desktop/scripts/deploy-web.mjs ^
//       f:\karakeep\karakeep\apps\desktop\src-tauri\target\debug\runtime\web ^
//       C:\Users\86151\AppData\Local\Karakeep\runtime\web
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const APPS_WEB = path.join(ROOT, "apps", "web");

function rmrf(p) {
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true });
}

function findPkgDist(pkg, fromDir) {
  const candidates = [
    path.join(fromDir, "node_modules", pkg, "dist"),
    path.join(ROOT, "node_modules", pkg, "dist"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function deployWeb(out) {
  const standalone = path.join(APPS_WEB, ".next", "standalone");
  if (!existsSync(standalone)) {
    throw new Error("未找到 .next/standalone，请先 pnpm --filter @karakeep/web build");
  }

  rmrf(out);
  mkdirSync(out, { recursive: true });

  copyDir(standalone, out);
  copyDir(path.join(APPS_WEB, "public"), path.join(out, "apps", "web", "public"));
  mkdirSync(path.join(out, "apps", "web", ".next"), { recursive: true });
  copyDir(
    path.join(APPS_WEB, ".next", "static"),
    path.join(out, "apps", "web", ".next", "static"),
  );

  // Turbopack tracing 缺口补丁：mermaid-to-drawnix dist/ 未被 trace
  const srcDist = findPkgDist("@plait-board/mermaid-to-drawnix", path.join(ROOT, "packages", "trpc"));
  if (!srcDist) throw new Error("找不到 @plait-board/mermaid-to-drawnix 源 dist/");
  const dstDist = path.join(out, "node_modules", "@plait-board", "mermaid-to-drawnix", "dist");
  rmrf(dstDist);
  copyDir(srcDist, dstDist);

  // standalone 会 trace 进开发 .env（含本机 secret）；运行时 env 由 supervisor 注入
  rmrf(path.join(out, "apps", "web", ".env"));
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("用法：node deploy-web.mjs <targetRuntimeWebDir> [more...]");
  process.exit(1);
}
for (const t of targets) {
  console.log(`[deploy-web] -> ${t}`);
  deployWeb(t);
  console.log(`[deploy-web] 完成 ${t}`);
}
