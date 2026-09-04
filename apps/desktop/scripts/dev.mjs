/**
 * 桌面 supervisor（M0.2：在 M0.1 原型上补齐生命周期管理）。
 *
 * 职责（对应设计文档 §3.1）：
 * - 单实例：instance.lock（记录 supervisor+子进程 pid；pid 存活校验，
 *   上次强杀的残留子进程在接管时清理）
 * - 崩溃自动重启：指数退避 1/2/4/8/16s；5 分钟窗口内超 5 次停服退出
 * - 日志按日滚动：logs/<name>-YYYYMMDD.log，保留 14 天
 * - 健康探测：meili /health、web /api/health（重启后复探）
 * - 优雅退出：Ctrl+C 后按 workers → web → meili 逐个树杀并等待退出
 *
 * 用法：node apps/desktop/scripts/dev.mjs
 * 数据：F:\...\.desktop-m01\（已 gitignore，删除即重置）
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
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const WS = path.join(ROOT, ".desktop-m01");
const LOGS = path.join(WS, "logs");
const LOCK_PATH = path.join(WS, "instance.lock");
const IS_WIN = process.platform === "win32";

const MEILI_VERSION = "v1.41.0"; // 与 docker/docker-compose.yml 对齐
const MEILI_URL = `https://github.com/meilisearch/meilisearch/releases/download/${MEILI_VERSION}/meilisearch-windows-amd64.exe`;

const RESTART_BACKOFF_SEC = [1, 2, 4, 8, 16];
const CRASH_WINDOW_MS = 5 * 60_000;
const CRASH_LIMIT = 5;
const LOG_RETENTION_DAYS = 14;

// ─── 日志（supervisor + 子进程统一按日滚动） ────────────

function today() {
  return new Date().toISOString().slice(0, 10).replaceAll("-", "");
}

const logStreams = new Map(); // name → { stream, day }

function writeLog(name, line) {
  const day = today();
  let s = logStreams.get(name);
  if (!s || s.day !== day) {
    s?.stream.end();
    s = {
      day,
      stream: createWriteStream(path.join(LOGS, `${name}-${day}.log`), {
        flags: "a",
      }),
    };
    logStreams.set(name, s);
  }
  s.stream.write(line + "\n");
}

const log = (msg) => {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(`[desktop] ${line}`);
  writeLog("supervisor", line);
};

/** 启动时按文件名日期清理过期日志 */
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

// ─── 小工具 ──────────────────────────────────────────────

