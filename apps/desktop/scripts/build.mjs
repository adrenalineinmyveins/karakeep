/**
 * 桌面版打包脚本（M0.3：对应设计文档 §5.1 七步）。
 *
 * 产出：dist/saiye-desktop/ + dist/saiye-desktop-<version>-win-x64.zip
 * 安装目录结构（见设计 §2.2）：
 *   saiye-desktop/
 *   ├─ saiye.cmd              入口
 *   ├─ node/node.exe             官方 win-x64 zip（锁 24.x，与构建机一致）
 *   ├─ runtime/
 *   │  ├─ supervisor/run.mjs     生产 supervisor（与 dev.mjs 同结构，路径不同）
 *   │  ├─ migrate/migrate.cjs    ncc 产物（自包含：+ drizzle/ + better_sqlite3.node）
 *   │  ├─ web/                   next standalone + public + static + mermaid 补丁
 *   │  └─ workers/               tsdown dist/ + pnpm deploy --prod 依赖
 *   ├─ bin/                      meili/ffmpeg/yt-dlp/monolith（可选）二进制
 *   └─ resources/                （留位：图标/说明）
 *
 * 用法：node apps/desktop/scripts/build.mjs
 *
 * 构建顺序（可重入）：
 *   1. turbo 全量构建（pnpm build）
 *   2. runtime/migrate：ncc build packages/db/migrate.ts + 拷贝 drizzle/
 *   3. runtime/web：standalone + public + static + @plait-board/mermaid-to-drawnix/dist 补丁
 *   4. runtime/workers：tsdown（apps/workers build）+ pnpm deploy --filter @saiye/workers --prod
 *   5. bin/：下载并缓存二进制（meili/ffmpeg/yt-dlp；monolith 可选，缺失跳过并 warn）
 *   6. node/：官方 win-x64 zip（版本 = process.version）
 *   7. 拷贝 runtime/supervisor + saiye.cmd → dist 目录并打 zip
 */

import { exec, spawn, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  renameSync,
  statSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const DESKTOP_DIR = path.join(ROOT, "apps", "desktop");
const DIST = path.join(DESKTOP_DIR, "dist");
const STAGE = path.join(DIST, "saiye-desktop"); // 安装目录 staging
const BIN_CACHE = path.join(DESKTOP_DIR, "bin-cache"); // 下载缓存（可重入）
const IS_WIN = process.platform === "win32";

const VERSION =
  JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version ??
  "0.1.0";

// ─────────────────────────────────────────────────────────────
// 二进制下载元数据（与设计 §5.1、Dockerfile 对齐，锁版本）
// ─────────────────────────────────────────────────────────────

const MEILI_VERSION = "v1.41.0";
const MEILI_URL = `https://github.com/meilisearch/meilisearch/releases/download/${MEILI_VERSION}/meilisearch-windows-amd64.exe`;
const MEILI_FILE = "meilisearch.exe";

// ffmpeg essentials（Gyan.dev 常用分发，体积约 100MB 解压后；~75MB zip）
// 注：essentials 相比 full 缺失 uncommon codec（桌面视频处理足够）
const FFMPEG_VERSION = "7.1";
const FFMPEG_BASENAME = `ffmpeg-${FFMPEG_VERSION}-essentials_build.7z`;
const FFMPEG_URL = `https://github.com/GyanD/codexffmpeg/releases/download/${FFMPEG_VERSION}/${FFMPEG_BASENAME}`;

// yt-dlp：锁 latest 下载名（Windows 单文件），并按设计 §5.1 注：
// yt-dlp >=2025.x 需 js runtime（本机已捆绑 node，supervisor 注入 YTDLP_CONFIG：--js-runtimes node）
const YTDLP_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
const YTDLP_FILE = "yt-dlp.exe";

// monolith：Windows 构建不常发 release（且仓库构建需 Rust），缺失不阻塞，仅尝试
const MONOLITH_VERSION = "2.8.6";
const MONOLITH_URL = `https://github.com/Y2Z/monolith/releases/download/v${MONOLITH_VERSION}/x86_64-windows-msvc-monolith.exe`;
const MONOLITH_FILE = "monolith.exe";

// Node 官方：与构建机 process.version 一致（锁 24.x）
const NODE_VERSION = process.version; // e.g. "v24.16.0"
const NODE_BASENAME = `node-${NODE_VERSION}-win-x64`;
const NODE_URL = `https://nodejs.org/dist/${NODE_VERSION}/${NODE_BASENAME}.zip`;

// ─────────────────────────────────────────────────────────────
// 日志/工具
// ─────────────────────────────────────────────────────────────

function step(msg) {
  const line = `[build ${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    step(`> ${cmd} ${args.join(" ")}${opts.cwd ? `  (cwd: ${path.relative(ROOT, opts.cwd)})` : ""}`);
    const proc = spawn(cmd, args, {
      cwd: opts.cwd ?? ROOT,
      env: opts.env ?? process.env,
      stdio: "inherit",
      shell: opts.shell ?? false,
    });
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Exit ${code}: ${cmd} ${args.join(" ")}`));
    });
  });
}

