// supervisor 桥：拉起 node run.mjs（已验证的 Phase 0 supervisor），探活后把主窗口导航到 web
use serde::Deserialize;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::time::{Duration, Instant};
use std::os::windows::process::CommandExt;
use tauri::{AppHandle, Manager};

#[derive(Deserialize)]
struct UserConfig {
    #[serde(rename = "webPort", default)]
    web_port: Option<u16>,
}

fn app_data_dir() -> PathBuf {
    PathBuf::from(std::env::var("APPDATA").unwrap_or_default()).join("karakeep-desktop")
}

/// 去掉 Windows verbatim 前缀（\\?\）：CreateProcessW 接受它，但 node 的模块路径解析
/// 会把 `\\?\F:\...` 错误折叠成盘符（EISDIR: lstat 'F:'），传给 node 前必须规范化
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.as_os_str().to_string_lossy().to_string();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p
    }
}

/// 解析 node.exe 与 run.mjs 的位置：
/// 1. KARAKEEP_DESKTOP_DEV=<apps/desktop 路径>（开发模式：系统 node + 仓库 scripts/run.mjs）
/// 2. 安装模式：resource_dir 下 node/node.exe + runtime/supervisor/run.mjs（NSIS 布局）
///    首次运行时从 payload.tar.gz 解压（NSIS 只打包单档案避免 86k 文件脚本卡死）
fn resolve_layout(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    if let Ok(dev) = std::env::var("KARAKEEP_DESKTOP_DEV") {
        let run = PathBuf::from(&dev).join("scripts").join("run.mjs");
        if run.exists() {
            let node = std::env::var("KARAKEEP_DESKTOP_DEV_NODE")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from("node"));
            return Ok((node, run));
        }
        return Err(format!("KARAKEEP_DESKTOP_DEV 已设置但找不到 {}", run.display()));
    }
    let res = strip_verbatim(
        app.path()
            .resource_dir()
            .map_err(|e| format!("resource_dir 解析失败: {e}"))?,
    );
    let node = res.join("node").join("node.exe");
    let run = res.join("runtime").join("supervisor").join("run.mjs");

    // 已解压过 → 直接用
    if node.exists() && run.exists() {
        return Ok((node, run));
    }

    // 首次运行：从 payload.tar.gz 解压
    let payload = res.join("payload.tar.gz");
    if payload.exists() {
        eprintln!("[desktop] 首次运行，正在解压 payload.tar.gz ...");
        let status = Command::new("tar")
            .args(["xzf", &payload.to_string_lossy()])
            .current_dir(&res)
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .status()
            .map_err(|e| format!("tar 启动失败: {e}"))?;
        if !status.success() {
            return Err(format!("payload 解压失败（tar exit={}）", status.code().unwrap_or(-1)));
        }
        eprintln!("[desktop] payload 解压完成");
        if node.exists() && run.exists() {
            return Ok((node, run));
        }
    }

    Err(format!(
        "安装目录不完整：node={} run={} payload={}",
        node.display(),
        run.display(),
        payload.display()
    ))
}

/// TCP 层手写 HTTP/1.1 GET，避免引入 HTTP 客户端依赖
fn http_ok(port: u16, path: &str) -> bool {
    let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 128];
    match s.read(&mut buf) {
        Ok(n) => {
            let head = String::from_utf8_lossy(&buf[..n]);
            head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
        }
        Err(_) => false,
    }
}

fn open_main(app: &AppHandle, port: u16) {
    if let Some(w) = app.get_webview_window("main") {
        let url = format!("http://127.0.0.1:{port}");
        match url.parse::<tauri::Url>() {
            Ok(u) => {
                let _ = w.navigate(u);
            }
            Err(_) => {
                let _ = w.eval(&format!("location.replace('{url}')"));
            }
        }
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn show_error(app: &AppHandle, msg: &str) {
    eprintln!("[desktop] {msg}");
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
        let text = serde_json::to_string(msg).unwrap_or_else(|_| "\"启动失败\"".into());
        let _ = w.eval(&format!(
            "document.getElementById('status').textContent = {text}; document.querySelector('.spinner').style.display='none';"
        ));
    }
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        if let Err(e) = run(&app) {
            show_error(&app, &e);
        }
    });
}

fn run(app: &AppHandle) -> Result<(), String> {
    let (node, script) = resolve_layout(app)?;
    eprintln!("[desktop] spawning node={} arg={}", node.display(), script.display());
    let mut child = Command::new(&node)
        .arg(&script)
        .env("KARAKEEP_DESKTOP_SHELL", "1")
        // CREATE_NO_WINDOW：GUI 壳无控制台，防止 node 弹新控制台窗口；不影响 std 句柄继承（诊断输出仍进重定向）
        .creation_flags(0x0800_0000)
        // run.mjs 自写文件日志；stdout/stderr 继承（debug 诊断用，release 壳无控制台等效 null）
        .spawn()
        .map_err(|e| format!("supervisor 启动失败: {e}（node: {}）", node.display()))?;

    let web_port = wait_for_port(&mut child)?;
    wait_for_health(&mut child, web_port)?;
    open_main(app, web_port);

    // supervisor 常驻监控：自身退出（熔断/致命错误）时在窗口提示；其子进程自愈由 run.mjs 负责
    monitor(child);
    Ok(())
}

fn wait_for_port(child: &mut Child) -> Result<u16, String> {
    let config = app_data_dir().join("config.json");
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        if let Ok(txt) = fs::read_to_string(&config) {
            if let Ok(c) = serde_json::from_str::<UserConfig>(&txt) {
                if let Some(p) = c.web_port {
                    return Ok(p);
                }
            }
        }
        if Instant::now() > deadline {
            return Err("等待 config.json 生成超时（90s），请查看日志目录".into());
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("supervisor 提前退出（code={}）", status.code().unwrap_or(-1)));
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

fn wait_for_health(child: &mut Child, port: u16) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        if http_ok(port, "/api/health") {
            return Ok(());
        }
        if Instant::now() > deadline {
            return Err(format!("web 探活超时 http://127.0.0.1:{port}/api/health"));
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("supervisor 提前退出（code={}）", status.code().unwrap_or(-1)));
        }
        std::thread::sleep(Duration::from_millis(600));
    }
}

fn monitor(child: Child) {
    let mut child = child;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                // supervisor 终止：不再重启（run.mjs 内部已做子进程自愈，它自身退出=熔断）
                return;
            }
            Ok(None) => {}
            Err(_) => return,
        }
        std::thread::sleep(Duration::from_secs(3));
    }
}
