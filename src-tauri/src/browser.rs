// 브라우저 패널: 메인 창 안에 child webview(WKWebView)를 임베드한다(iframe 아님 —
// X-Frame-Options 제약 없이 실제 브라우저). 링크 클릭은 webview 기본 동작이고,
// 이전/이후는 history.back()/forward() eval, URL 변화는 on_navigation 으로 프론트에
// emit(폴링 없음). 위치/크기는 프론트 레이아웃(slot rect)을 따라 browser_bounds 로 동기화.

use serde::Serialize;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};

#[derive(Clone, Serialize)]
struct NavPayload {
    label: String,
    url: String,
}

// 새 창 요청(target=_blank / window.open)을 같은 패널에서 연다. 외부 페이지가 Tauri 의
// opener IPC(외부 webview 에 권한 없음 → Unhandled Rejection)로 위임되는 것을 차단하고,
// 단일 패널 브라우저답게 현재 패널에서 네비게이션한다.
const SAME_PANEL_NAV: &str = r#"
(function () {
  var nav = function (u) { try { if (u) location.href = u; } catch (_) {} };
  window.open = function (u) { nav(u); return null; };
  document.addEventListener("click", function (e) {
    var t = e.target;
    var a = t && t.closest ? t.closest('a[target="_blank"]') : null;
    if (a && a.href) { e.preventDefault(); nav(a.href); }
  }, true);
})();
"#;

// child webview 생성(이미 있으면 무시). label = "b-<viewId>".
#[tauri::command]
pub fn browser_open(
    app: AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    if app.get_webview(&label).is_some() {
        return Ok(());
    }
    let window = app.get_window("main").ok_or("main window 없음")?;
    let parsed = Url::parse(&url).map_err(|e| e.to_string())?;
    let nav_app = app.clone();
    let nav_label = label.clone();
    let builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .initialization_script(SAME_PANEL_NAV)
        // 링크 클릭 등 네비게이션을 프론트로 통지(URL 바 동기화, 폴링 없음).
        // about:blank 는 WKWebView 초기화 과정의 중간 단계 — URL 상태를 덮어쓰지 않게 제외.
        .on_navigation(move |url| {
            if url.as_str() != "about:blank" {
                let _ = nav_app.emit(
                    "browser-nav",
                    NavPayload {
                        label: nav_label.clone(),
                        url: url.to_string(),
                    },
                );
            }
            true // 허용
        });
    window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(w, h),
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

// 패널 레이아웃 변화(분할/리사이즈/이동)에 맞춰 위치/크기 동기화.
#[tauri::command]
pub fn browser_bounds(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        wv.set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        wv.set_size(LogicalSize::new(w, h))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn browser_navigate(app: AppHandle, label: String, url: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        wv.navigate(Url::parse(&url).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// 이전/이후: webview 의 세션 히스토리 사용.
#[tauri::command]
pub fn browser_history(app: AppHandle, label: String, delta: i32) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        wv.eval(format!("history.go({delta})"))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// 탭/뷰 전환 시 표시/숨김(native 레이어는 DOM 위에 떠서 CSS visibility 가 안 닿는다).
#[tauri::command]
pub fn browser_visible(app: AppHandle, label: String, visible: bool) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        if visible {
            wv.show().map_err(|e| e.to_string())?;
            // hide→show 후 첫 클릭이 무시되지 않게 포커스 복구.
            let _ = wv.set_focus();
        } else {
            wv.hide().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// 뷰가 영구히 닫힐 때 webview 정리.
#[tauri::command]
pub fn browser_close(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        wv.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}