function pnpmRun(args, opts = {}) {
  const cmd = IS_WIN ? "pnpm.cmd" : "pnpm";
  return run(cmd, args, { shell: IS_WIN ? true : false, ...opts });
}

async function download(url, dest) {
  if (existsSync(dest) && statSync(dest).size > 0) {
    step(`[缓存命中] ${path.basename(dest)}`);
    return;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  step(`下载 ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  const sizeMB = (buf.length / 1024 / 1024).toFixed(1);
  const sha = createHash("sha256").update(buf).digest("hex").slice(0, 16);
  step(`已保存 ${path.basename(dest)}（${sizeMB} MB，sha256:${sha}…）`);
}

function rmrf(p) {
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true });
}

function dirSizeMB(dir) {
  let total = 0;
  const walk = (d) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      // 跳过 junction/symlink：Windows junction 为绝对路径，跟随会导致
      // 重复计数甚至环（.pnpm 布局）；链接目标自身会在真实路径处被统计。
      if (f.isSymbolicLink()) continue;
      const full = path.join(d, f.name);
      if (f.isDirectory()) walk(full);
      else total += statSync(full).size;
    }
  };
  if (existsSync(dir)) walk(dir);
  return (total / 1024 / 1024).toFixed(1);
}

// ─────────────────────────────────────────────────────────────
// 步骤 1：分别构建 web + workers（与 Dockerfile 一致，不跑 turbo 全量）
// ─────────────────────────────────────────────────────────────

async function step1_turboBuild() {
  step("步骤 1/7：构建 web + workers（分别 pnpm build）...");
  const env = {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: "1",
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
  };
  // web: next build --experimental-build-mode compile → .next/standalone
  const webReady = existsSync(path.join(APPS_WEB, ".next", "standalone", "apps", "web", "server.js"));
  if (webReady) {
    step("  [跳过] web standalone 已存在（如需重建请删除 apps/web/.next）");
  } else {
    await pnpmRun(
      ["--filter", "@saiye/web", "--config.verify-deps-before-run=false", "build"],
      { env },
    );
  }
  // workers: tsdown → dist/index.js
  const workersReady = existsSync(path.join(APPS_WORKERS, "dist", "index.js"));
  if (workersReady) {
    step("  [跳过] workers dist/index.js 已存在（如需重建请删除 apps/workers/dist）");
  } else {
    await pnpmRun(
      ["--filter", "@saiye/workers", "--config.verify-deps-before-run=false", "build"],
      { env },
    );
  }
}

// ─────────────────────────────────────────────────────────────
// 步骤 2：runtime/migrate（ncc 单文件 + drizzle/，复用 Dockerfile:71-73）
// ─────────────────────────────────────────────────────────────

const PACKAGES_DB = path.join(ROOT, "packages", "db");

async function step2_migrate() {
  step("步骤 2/7：runtime/migrate（ncc + drizzle）...");
  const out = path.join(STAGE, "runtime", "migrate");
  rmrf(out);
  const tmp = path.join(DIST, "tmp-migrate");
  rmrf(tmp);
  mkdirSync(tmp, { recursive: true });
  // ncc 按入口模块系统决定输出格式：直接用 migrate.ts（ESM）会输出 ESM，
  // 而 bundle 内 better-sqlite3 / source-map-support 等 CJS 依赖在 ESM 下
  // 缺 require/__filename 全局会崩溃。用 CJS wrapper 入口强制输出 CJS。
  // 注意 ncc -o 会清空输出目录，entry 不能放在输出目录里。
  const entry = path.join(DIST, "tmp-migrate-entry.cjs");
  writeFileSync(
    entry,
    `require(${JSON.stringify(path.join(PACKAGES_DB, "migrate.ts"))})\n`,
  );
  await pnpmRun(
    [
      "--config.verify-deps-before-run=false",
      "exec",
      "ncc",
      "build",
      entry,
      "-o",
      tmp,
    ],
    { cwd: ROOT },
  );
  mkdirSync(out, { recursive: true });
  // ncc 产物与入口同名（index.cjs），且 assets 自带运行所需的一切：
  // build/Release/better_sqlite3.node（native）+ drizzle/（迁移 SQL + meta），
  // 整目录拷贝即为自包含的 migrate 运行时（已实测跑通）
  copyDir(tmp, out);
  renameSync(path.join(out, "index.cjs"), path.join(out, "migrate.cjs"));
  rmrf(tmp);
  rmrf(entry);
  step(`  migrate 输出目录 ${dirSizeMB(out)} MB`);
}

// ─────────────────────────────────────────────────────────────
// 步骤 3：runtime/web（standalone + public + static + mermaid 补丁）
// ─────────────────────────────────────────────────────────────

const APPS_WEB = path.join(ROOT, "apps", "web");

async function step3_web() {
  step("步骤 3/7：runtime/web（standalone + public + static + mermaid 补丁）...");
  const out = path.join(STAGE, "runtime", "web");
  rmrf(out);
  mkdirSync(out, { recursive: true });

  const standalone = path.join(APPS_WEB, ".next", "standalone");
  if (!existsSync(standalone)) {
    throw new Error(
      "未找到 .next/standalone，请先 next build（output: standalone 已在 next.config.mjs 中开启）",
    );
  }
  // standalone 里包含 apps/web/server.js 与 node_modules
  copyDir(standalone, out);
  // public：standalone 不含（Next 文档说明）
  copyDir(path.join(APPS_WEB, "public"), path.join(out, "apps", "web", "public"));
  // .next/static：standalone 不含（Next 文档说明）
  mkdirSync(path.join(out, "apps", "web", ".next"), { recursive: true });
  copyDir(
    path.join(APPS_WEB, ".next", "static"),
    path.join(out, "apps", "web", ".next", "static"),
  );

  // Turbopack tracing 缺口补丁（Dockerfile:184-188 已踩坑）：
  // @plait-board/mermaid-to-drawnix 的 dist/ 未被 trace，
  // tracing 只拷了 package.json。
  const srcDist = findPkgDist("@plait-board/mermaid-to-drawnix", path.join(ROOT, "packages", "trpc"));
  if (!srcDist) throw new Error("找不到 @plait-board/mermaid-to-drawnix 源 dist/");
  const dstDist = path.join(out, "node_modules", "@plait-board", "mermaid-to-drawnix", "dist");
  rmrf(dstDist);
  copyDir(srcDist, dstDist);

  // standalone 会把 apps/web/.env（开发配置，含本机 secret）trace 进来；
  // 运行时 env 全部由 supervisor 注入（run.mjs baseEnv），分发包不得携带
  rmrf(path.join(out, "apps", "web", ".env"));

  step(`  web 输出目录 ${dirSizeMB(out)} MB`);
}

function findPkgDist(pkg, fromDir) {
  // 可能在 fromDir/node_modules 或根 node_modules（pnpm hoist / isolated 差异）
  const candidates = [
    path.join(fromDir, "node_modules", pkg, "dist"),
    path.join(ROOT, "node_modules", pkg, "dist"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

// ─────────────────────────────────────────────────────────────
// 步骤 4：runtime/workers（tsdown + pnpm deploy --prod）
// 与 Dockerfile:79-81 同构
// ─────────────────────────────────────────────────────────────

const APPS_WORKERS = path.join(ROOT, "apps", "workers");

async function step4_workers() {
  step("步骤 4/7：runtime/workers（tsdown + pnpm deploy --prod）...");
  const out = path.join(STAGE, "runtime", "workers");
  rmrf(out);

  // pnpm deploy 产出：apps/workers/package.json 对应的 prod 依赖 + build 输出。
  // 使用 pnpm v10 新 deploy 实现（inject-workspace-packages=true）：
  //   - 新实现产出可重定位的自包含目录（hoisted 扁平 node_modules，零 junction），
  //     可直接 rename/打 zip；实测不触碰源 workspace 的 node_modules。
  //   - legacy 实现（--legacy）在 Windows hoisted workspace 下会损坏源 workspace
  //     junction（EACCES 中断后留下 dangling reparse point），故不可用。
  //   - isolated linker 在 Windows 上用绝对路径 junction，目录一旦移动/打 zip
  //     就全部 dangling，故不使用（新实现默认 hoisted）。
  //   - workspace 包（@saiye/*）由 tsdown noExternal 全部 bundle 进 dist/index.js，
  //     产物里的 @saiye/* 源码目录仅冗余、不参与运行时解析。
  //   - 不用 --ignore-scripts：better-sqlite3 / re2 都靠 install 脚本下载预编译 .node
  //     （re2 的 install 脚本：install-from-cache 拉 GitHub release 预编译，失败才
  //     fallback node-gyp；本机无 VS C++ 工具链，fallback 必败，故必须让预编译下载成功。
  //     切勿设置 RE2_DOWNLOAD_SKIP_PATH / RE2_DOWNLOAD_SKIP_VER——那会让
  //     install-from-cache 构造出残缺 URL 直接 404。）
  await pnpmRun(
    [
      "--config.verify-deps-before-run=false",
      "--config.inject-workspace-packages=true",
      "deploy",
      "--filter",
      "@saiye/workers",
      "--prod",
      out,
    ],
    {
      env: {
        ...process.env,
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      },
    },
  );

  // 新 deploy 实现会拷入项目 dist/，这里再覆盖一次保证与当前构建一致（幂等）
  const distSrc = path.join(APPS_WORKERS, "dist");
  if (!existsSync(distSrc)) {
    throw new Error("apps/workers/dist 未构建（请先 apps/workers build）");
  }
  copyDir(distSrc, path.join(out, "dist"));
  // 入口：index.ts → dist/index.js（tsdown config: format=esm, shims=true；
  // 因为 package.json 已带 "type":"module"，.js 会被 node 作 ESM 处理）
  const entry = path.join(out, "dist", "index.js");
  if (!existsSync(entry)) throw new Error(`workers 入口缺失：${entry}`);

  // pnpm deploy 会拷入 apps/workers/.env（开发配置，含本机 secret）；
  // 运行时 env 由 supervisor 注入（run.mjs baseEnv），分发包不得携带
  rmrf(path.join(out, ".env"));

  step(`  workers 输出目录 ${dirSizeMB(out)} MB`);
}

// ─────────────────────────────────────────────────────────────
// 步骤 5：bin/ 二进制（带缓存，可重入）
// ─────────────────────────────────────────────────────────────

async function step5_binaries() {
  step("步骤 5/7：bin/ 二进制（缓存目录 apps/desktop/bin-cache）...");
  const binOut = path.join(STAGE, "bin");
  mkdirSync(BIN_CACHE, { recursive: true });
  mkdirSync(binOut, { recursive: true });

  // 5.1 meilisearch
  const meiliCached = path.join(BIN_CACHE, `meilisearch-${MEILI_VERSION}.exe`);
  await download(MEILI_URL, meiliCached);
  copyFileSync(meiliCached, path.join(binOut, MEILI_FILE));

  // 5.2 ffmpeg（essentials）：7z → 需系统 7z 或 PowerShell Expand-Archive 不支持 .7z；
  // Windows 上常见解压 .7z 手段：若已安装 7z 则 7z x，否则用 node 版 node-7z 包太重。
  // Phase 0 简化：先下载 .7z 到缓存；若本机有 7z 则解压取 ffmpeg.exe + dll；
  // 否则仅把 7z 原文件作为占位放进 bin/（打包完成时输出明确 warning 供 M0.4 验收手工补齐）。
  const ffmpegCached = path.join(BIN_CACHE, FFMPEG_BASENAME);
  await download(FFMPEG_URL, ffmpegCached);
  const ffmpegExtractedRoot = path.join(BIN_CACHE, "ffmpeg-extracted");
  let have7z = false;
  try {
    execSync("7z", { stdio: "ignore" });
    have7z = true;
  } catch {
    have7z = false;
  }
  if (have7z) {
    rmrf(ffmpegExtractedRoot);
    mkdirSync(ffmpegExtractedRoot, { recursive: true });
    step("  7z 解压 ffmpeg essentials ...");
    await run("7z", ["x", "-y", `-o${ffmpegExtractedRoot}`, ffmpegCached], { shell: false });
    // 找子目录名（ffmpeg-7.1-essentials_build/bin/ 下）
    let binDir = null;
    for (const d of readdirSync(ffmpegExtractedRoot)) {
      const b = path.join(ffmpegExtractedRoot, d, "bin");
      if (existsSync(b)) { binDir = b; break; }
    }
    if (binDir) {
      for (const f of readdirSync(binDir)) {
        copyFileSync(path.join(binDir, f), path.join(binOut, f));
      }
    } else {
      step("  [WARN] 7z 解压后未找到 bin/，ffmpeg 未拷贝");
    }
  } else {
    copyFileSync(ffmpegCached, path.join(binOut, FFMPEG_BASENAME));
    step("  [WARN] 本机未安装 7z，ffmpeg 7z 原文件已拷入 bin/，请手工解压 ffmpeg.exe + dll 到 bin/（或重新运行构建）");
  }

  // 5.3 yt-dlp（单文件）
  const ytdlpCached = path.join(BIN_CACHE, YTDLP_FILE);
  await download(YTDLP_URL, ytdlpCached);
  copyFileSync(ytdlpCached, path.join(binOut, YTDLP_FILE));

  // 5.4 monolith（可选）
  try {
    const monoCached = path.join(BIN_CACHE, `monolith-${MONOLITH_VERSION}.exe`);
    await download(MONOLITH_URL, monoCached);
    copyFileSync(monoCached, path.join(binOut, MONOLITH_FILE));
  } catch (e) {
    step(`  [WARN] monolith 下载失败：${e?.message ?? e}；不阻塞打包，后续补即可`);
  }

  step(`  bin 目录 ${dirSizeMB(binOut)} MB`);
}

// ─────────────────────────────────────────────────────────────
// 步骤 6：node/node.exe（官方 win-x64 zip，版本 = 构建机）
// ─────────────────────────────────────────────────────────────

async function step6_node() {
  step(`步骤 6/7：node/（官方 ${NODE_BASENAME}.zip）...`);
  const nodeOut = path.join(STAGE, "node");
  rmrf(nodeOut);
  mkdirSync(nodeOut, { recursive: true });

  const cachedZip = path.join(BIN_CACHE, `${NODE_BASENAME}.zip`);
  await download(NODE_URL, cachedZip);

  // 解压
  const tmp = path.join(DIST, "tmp-node");
  rmrf(tmp);
  mkdirSync(tmp, { recursive: true });
  step("  解压 node zip ...");
  await run("powershell", [
    "-NoProfile",
    "-Command",
    `Expand-Archive -Path '${cachedZip}' -DestinationPath '${tmp}' -Force`,
  ]);
  const nodeBin = path.join(tmp, NODE_BASENAME);
  if (!existsSync(nodeBin)) throw new Error(`解压 node 后未找到 ${NODE_BASENAME}`);
  for (const f of readdirSync(nodeBin)) {
    const s = path.join(nodeBin, f);
    const d = path.join(nodeOut, f);
    if (statSync(s).isDirectory()) copyDir(s, d);
    else copyFileSync(s, d);
  }
  rmrf(tmp);
  step(`  node 目录 ${dirSizeMB(nodeOut)} MB`);
}

// ─────────────────────────────────────────────────────────────
// 步骤 7：组装运行时文件（supervisor/run.mjs、saiye.cmd）+ zip
// ─────────────────────────────────────────────────────────────

async function step7_assemble() {
  step("步骤 7/7：组装 runtime/supervisor + saiye.cmd + zip ...");

  // runtime/supervisor/run.mjs：由 apps/desktop/scripts/run.mjs 拷贝（单独的生产 supervisor）
  const srcSupervisor = path.join(DESKTOP_DIR, "scripts", "run.mjs");
  if (!existsSync(srcSupervisor)) throw new Error("未找到 apps/desktop/scripts/run.mjs，请先实现生产 supervisor");
  const dstSupervisor = path.join(STAGE, "runtime", "supervisor");
  rmrf(dstSupervisor);
  mkdirSync(dstSupervisor, { recursive: true });
  copyFileSync(srcSupervisor, path.join(dstSupervisor, "run.mjs"));

  // saiye.cmd（根入口）
  // 注意：内容只用 ASCII。cmd.exe 按系统代码页（中文 Windows = GBK）解析批处理，
  // UTF-8 中文注释会被误读成乱码命令逐行报错
  const cmdPath = path.join(STAGE, "saiye.cmd");
  writeFileSync(
    cmdPath,
    `@echo off
REM Saiye desktop entrypoint
REM Run bundled node on runtime\\supervisor\\run.mjs (cwd = install dir)
setlocal
set "INSTALL_DIR=%~dp0"
cd /d "%INSTALL_DIR%"
set "PATH=%INSTALL_DIR%bin;%PATH%"
REM yt-dlp >=2025.x needs a js runtime; bundled node is on PATH
set YTDLP_CONFIG=--js-runtimes node
"%INSTALL_DIR%node\\node.exe" "%INSTALL_DIR%runtime\\supervisor\\run.mjs"
endlocal
`,
  );

  // resources 目录占位（未来放图标/说明）
  mkdirSync(path.join(STAGE, "resources"), { recursive: true });

  // 打印体积
  step("── 打包后体积汇总 ──");
  for (const sub of ["node", "runtime", "bin"]) {
    const p = path.join(STAGE, sub);
    step(`  ${sub}/  ${dirSizeMB(p)} MB`);
  }
  step(`  安装目录合计  ${dirSizeMB(STAGE)} MB`);

  // zip
  const zipName = `saiye-desktop-${VERSION}-win-x64.zip`;
  const zipPath = path.join(DIST, zipName);
  rmrf(zipPath);
  step(`生成 ${zipName} ...`);
  // 用系统自带 bsdtar（Windows 10+ 内置；-a 按 .zip 扩展名选 zip 格式，边压边写）。
  // 不用 Compress-Archive：PS 5.1 对 GB 级目录会把 zip 缓冲在内存且极慢。
  // -C DIST + saiye-desktop → zip 内一级目录是 saiye-desktop/
  await run("tar.exe", ["-a", "-cf", zipPath, "-C", DIST, "saiye-desktop"]);
  const zipSize = (statSync(zipPath).size / 1024 / 1024).toFixed(1);
  step(`  zip  ${zipSize} MB  →  ${path.relative(ROOT, zipPath)}`);
}

// ─────────────────────────────────────────────────────────────
// 步骤 8（Phase 1）：Tauri 壳 + NSIS 安装器（可选；工具链缺失时跳过）
// ─────────────────────────────────────────────────────────────

async function step8_installer() {
  step("步骤 8（Phase 1）：Tauri 壳 + NSIS 安装器 ...");

  // 前置：rustup 安装的 cargo（新 shell 的 PATH 可能未刷新，用绝对路径探测）
  const cargoBin = path.join(process.env.USERPROFILE ?? "", ".cargo", "bin");
  const cargoExe = path.join(cargoBin, process.platform === "win32" ? "cargo.exe" : "cargo");
  const env = { ...process.env, PATH: `${cargoBin}${path.delimiter}${process.env.PATH ?? ""}` };
  if (!existsSync(cargoExe)) {
    step("  [WARN] 未找到 cargo（Rust 工具链未安装），跳过安装器；zip 分发不受影响");
    return;
  }
  const tauriConf = path.join(DESKTOP_DIR, "src-tauri", "tauri.conf.json");
  if (!existsSync(tauriConf)) {
    step("  [WARN] src-tauri 不存在，跳过安装器");
    return;
  }

  // 打包 payload.tar.gz：将 runtime/node/bin 三级目录合并为单档案
  // （NSIS 对 86k+ 文件的脚本生成会卡死；单档案方案绕过此限制）
  // 输出到 src-tauri/ 下（NSIS File 命令不支持路径含 ..）
  const payloadPath = path.join(DESKTOP_DIR, "src-tauri", "payload.tar.gz");
  step("  打包 payload.tar.gz ...");
  await run("tar.exe", ["-czf", payloadPath, "-C", STAGE, "runtime", "node", "bin"]);
  const payloadMB = (statSync(payloadPath).size / 1024 / 1024).toFixed(1);
  step(`  payload  ${payloadMB} MB  →  ${path.relative(ROOT, payloadPath)}`);

  // tauri build：cargo release 编译 + NSIS bundle（resources 只含 payload.tar.gz 单档案）
  await pnpmRun(["--filter", "@saiye/desktop", "exec", "tauri", "build"], {
    cwd: DESKTOP_DIR,
    env,
  });

  // 收集产物 → dist/
  const nsisDir = path.join(DESKTOP_DIR, "src-tauri", "target", "release", "bundle", "nsis");
  if (!existsSync(nsisDir)) throw new Error(`tauri build 完成但未找到 NSIS 产物目录：${nsisDir}`);
  const setups = readdirSync(nsisDir).filter((f) => f.endsWith("-setup.exe"));
  if (setups.length === 0) throw new Error(`NSIS 目录中没有 *-setup.exe：${nsisDir}`);
  for (const f of setups) {
    copyFileSync(path.join(nsisDir, f), path.join(DIST, f));
    const mb = (statSync(path.join(nsisDir, f)).size / 1024 / 1024).toFixed(1);
    step(`  安装器 ${f}  ${mb} MB  →  ${path.relative(ROOT, path.join(DIST, f))}`);
  }
}

// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────

async function main() {
  if (!IS_WIN) {
    step("[WARN] 当前不是 Windows；此脚本按 Windows 打包流程设计（binaries/7z/powershell），请在 win 机或 CI windows runner 执行");
  }
  rmrf(STAGE); // 每轮重建 staging（bin-cache 保留）
  mkdirSync(STAGE, { recursive: true });

  await step1_turboBuild();
  await step2_migrate();
  await step3_web();
  await step4_workers();
  await step5_binaries();
  await step6_node();
  await step7_assemble();
  await step8_installer();

  step("✅ 全部步骤完成。安装目录：" + path.relative(ROOT, STAGE));
  step("分发物：zip（解压即用）+ NSIS 安装器（若工具链可用）。");
}

main().catch((e) => {
  console.error("❌ 构建失败：", e?.message ?? e);
  process.exit(1);
});
