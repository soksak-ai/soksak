// macOS 신호등(트래픽 라이트) 재배치 — 44px 커스텀 타이틀바 상하 중앙 정렬.
//
// tauri.conf.json 의 trafficLightPosition 은 titleBarStyle:Overlay 와 함께
// webview parent_view 경로까지 닿지 않아 적용되지 않는다. 그래서 wry 가 내부적으로
// 쓰는 inset_traffic_lights 와 동일한 로직(타이틀바 컨테이너 뷰를 키워 버튼을
// 그 안에서 중앙으로 밀어 올림)을 setup 에서 직접 호출한다.
//
// (wry-0.55.1 src/wkwebview/class/wry_web_view_parent.rs 의 inset_traffic_lights 복제)

// bar_height = 커스텀 타이틀바 높이(CSS 44px). 버튼 컨테이너(NSTitlebarView)를 이
// 높이로 키워 창 상단에 붙이면 AppKit 이 버튼을 그 안에서 세로 중앙으로 배치한다.
// x = 첫 버튼(닫기)의 좌측 인셋.
#[cfg(target_os = "macos")]
#[allow(dead_code)] // 현재 호출 비활성(클릭 가로챔 회귀 격리) — 모듈 보존.
pub fn center_traffic_lights<R: tauri::Runtime>(
    win: &tauri::WebviewWindow<R>,
    bar_height: f64,
    x: f64,
) {
    use objc2::rc::Retained;
    use objc2_app_kit::{NSView, NSWindow, NSWindowButton};

    // with_webview 의 클로저는 메인 스레드에서 실행된다(tauri 보장).
    let _ = win.with_webview(move |wv| unsafe {
        let ns_view = &*(wv.inner() as *const NSView);
        let Some(window): Option<Retained<NSWindow>> = ns_view.window() else {
            return;
        };
        let (Some(close), Some(miniaturize)) = (
            window.standardWindowButton(NSWindowButton::CloseButton),
            window.standardWindowButton(NSWindowButton::MiniaturizeButton),
        ) else {
            return;
        };
        let zoom = window.standardWindowButton(NSWindowButton::ZoomButton);

        // 버튼들의 컨테이너(NSTitlebarView = close.superview.superview).
        let Some(container) = close.superview().and_then(|sv| sv.superview()) else {
            return;
        };

        let mut bar_rect = NSView::frame(&container);
        bar_rect.size.height = bar_height;
        bar_rect.origin.y = window.frame().size.height - bar_height;
        container.setFrame(bar_rect);

        let close_rect = NSView::frame(&close);
        let space = NSView::frame(&miniaturize).origin.x - close_rect.origin.x;
        let mut buttons = vec![close, miniaturize];
        if let Some(zoom) = zoom {
            buttons.push(zoom);
        }
        for (i, button) in buttons.into_iter().enumerate() {
            let mut rect = NSView::frame(&button);
            rect.origin.x = x + (i as f64 * space);
            button.setFrameOrigin(rect.origin);
        }
    });
}
