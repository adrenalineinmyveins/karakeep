/**
 * 桌面版生产 supervisor（与 dev.mjs 生命周期完全同构，仅替换路径/启动入口）。
 *
 * 对应：
 * - 设计 §2.1 进程拓扑：node migrate.cjs → meili → web server.js → workers index.js
 * - 设计 §2.2 用户数据目录：%APPDATA%\karakeep-desktop\（升级不丢）
 * - 设计 §3.2 环境变量表：全部按此注入
 * - 设计 §3.1 其他：单实例锁、日志滚动、优雅退出、崩溃重启、健康探活
 *
 * 安装目录结构（运行时可通过 __dirname 向上推导 INSTALL_DIR）：
 *   <INSTALL>/runtime/supervisor/run.mjs  （本文件）
 *   <INSTALL>/runtime/migrate/migrate.cjs + drizzle/
 *   <INSTALL>/runtime/web/                （standalone: apps/web/server.js + node_modules + public + .next/static）
 *   <INSTALL>/runtime/workers/            （dist/index.mjs + node_modules）
 *   <INSTALL>/bin/                        （meilisearch.exe、ffmpeg、yt-dlp、monolith）
 *   <INSTALL>/node/node.exe               （被 karakeep.cmd 调用，即 process.execPath = 捆绑 node）
 *
 * 通过 karakeep.cmd 启动时：工作目录 = INSTALL_DIR；PATH 前插入 bin\；YTDLP_CONFIG=--js-runtimes node
 */

import { exec, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_DIR = path.resolve(__dirname, "..", ".."); // 安装根：supervisor 上两级
const RUNTIME = path.join(INSTALL_DIR, "runtime");
const BIN_DIR = path.join(INSTALL_DIR, "bin");

// 用户数据目录：设计 §2.2 = %APPDATA%\karakeep-desktop
const APPDATA = process.env.APPDATA ?? process.env.HOME ?? process.env.USERPROFILE;
const WS = path.join(APPDATA, "karakeep-desktop");

const LOGS = path.join(WS, "logs");
const LOCK_PATH = path.join(WS, "instance.lock");
const DATA_DIR = path.join(WS, "data");
const MEILI_DATA = path.join(WS, "meili");
const BROWSER_PROFILE = path.join(WS, "browser", "profile");
const IS_WIN = process.platform === "win32";

// M0.2 已验证：直接 spawn（detached:false、无 shell）加入 Job Object，强杀整树回收
// 本脚本继续保持直接 spawn。

const RESTART_BACKOFF_SEC = [1, 2, 4, 8, 16];
const CRASH_WINDOW_MS = 5 * 60_000;
const CRASH_LIMIT = 5;
const LOG_RETENTION_DAYS = 14;

// ─── 日志（按日滚动，14 天清理） ─────────────────────────

function today() {
  return new Date().toISOString().slice(0, 10).replaceAll("-", "");
}
const logStreams = new Map();
function writeLog(name, line) {
  const day = today();
  let s = logStreams.get(name);
  if (!s || s.day !== day) {
    s?.stream.end();
    s = {
      day,
      stream: createWriteStream(path.join(LOGS, `${name}-${day}.log`), { flags: "a" }),
    };
    logStreams.set(name, s);
  }
  s.stream.write(line + "\n");
}
const log = (msg) => {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  writeLog("supervisor", line);
};
function cleanOldLogs() {
  if (!existsSync(LOGS)) return;
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 86_400_000;
  for (const f of readdirSync(LOGS)) {
    const m = f.match(/^(\w+)-(\d{8})\.log$/);
    if (!m) continue;
    const d = new Date(
      Number(m[2].slice(0, 4)),
      Number(m[2].slice(4, 6)) - 1,
      Number(m[2].slice(6, 8)),
    );
    if (d.getTime() < cutoff) {
      rmSync(path.join(LOGS, f), { force: true });
      log(`清理过期日志 ${f}`);
    }
  }
}

// ─── 工具函数 ──────────────────────────────────────────────

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, () => srv.close(() => resolve(true)));
  });
}
function findFreePort(preferred) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(preferred + 1 + Math.floor(Math.random() * 100)));
    srv.listen(preferred, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
function waitHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return resolve();
      } catch {
        // 未就绪
      }
      if (Date.now() > deadline) return reject(new Error(`等待 ${url} 超时（${timeoutMs / 1000}s）`));
      setTimeout(tick, 1000);
    };
    tick();
  });
}
function treeKill(pid) {
  if (!pid) return;
  if (IS_WIN) exec(`taskkill /PID ${pid} /T /F`, () => {});
  else {
    try { process.kill(pid, "SIGTERM"); } catch {
      // 已退出
    }
  }
}
function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) {
    return err.code === "EPERM";
  }
}

