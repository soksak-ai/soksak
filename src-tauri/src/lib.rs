mod browser;
mod fs;
mod git;
pub mod ipc;
mod plugins;
mod pty;
#[cfg(target_os = "macos")]
mod titlebar;
mod watcher;
mod window;

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

// 네이티브 창 배경 = 테마 bg 단일화(레이어 원칙, browser.rs 머리말 참조): 루트
// DOM 배경은 투명이고 창 배경이 그 아래를 칠한다 — 미도장 영역(홀 정렬 순간 등)
// 의 색이 테마와 항상 일치한다. 테마 엔진(theme/engine.ts)이 적용 시점마다 호출.
#[tauri::command]
fn window_set_background(window: tauri::Window, color: String) -> Result<(), String> {
    let hex = color.trim().trim_start_matches('#');
    if hex.len() != 6 {
        return Err(format!("hex 색상(#rrggbb)이 아님: {color}"));
    }
    let parse = |s: &str| u8::from_str_radix(s, 16).map_err(|e| e.to_string());
    let (r, g, b) = (parse(&hex[0..2])?, parse(&hex[2..4])?, parse(&hex[4..6])?);
    window
        .set_background_color(Some(tauri::window::Color(r, g, b, 255)))
        .map_err(|e| e.to_string())
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
        .plugin(tauri_plugin_webview_capture::init())
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
                // main 창 네이티브(레이어 역전·신호등) — 새 창과 동일한 단일 진입점(window.rs).
                window::install_window_natives(app.handle(), "main");
                // 앱 전역 모니터(클릭·라이브리사이즈) — 창 무관 1회 설치. 모든 창을 추적하고 어느
                // 창인지 label 을 동반 emit 한다(MW4 — browser.rs 머리말). 프론트가 자기 창만 필터.
                browser::install_click_monitor(app.handle());
                browser::install_live_resize_monitor(app.handle());
            }
            Ok(())
        })
        // 창 포커스(NSWindow key 등) 변화를 프론트로 emit({label, focused}). 다른 앱으로 전환하면
        // false, 같은 창 안 child webview(내장 브라우저)로 포커스가 가도 창 레벨이라 불변. 부차
        // 애니메이션 게이팅 신호이자, 멀티 윈도우 활성 창 추적(소켓 라우팅 기본 타겟) 소스.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(focused) = event {
                use tauri::{Emitter, Manager};
                let label = window.label();
                if *focused {
                    ipc::note_focus(label); // 활성 창 갱신(Rust 가 추적)
                }
                // 그 창에만 emit_to — 프론트 필터 불필요(자기 창 신호만 도착). 활성 창 추적은
                // Rust(note_focus)가 담당하므로 프론트는 단순히 focused 만 받는다.
                let _ = window.app_handle().emit_to(label, "window-focus", *focused);
            }
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
            fs::validate_project_root,
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
            browser::browser_overlay_active,
            browser::browser_debug_hierarchy,
            window_set_background,
            window::window_create,
            window::window_list,
            window::window_focus,
            window::window_close,
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
