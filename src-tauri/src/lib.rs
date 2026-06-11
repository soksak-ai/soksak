mod browser;
mod fs;
pub mod ipc;
mod pty;
mod watcher;

use ipc::CmdBridge;
use pty::PtyManager;
use tauri::Manager;
use watcher::FsWatcher;

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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::spawn_terminal,
            pty::write_terminal,
            pty::resize_terminal,
            pty::ack_terminal,
            pty::close_terminal,
            fs::list_children,
            fs::read_text_file,
            fs::write_text_file,
            fs::read_file_base64,
            fs::git_status,
            fs::themes_scan,
            fs::theme_install,
            watcher::watch_dir,
            watcher::unwatch_dir,
            browser::browser_open,
            browser::browser_bounds,
            browser::browser_navigate,
            browser::browser_history,
            browser::browser_visible,
            browser::browser_close,
            browser::browser_open_window,
            browser::browser_eval,
            ipc::cmd_result,
            ime_debug,
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
