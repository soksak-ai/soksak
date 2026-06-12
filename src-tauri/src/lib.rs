mod browser;
mod fs;
mod git;
pub mod ipc;
mod plugins;
mod pty;
#[cfg(target_os = "macos")]
mod titlebar;
mod watcher;

use ipc::CmdBridge;
use pty::PtyManager;
use tauri::Manager;
use watcher::FsWatcher;

// 앱 자기 활성화: JS setFocus 는 창을 key 로 만들 뿐 앱을 전면으로 못 가져온다
// (macOS 포커스 탈취 방지). 자기 자신의 활성화는 허용되므로 NSApp 으로 수행.
#[tauri::command]
fn window_activate(window: tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        let _ = window.run_on_main_thread(|| {
            use objc2::MainThreadMarker;
            use objc2_app_kit::NSApplication;
            if let Some(mtm) = MainThreadMarker::new() {
                #[allow(deprecated)]
                NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}

// IME 진단: dev(debug) 빌드에서만 로깅. 릴리즈 빌드에서는 no-op.
#[tauri::command]
fn ime_debug(message: String) {
    #[cfg(debug_assertions)]
    eprintln!("[IME] {message}");
    #[cfg(not(debug_assertions))]
    let _ = message;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(PtyManager::default())
        .manage(FsWatcher::default())
        .manage(CmdBridge::default())
        .setup(|app| {
            // 파일 워처 1회 초기화(이벤트 콜백에 앱 핸들 주입).
            let handle = app.handle().clone();
            app.state::<FsWatcher>().init(handle);
            // AI 명령 인터페이스 소켓 서버(sok CLI/MCP 의 통로).
            if let Err(e) = ipc::start(app.handle().clone()) {
                eprintln!("[ipc] 소켓 서버 기동 실패: {e}");
            }
            // 신호등: 좌표는 tauri.conf.json trafficLightPosition 이 소유, 유지는
            // titlebar::install 의 NSNotification 옵저버가 담당(titlebar.rs 참조).
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                if let (Some(window), Some(pos)) = (
                    app.get_window("main"),
                    app.config()
                        .app
                        .windows
                        .first()
                        .and_then(|w| w.traffic_light_position.as_ref()),
                ) {
                    titlebar::install(&window, pos.x, pos.y);
                }
                // 네이티브 webview 클릭의 포커스 추적(browser.rs 참조).
                browser::install_click_monitor(app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::spawn_terminal,
            pty::write_terminal,
            pty::resize_terminal,
            pty::ack_terminal,
            pty::close_terminal,
            pty::shell_which,
            fs::list_children,
            fs::read_text_file,
            fs::write_text_file,
            fs::read_file_base64,
            fs::git_status,
            fs::themes_scan,
            fs::theme_install,
            fs::ensure_workspace_dir,
            plugins::plugins_scan,
            plugins::plugin_install_git,
            plugins::plugin_update,
            plugins::plugin_remove,
            plugins::plugin_data_read,
            plugins::plugin_data_write,
            plugins::plugin_data_list,
            git::git_log,
            git::git_init_if_missing,
            git::git_show,
            git::git_diff,
            watcher::watch_dir,
            watcher::unwatch_dir,
            browser::browser_open,
            browser::browser_bounds,
            browser::browser_navigate,
            browser::browser_history,
            browser::browser_visible,
            browser::browser_close,
            browser::browser_list,
            browser::browser_open_window,
            browser::browser_eval,
            ipc::cmd_result,
            titlebar::titlebar_backing,
            ime_debug,
            window_activate,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 종료 요청 시 모든 PTY 자식 프로세스 정리(좀비 방지) + 제어 소켓 정리.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                app_handle.state::<PtyManager>().kill_all();
                ipc::cleanup();
            }
        });
}
