// 멀티 윈도우 — 새 OS 창 생성·열거·포커스·닫기. 같은 frontendDist 를 로드해 각 창이 독립
// 작업공간(프로젝트 탭/세션)이 된다(sessions store 는 메모리라 webview 별 JS 컨텍스트가 자연 격리;
// settings/theme/plugins 는 localStorage 공유 — 의도적 전역). 소켓·플러그인·설정은 1 프로세스 공유.
//
// 새 창은 생성 직후 그 label 로 네이티브 hook(레이어 역전·신호등)을 설치해 hole-punch 브라우저가
// 이 창에서도 동작한다(P0 창별 HashMap 덕 — browser.rs layer 참조).

use std::sync::atomic::{AtomicUsize, Ordering};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

static WIN_SEQ: AtomicUsize = AtomicUsize::new(1);

// 새 창 생성. label = "win-<seq>". 같은 앱(index.html)을 로드한다. 반환 = 생성된 창 label.
#[tauri::command]
pub fn window_create(app: AppHandle) -> Result<String, String> {
    let label = format!("win-{}", WIN_SEQ.fetch_add(1, Ordering::Relaxed));
    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("soksak")
        .inner_size(900.0, 640.0);
    #[cfg(target_os = "macos")]
    {
        use tauri::{LogicalPosition, TitleBarStyle};
        builder = builder
            .title_bar_style(TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(LogicalPosition::new(12.0, 20.0));
    }
    builder.build().map_err(|e| e.to_string())?;

    // 이 창에 네이티브 hook — 레이어 역전(브라우저 hole-punch)과 신호등 유지.
    #[cfg(target_os = "macos")]
    {
        crate::browser::install_layer_inversion(&app, &label);
        if let Some(window) = app.get_window(&label) {
            crate::titlebar::install(&window, 12.0, 20.0);
        }
    }
    Ok(label)
}

// 열린 창 label 목록(소켓/CLI introspection — window 명시 타겟 조회).
#[tauri::command]
pub fn window_list(app: AppHandle) -> Vec<String> {
    app.webview_windows().keys().cloned().collect()
}

#[tauri::command]
pub fn window_focus(app: AppHandle, label: String) -> Result<(), String> {
    app.get_webview_window(&label)
        .ok_or_else(|| format!("창 없음: {label}"))?
        .set_focus()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_close(app: AppHandle, label: String) -> Result<(), String> {
    app.get_webview_window(&label)
        .ok_or_else(|| format!("창 없음: {label}"))?
        .close()
        .map_err(|e| e.to_string())
}
