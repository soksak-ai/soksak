mod ai_session;
mod home;
mod sidecar;
mod webview;
mod clipboard;
mod data;
mod deeplink;
#[cfg(target_os = "macos")]
mod dockmenu;
mod fs;
mod git;
mod http;
pub mod ipc;
mod mediaproxy;
mod network;
mod notify;
mod plugins;
mod process;
mod pty;
mod schedule;
mod secrets;
#[cfg(target_os = "macos")]
mod titlebar;
mod watcher;
mod runtime_dep;
mod activity;
mod project_registry;
mod window;
mod ws;

use ipc::CmdBridge;
use process::ProcessManager;
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

// 네이티브 창 배경 = 테마 bg 단일화(레이어 원칙, webview.rs 머리말 참조): 루트
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
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(activity::ActivityHub::default())
        .manage(PtyManager::default())
        .manage(ProcessManager::default())
        .manage(ws::WsManager::default())
        .manage(FsWatcher::default())
        .manage(clipboard::ClipboardState::default())
        .manage(CmdBridge::default())
        .manage(data::DbState::default())
        .manage(secrets::SecretsState::default())
        .manage(ai_session::SessionTracker::default())
        .manage(schedule::ScheduleState::default())
        .manage(project_registry::ProjectRegistry::default())
        .setup(|app| {
            // identity 홈 확정 — 모든 경로(데이터·플러그인·사이드카·테마·프로젝트·소켓·시크릿)가
            // 이 값에서 파생되므로 어떤 경로 사용보다 먼저 1회 고정한다(home.rs 원칙).
            home::init(&app.config().identifier);
            // 범용 데이터 스토어(app.data) — 소켓 서버 이전에 연다(커맨드가 즉시 쓸 수 있도록).
            match data::db_path().and_then(|p| data::open(&p)) {
                Ok(conn) => {
                    // 활동 허브 컬렉션(core/activity) 정의 — 발행 즉시 영속 가능(A1).
                    activity::init_collection(&conn);
                    // seq 를 영속 최댓값에서 재개 — 재시작을 넘는 단조(소비자 읽음 커서 보존).
                    activity::resume_seq(app.handle(), &conn);
                    app.state::<data::DbState>().set(conn)
                }
                Err(e) => eprintln!("[data] DB 열기 실패: {e}"),
            }
            // 영속된 시간 기반(At/Every/Cron) 일정 재무장(crash 복구) — DB 열린 직후. 무상태 Reconcile 은
            // 플러그인이 activate 시 재등록한다. 일정 없으면 no-op(발화 스레드도 안 뜸).
            schedule::reload_persisted(app.handle());
            // 시크릿 볼트 — 프로덕션 경로 주입(init 1회) 후 헤드리스/e2e 자동 unlock
            // (SOKSAK_VAULT_KEY env 있을 때만, 없으면 잠김 유지).
            {
                let st = app.state::<secrets::SecretsState>();
                // SOKSAK_VAULT_PATH 있으면 격리 경로(헤드리스/E2E), 없으면 프로덕션 default.
                match secrets::resolve_vault_path(|k| std::env::var(k).ok()) {
                    Ok(p) => st.set_path(p),
                    Err(e) => eprintln!("[secrets] 볼트 경로 계산 실패: {e}"),
                }
                // [R23] app.data 에 봉투 키가 등록돼 있으면 vault 가 있어야 한다 — 부재 시 새 vault 자동생성
                // 거부 플래그를 켠다(임의 passphrase 통과+전손 차단). data DB 가 열린 뒤라 조회 가능.
                let expect = match app.state::<data::DbState>().conn.lock() {
                    Ok(g) => g
                        .as_ref()
                        .map(|c| data::crypto::has_any_keys(c).unwrap_or(false))
                        .unwrap_or(false),
                    Err(_) => false,
                };
                st.set_expect_vault(expect);
                secrets::auto_unlock_from_env(&st);
            }
            // [단계③] auto-lock 틱 — idle 타임아웃 경과 시 vault 를 잠그고 전 창에 broadcast(터미널 폐기·
            // 잠금 UI 전환을 프론트가 반응). 단일 OS 스레드 15s tick(폴링 비용 무시 가능). 타임아웃 0(기본)
            // 이면 auto_lock_due 가 항상 false → no-op. 활동 reset 은 프론트 secret_touch.
            {
                let lock_handle = app.handle().clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_secs(15));
                    let st = lock_handle.state::<secrets::SecretsState>();
                    if st.auto_lock_due(secrets::now_ms()) {
                        let _ = secrets::lock_and_broadcast(&lock_handle, &st);
                    }
                });
            }
            // 파일 워처 1회 초기화(이벤트 콜백에 앱 핸들 주입).
            let handle = app.handle().clone();
            app.state::<FsWatcher>().init(handle);
            // 클립보드 watcher 1회 초기화(이벤트 emit 용 앱 핸들 주입). 실제 감시는 플러그인이
            // clipboard_watch_start 를 호출할 때 시작 — 쓰지 않으면 스레드/폴링 0.
            app.state::<clipboard::ClipboardState>()
                .init(app.handle().clone());
            // app-internal command socket(JSON-RPC). sok CLI 가 직접 사용하고, `sok mcp` 서브프로세스가
            // stdio MCP↔이 소켓 브리지로 사용한다. app 은 MCP 서버가 아니다 — docs/AI-CONTROL.md P6.
            if let Err(e) = ipc::start(app.handle().clone()) {
                eprintln!("[ipc] 소켓 서버 기동 실패: {e}");
            }
            // 범용 미디어 스트리밍 프록시(루프백 HTTP) — webview 가 못 받는 Referer/CORS 보호 미디어를
            // 헤더 주입해 바이너리 스트리밍한다. media.proxy.* 가 표면. 기동 실패는 재생만 실패(앱은 산다).
            if let Err(e) = mediaproxy::start() {
                eprintln!("[mediaproxy] 프록시 서버 기동 실패: {e}");
            }
            // 딥링크 라우팅 — soksak://run?cmd=... 외부 진입/알림 클릭이 한 명령을 실행한다(CmdBridge 경유,
            // 단일 실행 경로). dev 는 스킴이 OS 미등록일 수 있어 register_all 로 런타임 등록(프로덕션은
            // tauri.conf plugins.deep-link). 파싱 실패/미지 URL 은 조용히 무시(명령 누출 0).
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let dl_handle = app.handle().clone();
                let _ = app.deep_link().register_all();
                app.deep_link().on_open_url(move |event| {
                    for u in event.urls() {
                        if let Some((cmd, params)) = deeplink::parse_command_url(u.as_str()) {
                            let _ = ipc::request_command(&dl_handle, cmd, params, 10_000);
                        }
                    }
                });
            }
            // 원격 제어(폰-링크) transport 는 코어에서 분리됐다 — soksak-plugin-remote-iroh 사이드카가
            // 검증된 보안 하한선(remote::*)을 코어 밖 프로세스에서 구동하고, 인가된 명령을 SOKSAK_SOCKET
            // 으로 코어에 중계하며 destructive 는 코어 remote.confirm 사람 모달을 거친다. 코어는 모달
            // (RemoteConfirmModal + remote.confirm 커맨드)만 남긴다 — iroh/snow 트리는 코어에서 빠진다.
            // 신호등: 좌표는 tauri.conf.json trafficLightPosition 이 소유, 유지는
            // titlebar::install 의 NSNotification 옵저버가 담당(titlebar.rs 참조).
            #[cfg(target_os = "macos")]
            {
                // main 창 네이티브(레이어 역전·신호등) — 새 창과 동일한 단일 진입점(window.rs).
                window::install_window_natives(app.handle(), "main");
                // 앱 전역 모니터(클릭·라이브리사이즈) — 창 무관 1회 설치. 모든 창을 추적하고 어느
                // 창인지 label 을 동반 emit 한다(MW4 — webview.rs 머리말). 프론트가 자기 창만 필터.
                webview::install_click_monitor(app.handle());
                webview::install_live_resize_monitor(app.handle());
                // 신호등 유지 옵저버 — 앱 전역 1회(모든 창). 창마다 달면 창 닫아도 안 빠져 누수.
                let (tlx, tly) = window::traffic_light_inset(app.handle());
                titlebar::install_global_observers(tlx, tly);
                // Dock 우클릭 "새 창"(Terminal.app 관례) — 앱 델리게이트 applicationDockMenu: 주입.
                dockmenu::install(app.handle());
            }
            Ok(())
        })
        // 창 포커스(NSWindow key 등) 변화를 프론트로 emit({label, focused}). 다른 앱으로 전환하면
        // false, 같은 창 안 child webview(내장 브라우저)로 포커스가 가도 창 레벨이라 불변. 부차
        // 애니메이션 게이팅 신호이자, 멀티 윈도우 활성 창 추적(소켓 라우팅 기본 타겟) 소스.
        .on_window_event(|window, event| {
            use tauri::{Emitter, Manager};
            match event {
                tauri::WindowEvent::Focused(focused) => {
                    let label = window.label();
                    if *focused {
                        ipc::note_focus(label); // 활성 창 갱신(Rust 가 추적)
                    }
                    // 그 창에만 emit_to — 프론트 필터 불필요(자기 창 신호만 도착). 활성 창 추적은
                    // Rust(note_focus)가 담당하므로 프론트는 단순히 focused 만 받는다.
                    let _ = window.app_handle().emit_to(label, "window-focus", *focused);
                    // 전역 broadcast — 오케스트레이터 창맵이 팩트(위치·포커스)를 자동 갱신한다(수동
                    // 새로고침 제거). 다른 창은 이 이벤트를 구독하지 않아 무시한다.
                    let _ = window.app_handle().emit("window-changed", ());
                }
                // 창 이동·크기변경도 창맵 팩트를 바꾼다 — 자동 갱신 대상. 드래그 중 폭주는 구독측
                // (오케스트레이터)이 디바운스로 흡수하므로 코어는 그대로 broadcast 한다.
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                    let _ = window.app_handle().emit("window-changed", ());
                }
                // 창이 닫히면 그 창의 브라우저 child webview 를 회수한다 — 창 프론트가 사라지면 그 창
                // browserGc 가 멈추고 다른 창 GC 는 접두사 필터로 안 건드리므로 child 가 좀비로 남는다.
                // 창과 함께 죽어야 할 자식을 그 창 label 접두사(b-<label>-)로 골라 명시 정리.
                // 사용자가 이 창을 닫는 중(빨간 버튼·Cmd+W·window.close 요청 경로) — 마크만 남긴다.
                // 실제 영속 정리는 Destroyed 에서(B1 의미론, window.rs 머리말): 웹뷰 unload 의 마지막
                // 저장(pagehide)이 정리 뒤에 도착해 스냅샷을 부활시키지 않도록 순서를 보장한다.
                // 앱 종료(Cmd+Q/app.exit)의 창 파괴는 이 이벤트를 지나지 않아 세션이 보존된다.
                tauri::WindowEvent::CloseRequested { .. } => {
                    // 파괴 순서 계약(SIDECARS) — dealloc 전에 엔진 child 부터 닫게 통지.
                    #[cfg(target_os = "macos")]
                    crate::sidecar::notify_surface_closing(window);
                    window::mark_user_closed(window.label());
                }
                tauri::WindowEvent::Destroyed => {
                    crate::sidecar::forget_window(window.label()); // 사이드카 surface 캐시 무효화(stale NSView 방지)
                    let app = window.app_handle();
                    // 프로젝트 전역 단일 오픈(P6): 죽은 창의 점유를 해제해 다른 창이 그 프로젝트를
                    // 열 수 있게 한다(해제 없으면 앱 재시작까지 유령 점유).
                    crate::project_registry::on_window_destroyed(&app, window.label());
                    let _ = app.emit("window-changed", ()); // 오케스트레이터 창맵 자동 갱신
                    // 사용자 개별 닫기였다면 그 창의 세션 흔적(스냅샷 kv + manifest slot)을 폐기.
                    if window::take_user_closed(window.label()) {
                        let st = app.state::<data::DbState>();
                        let guard = st.conn.lock();
                        if let Ok(guard) = guard {
                            if let Some(conn) = guard.as_ref() {
                                if let Err(e) =
                                    window::prune_window_persistence(conn, window.label())
                                {
                                    eprintln!(
                                        "[persist] 창 흔적 정리 실패({}): {e}",
                                        window.label()
                                    );
                                }
                            }
                        }
                    }
                    let prefix = format!("b-{}-", window.label());
                    let orphans: Vec<String> = app
                        .webviews()
                        .keys()
                        .filter(|l| l.starts_with(&prefix))
                        .cloned()
                        .collect();
                    for label in orphans {
                        if let Some(wv) = app.get_webview(&label) {
                            let _ = wv.close();
                        }
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            pty::spawn_terminal,
            pty::pty_pane_pid,
            pty::write_terminal,
            pty::resize_terminal,
            pty::ack_terminal,
            pty::close_terminal,
            pty::shell_which,
            runtime_dep::binary_integrity,
            runtime_dep::probe_binary,
            runtime_dep::cleanup_stale,
            runtime_dep::download_verify,
            runtime_dep::npm_global_dirs,
            runtime_dep::verify_and_link,
            process::process_spawn,
            process::process_write,
            process::process_stdin_close,
            process::process_kill,
            network::network_udp_send,
            network::network_udp_request,
            ws::ws_connect,
            ws::ws_send,
            ws::ws_close,
            http::network_http_request,
            mediaproxy::media_proxy_info,
            notify::notify_show,
            schedule::schedule_set,
            schedule::schedule_register,
            schedule::schedule_poke,
            schedule::schedule_cancel,
            schedule::schedule_list,
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
            home::app_is_release,
            plugins::plugin_install_git,
            plugins::plugin_update,
            plugins::plugin_dev_new,
            plugins::plugin_remove,
            plugins::plugin_data_read,
            plugins::plugin_data_write,
            plugins::plugin_data_list,
            data::commands::data_kv_get,
            data::commands::data_kv_set,
            data::commands::data_kv_delete,
            data::commands::data_kv_keys,
            data::commands::data_define,
            data::commands::data_put,
            data::commands::data_get,
            data::commands::data_delete,
            data::commands::data_query,
            data::commands::data_search,
            data::commands::data_count,
            data::commands::data_retention_trim,
            data::commands::data_retention_reap,
            data::commands::data_encryption_enable,
            data::commands::data_encryption_convert,
            data::commands::data_encryption_rotate,
            data::commands::data_encryption_recover,
            data::commands::data_encryption_status,
            ai_session::ai_session_detect,
            ai_session::ai_session_inspect,
            ai_session::ai_session_find,
            ai_session::ai_session_dir,
            ai_session::ai_session_active,
            ai_session::ai_session_untrack,
            ai_session::ai_session_lineage,
            data::commands::data_backup,
            data::commands::data_restore,
            data::commands::data_export,
            data::commands::data_import,
            secrets::secret_unlock,
            secrets::secret_lock,
            secrets::secret_touch,
            secrets::secret_set_idle_timeout,
            secrets::secret_lock_info,
            secrets::secret_set,
            secrets::secret_has,
            secrets::secret_delete,
            secrets::secret_keys,
            secrets::secret_backend,
            git::git_log,
            git::git_init_if_missing,
            git::git_show,
            git::git_diff,
            watcher::watch_dir,
            watcher::unwatch_dir,
            clipboard::clipboard_read,
            clipboard::clipboard_write,
            clipboard::clipboard_watch_start,
            clipboard::clipboard_watch_stop,
            webview::webview_open,
            webview::webview_bounds,
            webview::webview_navigate,
            webview::webview_devtools,
            webview::webview_history,
            webview::webview_visible,
            webview::webview_close,
            webview::webview_divider_highlight,
            webview::webview_emit_native,
            webview::webview_list,
            webview::webview_open_window,
            webview::webview_eval,
            webview::webview_inject_script,
            webview::webview_media_extract,
            webview::webview_overlay_active,
            webview::webview_resize_gesture,
            webview::webview_dom_holes,
            webview::webview_debug_hierarchy,
            window_set_background,
            activity::activity_publish,
            activity::activity_recent,
            project_registry::project_claim,
            project_registry::project_release,
            project_registry::project_owners,
            window::window_create,
            window::window_monitors,
            window::window_place,
            window::window_list,
            window::window_focus,
            window::window_close,
            ipc::cmd_result,
            ipc::ipc_socket_path,
            ipc::ipc_cli_dir,
            titlebar::titlebar_backing,
            ime_debug,
            window_activate,
            sidecar::sidecar_open,
            sidecar::sidecar_send,
            sidecar::sidecar_close,
            sidecar::sidecar_ensure,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 엔진 사이드카(예: Chromium)의 메시지펌프는 tao 콜백에서 돌리지 않는다 — NSApp 이벤트
            // 펌프 재진입 데드락(실측). 모듈이 GCD 로 메인런루프 최상위에 비재진입 디스패치한다
            // (soksak-sidecar-browser-chromium repo 참조).
            // 멀티 윈도우 종료 규칙: 창이 하나라도 남아 있으면 앱을 종료하지 않는다 — 한 창을 닫아도
            // 다른 창은 살아야 한다. 실제 종료(PTY 자식 정리·소켓 정리)는 마지막 창이 닫혔을 때만.
            // (Tauri 기본은 ExitRequested 시 그대로 종료 — prevent_exit 로 비-마지막 창 종료를 막는다.)
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                // windows()(Window 레지스트리) — 브라우저 child 를 연 창은 멀티-webview 라
                // webview_windows() 에서 빠진다. 그걸 쓰면 브라우저 연 창이 마지막 1개일 때 "창 없음"
                // 으로 오판해 앱이 종료된다. 실제 OS 창 존재 여부는 windows() 가 진실.
                // code Some = 명시 종료(Cmd+Q 메뉴/app.exit) — 창이 남아 있어도 종료를 막지 않는다.
                // 이 경로의 창 파괴는 CloseRequested 를 지나지 않아 전 창 세션(스냅샷·manifest)이
                // 보존된다(B1: 종료=보존, 개별 닫기=폐기 — window.rs 의미론).
                if code.is_none() && !app_handle.windows().is_empty() {
                    api.prevent_exit();
                    return;
                }
                app_handle.state::<PtyManager>().kill_all();
                app_handle.state::<ProcessManager>().kill_all();
                app_handle.state::<ws::WsManager>().close_all();
                ipc::cleanup();
                mediaproxy::cleanup();
                sidecar::shutdown_all();
            }
        });
}
