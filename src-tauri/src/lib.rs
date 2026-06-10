mod fs;
mod pty;

use pty::PtyManager;
use tauri::Manager;

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
        .invoke_handler(tauri::generate_handler![
            pty::spawn_terminal,
            pty::write_terminal,
            pty::resize_terminal,
            pty::ack_terminal,
            pty::close_terminal,
            fs::list_children,
            fs::read_text_file,
            fs::read_file_base64,
            fs::git_status,
            ime_debug,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 종료 요청 시 모든 PTY 자식 프로세스를 정리(좀비 방지).
            if let tauri::RunEvent::ExitRequested { .. } = event {
                app_handle.state::<PtyManager>().kill_all();
            }
        });
}
