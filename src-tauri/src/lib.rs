mod pty;

use pty::PtyManager;

// DEV 진단: IME 이벤트/PTY 전송을 dev 로그로 보낸다.
#[tauri::command]
fn ime_debug(message: String) {
    eprintln!("[IME] {message}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyManager::default())
        .invoke_handler(tauri::generate_handler![
            pty::spawn_terminal,
            pty::write_terminal,
            pty::resize_terminal,
            pty::ack_terminal,
            pty::close_terminal,
            ime_debug,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
