// 멀티 윈도우 — 새 OS 창 생성·열거·포커스·닫기. 같은 frontendDist 를 로드해 각 창이 독립
// 작업공간(프로젝트 탭/세션)이 된다(sessions store 는 메모리라 webview 별 JS 컨텍스트가 자연 격리;
// settings/theme/plugins 는 localStorage 공유 — 의도적 전역). 소켓·플러그인·설정은 1 프로세스 공유.
//
// 새 창은 생성 직후 그 label 로 네이티브 hook(레이어 역전·신호등)을 설치해 hole-punch 브라우저가
// 이 창에서도 동작한다(P0 창별 HashMap 덕 — browser.rs layer 참조).

use std::sync::atomic::{AtomicUsize, Ordering};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

static WIN_SEQ: AtomicUsize = AtomicUsize::new(1);

// 한 창의 네이티브를 설치하는 단일 진입점(MW1) — main(setup)·새 창(window_create)이 같은 함수를
// 호출해 중복·누락을 막는다. 레이어 역전(hole-punch)과 신호등을 그 창에 건다. 앱 전역 모니터
// (클릭·라이브리사이즈)는 창과 무관하게 1회만 설치되므로 여기 포함하지 않는다(lib.rs setup).
#[cfg(target_os = "macos")]
pub fn install_window_natives(app: &AppHandle, label: &str) {
    crate::browser::install_layer_inversion(app, label);
    if let Some(window) = app.get_window(label) {
        // 신호등 위치 = conf trafficLightPosition(전 창 공통 정책, 단일 진실). 미설정 시 (12,20).
        let (x, y) = app
            .config()
            .app
            .windows
            .first()
            .and_then(|w| w.traffic_light_position.as_ref())
            .map(|p| (p.x, p.y))
            .unwrap_or((12.0, 20.0));
        crate::titlebar::install(&window, x, y);
    }
}

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

    // 이 창에 네이티브 설치(레이어 역전·신호등) — main 과 동일한 단일 진입점.
    #[cfg(target_os = "macos")]
    install_window_natives(&app, &label);
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

// MW3 — 규칙을 테스트로 강제한다. 창-종속 리소스가 단일 창("main")을 하드코딩하면(MW1 위반) 빌드가
// 실패한다. 부트스트랩(install_window_natives 의 "main", LAST_FOCUSED 기본값)은 get_*("main") 호출이
// 아니라 통과한다.
#[cfg(test)]
mod mw_rules {
    #[test]
    fn no_hardcoded_main_window() {
        const PATS: [&str; 3] = [
            "get_window(\"main\")",
            "get_webview(\"main\")",
            "get_webview_window(\"main\")",
        ];
        for f in ["src/browser.rs", "src/ipc.rs", "src/window.rs", "src/lib.rs"] {
            let src = std::fs::read_to_string(f).unwrap_or_default();
            for pat in PATS {
                assert!(
                    !src.contains(pat),
                    "MW1 위반({f}): `{pat}` 하드코딩 — 창-종속 리소스는 창 label 로 키잉하라"
                );
            }
        }
    }
}
