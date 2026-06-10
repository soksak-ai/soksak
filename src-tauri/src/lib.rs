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
        .setup(|app| {
            // 개발 빌드(debug)는 창 제목에 dev 를 붙여 릴리스와 구분(독 아이콘은 dev 설정의
            // 별도 아이콘 세트로 분리). 릴리스는 설정의 "soksak" 제목 유지.
            #[cfg(debug_assertions)]
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_title("soksak dev");
            }
            Ok(())
        })
        .manage(PtyManager::default())
        .invoke_handler(tauri::generate_handler![
            pty::spawn_terminal,
            pty::write_terminal,
            pty::resize_terminal,
            pty::ack_terminal,
            pty::close_terminal,
            fs::list_dir,
            fs::read_text_file,
            fs::read_file_base64,
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