// ─── 单实例锁 ──────────────────────────────────────────────

const children = new Map();
function writeLock() {
  const cs = {};
  for (const [name, proc] of children) cs[name] = proc.pid;
  writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, children: cs }, null, 2));
}
// 以桌面窗口打开（Edge --app 模式 = WebView2 独立窗口：无地址栏/独立任务栏项）；
// Edge 缺失时退回默认浏览器。关窗口不停止服务，再点 karakeep.cmd 走单实例重开。
// Tauri 壳模式（KARAKEEP_DESKTOP_SHELL=1）下不开窗口，主窗口由壳管理
function openWindow(url) {
  if (process.env.KARAKEEP_DESKTOP_SHELL === "1") return;
  const edge = edgeExe();
  if (edge) {
    exec(`start "" "${edge}" --app=${url}`, { shell: "cmd.exe" });
  } else {
    exec(`start "" ${url}`, { shell: "cmd.exe" });
  }
}

// ─── 爬取引擎（P1-7 可选包） ──────────────────────────────

// 系统自带 Edge（Chromium 内核）：窗口兜底 + 爬取浏览器优先复用（零下载）
const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const edgeExe = () => EDGE_PATHS.find((p) => existsSync(p)) ?? null;

// playwright install chromium 的落盘位置（%LOCALAPPDATA%\ms-playwright）
function findPlaywrightChromium() {
  const local =
    process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? "", "AppData", "Local");
  const root = path.join(local, "ms-playwright");
  if (!existsSync(root)) return null;
  for (const d of readdirSync(root)) {
    if (!d.startsWith("chromium")) continue;
    for (const sub of ["chrome-win", "chrome-win64"]) {
      const exe = path.join(root, d, sub, "chrome.exe");
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

// 按需下载 Chromium：复用 workers 自带的 playwright 安装器（npmmirror 镜像，国内网络可达）
// 返回 chrome.exe 路径；失败返回 null（降级为无浏览器抓取，不阻断启动）
async function downloadChromium() {
  const cli = path.join(RUNTIME, "workers", "node_modules", "playwright", "cli.js");
  if (!existsSync(cli)) {
    log(`[crawler] playwright cli 缺失（${cli}），无法自动下载`);
    return null;
  }
  log("[crawler] 开始下载 Chromium（约 150MB，npmmirror 镜像，仅需一次）...");
  try {
    await runAndWait(
      "browser-setup",
      process.execPath,
      [cli, "install", "chromium"],
      { ...process.env, PLAYWRIGHT_DOWNLOAD_HOST: "https://cdn.npmmirror.com/binaries/playwright" },
      path.dirname(cli),
    );
  } catch (e) {
    log(`[crawler] Chromium 下载失败：${e?.message ?? e}，本次降级为无浏览器抓取`);
    return null;
  }
  const exe = findPlaywrightChromium();
  if (!exe) log("[crawler] 下载完成后仍未找到 chrome.exe，降级为无浏览器抓取");
  return exe;
}

async function acquireLock() {
  if (existsSync(LOCK_PATH)) {
    let lock = null;
    try { lock = JSON.parse(readFileSync(LOCK_PATH, "utf8")); } catch {
      // 损坏的锁当残留
    }
    if (lock && isPidAlive(lock.pid)) {
      log(`已有实例在运行（pid=${lock.pid}），本次仅重开浏览器后退出`);
      return false;
    }
    let cleaned = false;
    for (const [name, pid] of Object.entries(lock?.children ?? {})) {
      if (isPidAlive(pid)) {
        log(`清理上次残留的 ${name} 进程（pid=${pid}）`);
        treeKill(pid);
        cleaned = true;
      }
    }
    if (cleaned) await new Promise((r) => setTimeout(r, 1500));
  }
  writeLock();
  return true;
}

// ─── 子进程管理（与 dev.mjs 同构） ────────────────────────

const restartTimes = new Map();
let stopping = false;
let defs;

function spawnLogged(name, cmd, args, env, cwd = INSTALL_DIR) {
  const proc = spawn(cmd, args, {
    cwd,
    env,
    // 壳（GUI 无控制台）模式下防止子进程弹出控制台窗口
    windowsHide: true,
    // 直接 spawn（Job Object + instance.lock pid 可用于接管清理）
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pipe = (stream) => {
    stream.setEncoding("utf8");
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        console.log(`[${name}] ${line}`);
        writeLog(name, line);
      }
    });
    stream.on("end", () => { if (buf) writeLog(name, buf); });
  };
  pipe(proc.stdout);
  pipe(proc.stderr);
  return proc;
}
function waitExit(proc, timeoutMs) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode) return resolve();
    const t = setTimeout(resolve, timeoutMs);
    proc.once("exit", () => { clearTimeout(t); resolve(); });
  });
}
function startChild(name) {
  const def = defs[name];
  const proc = spawnLogged(name, def.cmd, def.args, def.env, def.cwd);
  children.set(name, proc);
  writeLock();
  log(`已启动 ${name}（pid=${proc.pid}）`);
  proc.on("exit", (code, signal) => {
    children.delete(name);
    writeLock();
    if (stopping) return;
    onChildCrash(name, code, signal);
  });
  return proc;
}
function onChildCrash(name, code, signal) {
  const now = Date.now();
  const times = (restartTimes.get(name) ?? []).filter((t) => now - t < CRASH_WINDOW_MS);
  times.push(now);
  restartTimes.set(name, times);
  if (times.length > CRASH_LIMIT) {
    log(`${name} ${CRASH_WINDOW_MS / 60_000} 分钟内崩溃 ${times.length} 次（上限 ${CRASH_LIMIT}），停止服务`);
    shutdown(1);
    return;
  }
  const delaySec = RESTART_BACKOFF_SEC[Math.min(times.length - 1, RESTART_BACKOFF_SEC.length - 1)];
  log(`${name} 异常退出（code=${code} signal=${signal}），${delaySec}s 后自动重启（窗口内第 ${times.length}/${CRASH_LIMIT} 次）`);
  setTimeout(() => {
    if (stopping || children.has(name)) return;
    startChild(name);
    probeAfterRestart(name);
  }, delaySec * 1000);
}
function probeAfterRestart(name) {
  const def = defs[name];
  if (!def.probe) return;
  waitHealth(def.probe, def.probeTimeoutMs ?? 60_000)
    .then(() => log(`${name} 重启后健康检查通过`))
    .catch(() => log(`${name} 重启后健康检查超时，请查看 logs/${name}-*.log`));
}
function runAndWait(label, cmd, args, env, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawnLogged(label, cmd, args, env, cwd);
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} 退出码 ${code}`));
    });
  });
}

// ─── 优雅退出：workers → web → browser → meili ────────────

async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  log("正在停止全部子进程 ...");
  for (const name of ["workers", "web", "browser", "meili"]) {
    const proc = children.get(name);
    if (!proc) continue;
    treeKill(proc.pid);
    await waitExit(proc, 5000);
  }
  log("已全部停止");
  process.exit(exitCode);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// ─── 主流程（对应设计 §3.3 首启流程） ──────────────────────

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(MEILI_DATA, { recursive: true });
  mkdirSync(LOGS, { recursive: true });
  cleanOldLogs();

  log(`安装目录：${INSTALL_DIR}`);
  log(`用户数据目录：${WS}`);

  // 配置
  const configPath = path.join(WS, "config.json");
  let config;
  if (existsSync(configPath)) {
    config = JSON.parse(readFileSync(configPath, "utf8"));
    log(`复用已有配置：web=:${config.webPort} meili=:${config.meiliPort}`);
  } else {
    config = {
      webPort: await findFreePort(3000),
      meiliPort: await findFreePort(7700),
      nextauthSecret: randomBytes(32).toString("hex"),
      meiliMasterKey: randomBytes(32).toString("hex"),
      userEnv: {}, // 预留：用户可手动配置 OPENAI_* 等
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    log(`生成新配置：web=:${config.webPort} meili=:${config.meiliPort}（持久化到 ${configPath}）`);
  }

  // 单实例：在端口复查之前（避免把已运行实例自占端口误判）
  if (!(await acquireLock())) {
    openWindow(`http://127.0.0.1:${config.webPort}`);
    process.exit(0);
  }

  if (!(await isPortFree(config.webPort))) {
    const old = config.webPort;
    config.webPort = await findFreePort(old + 1);
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    log(`端口 ${old} 被占用，web 改用 :${config.webPort}（已回写 config.json）`);
  }
  if (!(await isPortFree(config.meiliPort))) {
    const old = config.meiliPort;
    config.meiliPort = await findFreePort(old + 1);
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    log(`端口 ${old} 被占用，meili 改用 :${config.meiliPort}（已回写 config.json）`);
  }

  // 爬取引擎（P1-7）：config.json 加 "crawler": {"enabled": true} 启用（默认关闭）
  // 用户 userEnv 自带 BROWSER_WEB_URL/BROWSER_WEBSOCKET_URL（自建远程浏览器）时不接管
  const userEnv = config.userEnv ?? {};
  const userBrowserUrl =
    userEnv.BROWSER_WEB_URL || userEnv.BROWSER_WEBSOCKET_URL ||
    process.env.BROWSER_WEB_URL || process.env.BROWSER_WEBSOCKET_URL;
  let browserExe = null;
  let browserDebugPort = null;
  if (config.crawler?.enabled === true && !userBrowserUrl) {
    browserDebugPort = config.browserDebugPort ?? 9222;
    if (!(await isPortFree(browserDebugPort))) {
      browserDebugPort = await findFreePort(browserDebugPort + 1);
    }
    if (config.browserDebugPort !== browserDebugPort) {
      config.browserDebugPort = browserDebugPort;
      writeFileSync(configPath, JSON.stringify(config, null, 2));
    }
    // 浏览器来源优先级：系统 Edge（零下载）→ playwright 已装 chromium → 按需下载
    browserExe = edgeExe() ?? findPlaywrightChromium() ?? (await downloadChromium());
    if (browserExe) {
      mkdirSync(BROWSER_PROFILE, { recursive: true });
      log(`爬取引擎已启用：${browserExe}（CDP :${browserDebugPort}）`);
    } else {
      log("爬取引擎启用失败（无可用浏览器），本次降级为无浏览器抓取");
      browserDebugPort = null;
    }
  }

  // meili 二进制校验（缺失明确报错，便于 M0.4 验收）
  const meiliExe = path.join(BIN_DIR, "meilisearch.exe");
  if (!existsSync(meiliExe)) {
    throw new Error(`缺少 bin/meilisearch.exe，请先执行打包脚本（见 build.mjs step5）`);
  }

  // bin 注入 PATH（ffmpeg/yt-dlp 被 workers 直接调用时的查找路径）
  // 与 karakeep.cmd 的 PATH 前缀同逻辑；这里也注入以防 cmd 被绕过直接启动的场景
  const PATH_VAR = IS_WIN ? "Path" : "PATH";
  const PATH = process.env[PATH_VAR] ?? process.env.PATH ?? "";

  // 环境变量：设计 §3.2 表；并把 userEnv（config.json）透传（用于 OPENAI_* 等，声明已上移至爬取决策块）
  const baseEnv = {
    ...process.env,
    [PATH_VAR]: `${BIN_DIR}${IS_WIN ? ";" : ":"}${PATH}`,
    // ── 覆盖用户配置，以下 karakeep 自己保留不允许用户改 ──
    DATA_DIR,
    MEILI_ADDR: `http://127.0.0.1:${config.meiliPort}`,
    MEILI_MASTER_KEY: config.meiliMasterKey,
    NEXTAUTH_SECRET: config.nextauthSecret,
    NEXTAUTH_URL: `http://127.0.0.1:${config.webPort}`,
    NEXTAUTH_URL_INTERNAL: `http://127.0.0.1:${config.webPort}`,
    API_URL: `http://127.0.0.1:${config.webPort}`,
    PORT: String(config.webPort),
    HOSTNAME: "127.0.0.1",
    KARAKEEP_LOCAL_MODE: "true",
    DISABLE_NEW_RELEASE_CHECK: "true",
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: "production",
    // 爬取浏览器（P1-7）：本地 CDP 端点；空 = 无浏览器抓取降级（userEnv 可覆盖为远程浏览器）
    BROWSER_WEB_URL: browserDebugPort ? `http://127.0.0.1:${browserDebugPort}` : "",
    BROWSER_WEBSOCKET_URL: "",
    // 构建期注入的同逻辑：adblock 列表国内网络下载阻塞 crawler
    CRAWLER_ENABLE_ADBLOCKER: "false",
    // ffmpeg / yt-dlp 路径（供 workers 直接调用，不依赖 PATH 也能定位）
    FFMPEG_PATH: path.join(BIN_DIR, "ffmpeg.exe"),
    YTDLP_PATH: path.join(BIN_DIR, "yt-dlp.exe"),
    // 解析 subprocess 时按 monolith 存在性决定是否走归档抓取
    MONOLITH_PATH: existsSync(path.join(BIN_DIR, "monolith.exe"))
      ? path.join(BIN_DIR, "monolith.exe")
      : "",
    // ── 最后合并用户配置（能覆盖上层我们未显式保留的；OPENAI_* 等就是用这个通道） ──
    ...userEnv,
  };

  // 生产 defs（与 dev.mjs 唯一大差异：入口全是 build 产物真实路径）
  const MIGRATE_DIR = path.join(RUNTIME, "migrate");
  const WEB_DIR = path.join(RUNTIME, "web");
  const WORKERS_DIR = path.join(RUNTIME, "workers");

  const webServer = path.join(WEB_DIR, "apps", "web", "server.js");
  if (!existsSync(webServer)) {
    throw new Error(`web standalone 入口缺失：${webServer}`);
  }
  const migrateJs = path.join(MIGRATE_DIR, "migrate.cjs");
  if (!existsSync(migrateJs)) {
    throw new Error(`migrate 入口缺失：${migrateJs}`);
  }
  const workersEntry = path.join(WORKERS_DIR, "dist", "index.js");
  if (!existsSync(workersEntry)) {
    throw new Error(`workers 入口缺失：${workersEntry}`);
  }

  defs = {
    meili: {
      cmd: meiliExe,
      args: [
        "--http-addr", `127.0.0.1:${config.meiliPort}`,
        "--db-path", MEILI_DATA,
        "--master-key", config.meiliMasterKey,
        "--no-analytics",
        "--env", "production",
      ],
      env: baseEnv,
      probe: `http://127.0.0.1:${config.meiliPort}/health`,
      probeTimeoutMs: 30_000,
    },
    web: {
      // standalone 启动入口：node apps/web/server.js（Next 文档）
      // cwd = WEB_DIR（含 node_modules、apps/web/public、apps/web/.next/static）
      cmd: process.execPath,
      args: [webServer],
      cwd: WEB_DIR,
      env: baseEnv,
      probe: `http://127.0.0.1:${config.webPort}/api/health`,
      probeTimeoutMs: 120_000, // 生产首启比 dev 快，2 分钟上限
    },
    workers: {
      cmd: process.execPath,
      args: [workersEntry],
      cwd: WORKERS_DIR, // pnpm deploy 产物目录（含 node_modules + package.json）
      env: baseEnv,
    },
  };

  // 爬取浏览器（可选）：workers 之前拉起，保证其启动时 CDP 端点已就绪
  if (browserExe) {
    defs.browser = {
      cmd: browserExe,
      args: [
        "--headless=new",
        // 值必须用 = 形式：Edge 无头模式会把空格形式的值（如 "9222"）误判为页面目标
        // （报 "Multiple targets are not supported in headless mode"，退出码 13）
        `--remote-debugging-port=${browserDebugPort}`,
        // 独立 user-data-dir：强制新实例（否则会复用用户已开的 Edge，调试端口不生效）
        `--user-data-dir=${BROWSER_PROFILE}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--hide-scrollbars",
        "--remote-allow-origins=*",
      ],
      env: baseEnv,
      probe: `http://127.0.0.1:${browserDebugPort}/json/version`,
      probeTimeoutMs: 30_000,
    };
  }

  // 1. 迁移（幂等，drizzle 只应用 pending）
  log("运行数据库迁移 ...");
  await runAndWait(
    "migrate",
    process.execPath,
    [migrateJs],
    baseEnv,
    MIGRATE_DIR, // drizzle/ 就在此目录下，migrate.ts 内相对路径解析正确
  );

  // 2. meili → 探活
  startChild("meili");
  await waitHealth(defs.meili.probe, defs.meili.probeTimeoutMs);
  log("meili 已就绪");

  // 3. web（standalone 首启编译已完成，仅初始化，快）
  startChild("web");
  log("等待 web 就绪（standalone 启动约 3-15s）...");
  await waitHealth(defs.web.probe, defs.web.probeTimeoutMs);
  log("web 已就绪");

  // 4. 爬取浏览器（可选）：CDP 探活通过后再启动 workers，避免其首次连接失败重试
  if (defs.browser) {
    startChild("browser");
    await waitHealth(defs.browser.probe, defs.browser.probeTimeoutMs);
    log("browser 已就绪");
  }

  // 5. workers
  startChild("workers");

  // 6. 打开桌面窗口（Edge --app）
  openWindow(`http://127.0.0.1:${config.webPort}`);
  log(`已打开桌面窗口 http://127.0.0.1:${config.webPort}（Ctrl+C 停止全部进程）`);
  log(`日志目录：${LOGS}`);
  log(`数据目录：${WS}（升级/卸载保留）`);

  // Tauri 壳模式：壳（父进程）退出后优雅停机，防止服务孤儿
  if (process.env.KARAKEEP_DESKTOP_SHELL === "1" && process.ppid > 1) {
    const shellPid = process.ppid;
    log(`桌面壳模式：跟随父进程 pid=${shellPid}（其退出后自动停服）`);
    setInterval(() => {
      try {
        process.kill(shellPid, 0);
      } catch {
        log(`桌面壳(pid=${shellPid})已退出，开始优雅停机`);
        shutdown(0);
      }
    }, 3000);
  }
}

main().catch(async (err) => {
  log(`启动失败：${err?.message ?? err}`);
  await shutdown(1);
});
