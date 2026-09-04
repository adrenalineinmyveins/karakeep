// 桌面产品任何构建都不该弹控制台（诊断走文件日志/重定向，见 supervisor.rs）
#![windows_subsystem = "windows"]

mod supervisor;

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Manager,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            // 全局快捷键：Alt+Shift+K 显示/隐藏主窗口
            app.global_shortcut().on_shortcut("alt+shift+k", |app, _s, event| {
                if event.state() == ShortcutState::Pressed {
                    toggle_main(app);
                }
            })?;

            setup_tray(app)?;
            supervisor::start(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭窗口 = 隐藏到托盘（服务继续运行）；托盘"退出"才真正退出
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running saiye desktop");
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开 Saiye", true, None::<&str>)?;
    let data_dir = MenuItem::with_id(app, "data", "打开数据目录", true, None::<&str>)?;
    let logs_dir = MenuItem::with_id(app, "logs", "打开日志目录", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "开机自动启动",
        true,
        autostart_on,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &data_dir, &logs_dir, &sep, &autostart, &quit])?;

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("Saiye")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => focus_main(app),
            "data" => open_explorer("data"),
            "logs" => open_explorer("logs"),
            "autostart" => {
                let mgr = app.autolaunch();
                let result = if mgr.is_enabled().unwrap_or(false) {
                    mgr.disable()
                } else {
                    mgr.enable()
                };
                if let Err(e) = result {
                    eprintln!("[desktop] autostart toggle failed: {e}");
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn focus_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn toggle_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }
}

fn open_explorer(sub: &str) {
    let dir = appdata_sub_dir(sub);
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::process::Command::new("explorer").arg(dir).spawn();
}

fn appdata_sub_dir(sub: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var("APPDATA").unwrap_or_default())
        .join("saiye-desktop")
        .join(sub)
}