// 不指定 host（与 next dev 一致绑 ::/双栈），能探测到 Docker 发布的 0.0.0.0 端口
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
    srv.once("error", () =>
      resolve(preferred + 1 + Math.floor(Math.random() * 100)),
    );
    srv.listen(preferred, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`下载失败 ${res.status}: ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  log(
    `已下载 ${path.basename(dest)} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`,
  );
}

function waitHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return resolve();
      } catch {
        // 未就绪，继续轮询
      }
      if (Date.now() > deadline) {
        return reject(new Error(`等待 ${url} 超时（${timeoutMs / 1000}s）`));
      }
      setTimeout(tick, 1000);
    };
    tick();
  });
}

function treeKill(pid) {
  if (!pid) return;
  if (IS_WIN) {
    exec(`taskkill /PID ${pid} /T /F`, () => {});
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // 已退出
    }
  }
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // 存在但无权限
  }
}

// ─── 单实例锁 ────────────────────────────────────────────

/** 把 supervisor 与子进程 pid 落盘，供下次启动做残留清理 */
function writeLock() {
  const cs = {};
  for (const [name, proc] of children) cs[name] = proc.pid;
  writeFileSync(
    LOCK_PATH,
    JSON.stringify({ pid: process.pid, children: cs }, null, 2),
  );
}

/**
 * 获取单实例锁。已有实例存活 → false（调用方仅重开浏览器后退出）；
 * 上次强杀残留 → 清理其子进程后接管。
 */
async function acquireLock() {
  if (existsSync(LOCK_PATH)) {
    let lock = null;
    try {
      lock = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
    } catch {
      // 损坏的锁文件视为残留
    }
    if (lock && isPidAlive(lock.pid)) {
      log(`已有实例在运行（pid=${lock.pid}），本次启动仅重新打开浏览器后退出`);
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
    if (cleaned) {
      // 给树杀一点时间释放端口
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  writeLock();
  return true;
}

// ─── 子进程管理（崩溃自动重启） ─────────────────────────

const children = new Map(); // name → ChildProcess
const restartTimes = new Map(); // name → 崩溃时刻数组（滑动窗口）
let stopping = false;
let defs; // name → { cmd, args, env, probe?, probeTimeoutMs? }（main 中构建）

/**
 * 解析包内文件的真实路径。require.resolve 受 package.json exports 限制，
 * 失败时退回 node_modules 直接拼路径（node 直接执行文件不受 exports 约束）。
 */
function pkgFile(pkg, file, fromDir) {
  try {
    return require.resolve(`${pkg}/${file}`, { paths: [fromDir] });
  } catch {
    return path.join(fromDir, "node_modules", pkg, file);
  }
}

const APPS_WEB = path.join(ROOT, "apps", "web");
const APPS_WORKERS = path.join(ROOT, "apps", "workers");
const PACKAGES_DB = path.join(ROOT, "packages", "db");

function spawnLogged(name, cmd, args, env, cwd = ROOT) {
  const proc = spawn(cmd, args, {
    cwd,
    env,
    // 不用 shell：子进程即真实业务进程，instance.lock 记录的 pid 才能用于
    // 强杀残留后的接管清理（shell:true 时记录的是 cmd.exe 包装层 pid）
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
    stream.on("end", () => {
      if (buf) writeLog(name, buf);
    });
  };
  pipe(proc.stdout);
  pipe(proc.stderr);
  return proc;
}

function waitExit(proc, timeoutMs) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode) return resolve();
    const t = setTimeout(resolve, timeoutMs);
    proc.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
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
  const times = (restartTimes.get(name) ?? []).filter(
    (t) => now - t < CRASH_WINDOW_MS,
  );
  times.push(now);
  restartTimes.set(name, times);
  if (times.length > CRASH_LIMIT) {
    log(
      `${name} 在 ${CRASH_WINDOW_MS / 60_000} 分钟内崩溃 ${times.length} 次（上限 ${CRASH_LIMIT}），停止服务`,
    );
    shutdown(1);
    return;
  }
  const delaySec =
    RESTART_BACKOFF_SEC[
      Math.min(times.length - 1, RESTART_BACKOFF_SEC.length - 1)
    ];
  log(
    `${name} 异常退出（code=${code} signal=${signal}），${delaySec}s 后自动重启（窗口内第 ${times.length}/${CRASH_LIMIT} 次）`,
  );
  setTimeout(() => {
    if (stopping || children.has(name)) return;
    startChild(name);
    probeAfterRestart(name);
  }, delaySec * 1000);
}

/** 重启后健康复探：失败仅记日志（进程已拉起，不再杀掉避免重启循环） */
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

// ─── 优雅退出：workers → web → meili，逐个树杀并等待 ──

async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  log("正在停止全部子进程 ...");
  for (const name of ["workers", "web", "meili"]) {
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

// ─── 主流程 ──────────────────────────────────────────────

async function main() {
  mkdirSync(path.join(WS, "data"), { recursive: true });
  mkdirSync(path.join(WS, "meili-data"), { recursive: true });
  mkdirSync(LOGS, { recursive: true });
  mkdirSync(path.join(WS, "bin"), { recursive: true });
  cleanOldLogs();

  // 配置（首启生成；复用时复查端口并回写）
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
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    log(`生成新配置：web=:${config.webPort} meili=:${config.meiliPort}`);
  }
  // 单实例：已运行 → 重开浏览器退出（在端口复查之前，避免把运行中
  // 实例自己占用的端口误判为"被占"而改写配置）
  if (!(await acquireLock())) {
    exec(`start "" http://127.0.0.1:${config.webPort}`, { shell: "cmd.exe" });
    process.exit(0);
  }

  // web 端口被占（如 Docker 发布了 3000）则换端口并回写
  if (!(await isPortFree(config.webPort))) {
    const old = config.webPort;
    config.webPort = await findFreePort(old + 1);
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    log(
      `端口 ${old} 被占用，web 改用 :${config.webPort}（已回写 config.json）`,
    );
  }

  // meilisearch 二进制（缺失则下载，本地即 M0.3 的二进制缓存雏形）
  const meiliExe = path.join(WS, "bin", "meilisearch.exe");
  if (!existsSync(meiliExe)) {
    log(`下载 meilisearch ${MEILI_VERSION} ...`);
    await download(MEILI_URL, meiliExe);
  }

  // 子进程公共 env：覆盖 .env / .env.local 中的 docker 地址
  const baseEnv = {
    ...process.env,
    DATA_DIR: path.join(WS, "data"),
    MEILI_ADDR: `http://127.0.0.1:${config.meiliPort}`,
    MEILI_MASTER_KEY: config.meiliMasterKey,
    NEXTAUTH_SECRET: config.nextauthSecret,
    NEXTAUTH_URL: `http://127.0.0.1:${config.webPort}`,
    NEXTAUTH_URL_INTERNAL: `http://127.0.0.1:${config.webPort}`,
    API_URL: `http://127.0.0.1:${config.webPort}`,
    // 走真实登录页（微信扫码/邮箱密码）；如需免登录可在 config.json 的
    // userEnv 里设 SAIYE_LOCAL_MODE=true 恢复本地旁路
    DISABLE_NEW_RELEASE_CHECK: "true",
    NEXT_TELEMETRY_DISABLED: "1",
    // 显式置空 → 无浏览器抓取降级（覆盖 .env 里的 chrome:9222）
    BROWSER_WEB_URL: "",
    BROWSER_WEBSOCKET_URL: "",
    // 过滤列表从 GitHub 下载，国内网络会挂起并阻塞 crawler 启动
    CRAWLER_ENABLE_ADBLOCKER: "false",
  };

  defs = {
    meili: {
      cmd: meiliExe,
      args: [
        "--http-addr",
        `127.0.0.1:${config.meiliPort}`,
        "--db-path",
        path.join(WS, "meili-data"),
        "--master-key",
        config.meiliMasterKey,
        "--no-analytics",
        "--env",
        "production",
      ],
      env: baseEnv,
      probe: `http://127.0.0.1:${config.meiliPort}/health`,
      probeTimeoutMs: 30_000,
    },
    web: {
      // 等价 `pnpm --filter @saiye/web run dev`（= next dev），
      // 直接 spawn 真实进程而非 pnpm.cmd，pid 即 next 进程本身
      cmd: process.execPath,
      args: [pkgFile("next", "dist/bin/next", APPS_WEB), "dev"],
      cwd: APPS_WEB,
      env: { ...baseEnv, PORT: String(config.webPort) },
      probe: `http://127.0.0.1:${config.webPort}/api/health`,
      probeTimeoutMs: 240_000,
    },
    workers: {
      // 等价 `pnpm --filter @saiye/workers run start:prod`（= tsx index.ts），
      // cwd 必须是 apps/workers（tsconfig 路径别名依赖）
      cmd: process.execPath,
      args: [pkgFile("tsx", "cli", APPS_WORKERS), "index.ts"],
      cwd: APPS_WORKERS,
      env: baseEnv,
    },
  };

  // 1. 数据库迁移（幂等；等价 `pnpm --filter @saiye/db run migrate`）
  log("运行数据库迁移 ...");
  await runAndWait(
    "migrate",
    process.execPath,
    [pkgFile("tsx", "cli", PACKAGES_DB), "migrate.ts"],
    baseEnv,
    PACKAGES_DB,
  );

  // 2. meilisearch → 探活（web 启动时要连 meili 建索引）
  startChild("meili");
  await waitHealth(defs.meili.probe, defs.meili.probeTimeoutMs);
  log("meili 已就绪");

  // 3. web（dev 模式，首屏编译较慢）
  startChild("web");
  log("等待 web 就绪（dev 模式首编译约 10-60s）...");
  await waitHealth(defs.web.probe, defs.web.probeTimeoutMs);
  log("web 已就绪");

  // 4. workers
  startChild("workers");

  // 5. 打开系统浏览器
  exec(`start "" http://127.0.0.1:${config.webPort}`, { shell: "cmd.exe" });
  log(
    `已在浏览器打开 http://127.0.0.1:${config.webPort}（Ctrl+C 停止全部进程）`,
  );
}

main().catch(async (err) => {
  log(`启动失败：${err?.message ?? err}`);
  await shutdown(1);
});
