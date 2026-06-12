// macOS 신호등(트래픽 라이트) 비활성 소멸 보정.
//
// 위치 자체는 tauri.conf.json 의 trafficLightPosition(공식, 2.4.0+)이 소유한다.
// 문제: 창이 키 상태를 잃거나 얻을 때 AppKit 이 타이틀바 버튼 컨테이너를 표준
// 프레임으로 재배치해 커스텀 inset 이 풀리고 버튼이 사라진다. tao 는 컨텐트 뷰
// draw_rect 에서 재적용하지만 이 재배치는 그 이후에 일어나 누락된다(검증:
// setNeedsDisplay 트리거만으로는 소멸 지속).
//
// 치료: Focused 이벤트 후 다음 틱(메인 스레드)에 tao-0.35.3 의
// inset_traffic_lights 와 동일한 산식을 직접 재적용한다. 좌표를 여기서 다시
// 정하지 않는다 — 호출자가 conf 값을 전달(단일 진실 = tauri.conf.json).

#[cfg(target_os = "macos")]
pub fn reapply_after_layout<R: tauri::Runtime>(window: &tauri::Window<R>, x: f64, y: f64) {
    let win = window.clone();
    // Focused 콜백 시점엔 AppKit 의 자체 재배치가 아직 안 끝났을 수 있다 —
    // 다음 런루프 틱으로 미뤄 재배치 이후에 덮어쓴다.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(50));
        let _ = win.clone().run_on_main_thread(move || unsafe {
            if let Ok(ptr) = win.ns_window() {
                apply_inset(&*(ptr as *const objc2_app_kit::NSWindow), x, y);
            }
        });
    });
}

// tao-0.35.3 src/platform_impl/macos/view.rs inset_traffic_lights 와 동일 산식.
#[cfg(target_os = "macos")]
unsafe fn apply_inset(window: &objc2_app_kit::NSWindow, x: f64, y: f64) {
    use objc2_app_kit::{NSView, NSWindowButton};

    let (Some(close), Some(miniaturize), Some(zoom)) = (
        window.standardWindowButton(NSWindowButton::CloseButton),
        window.standardWindowButton(NSWindowButton::MiniaturizeButton),
        window.standardWindowButton(NSWindowButton::ZoomButton),
    ) else {
        return;
    };
    let Some(container) = close.superview().and_then(|sv| sv.superview()) else {
        return;
    };

    let close_rect = NSView::frame(&close);
    let bar_height = close_rect.size.height + y;
    let mut bar_rect = NSView::frame(&container);
    bar_rect.size.height = bar_height;
    bar_rect.origin.y = window.frame().size.height - bar_height;
    container.setFrame(bar_rect);

    let space = NSView::frame(&miniaturize).origin.x - close_rect.origin.x;
    for (i, button) in [close, miniaturize, zoom].into_iter().enumerate() {
        button.setHidden(false);
        let mut rect = NSView::frame(&button);
        rect.origin.x = x + (i as f64 * space);
        button.setFrameOrigin(rect.origin);
    }
}
