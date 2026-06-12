// macOS 신호등(트래픽 라이트) — unstable(child webview) 경로의 위치/가시성 보정.
//
// 위치의 단일 진실은 tauri.conf.json trafficLightPosition. 문제 두 겹:
//   1) 재적용 루프 부재(tauri#14072): 정상 경로에선 wry(WryWebViewParent.drawRect)가
//      매 redraw 마다 inset 을 재적용하지만, unstable(child webview) 경로에선 그
//      루프가 설치되지 않는다 → 키 상태 전환 때 AppKit 재배치를 덮어쓸 주체가 없다.
//   2) 비활성 합성 순서: 비활성 전환 시 버튼이 배경(out-of-process WKWebView 레이어)
//      에 덮여 사실상 보이지 않게 된다(실측: 중심색이 배경과 Δ2~3).
//
// 치료:
//   - NSNotificationCenter 옵저버(becomeKey/resignKey/becomeMain/resignMain/
//     resize/exitFullScreen)에서 "동기" 재적용 — 슬립 기반 지연 재적용은 AppKit
//     후속 패스와의 경쟁이라 폐기.
//   - 버튼 컨테이너(NSTitlebarContainerView)를 버튼 클러스터 폭으로 줄이고 형제
//     최상단으로 재배열 — 비활성에서도 webview 위에 합성된다. 전폭 확장이 아니라
//     우측 타이틀바 DOM 버튼 클릭을 가로채지 않는다(이전 회귀의 원인 차단).
//
// 계측(디버그 빌드): 각 전환의 전/후 상태를 /tmp/soksak-titlebar.log 에 기록.

#[cfg(target_os = "macos")]
use objc2_app_kit::{NSView, NSWindow, NSWindowButton, NSWindowOrderingMode};

// 비활성(회색) 위젯은 backdrop 합성으로 그려지는데, 배경이 out-of-process
// WKWebView 레이어면 샘플링이 실패해 유령(배경과 Δ2~3)이 된다 — 계측으로 뷰
// 상태(hidden/alpha/frame/z)는 전부 정상임을 확인, 그리기 단계의 문제.
// 버튼 뒤에만 불투명 테마색 백킹을 깔아 표준 합성을 복원한다.
// 색은 프런트 테마 엔진이 titlebar_backing 명령으로 동기화(미동기화 시 시스템
// windowBackgroundColor 폴백 — 항상 백킹은 존재한다).
#[cfg(target_os = "macos")]
static BACKING_COLOR: std::sync::Mutex<Option<(f64, f64, f64)>> = std::sync::Mutex::new(None);

// install 시 conf 좌표 보관 — titlebar_backing 명령의 즉시 재적용용.
#[cfg(target_os = "macos")]
static INSET: std::sync::Mutex<(f64, f64)> = std::sync::Mutex::new((12.0, 20.0));

// 프런트 테마 적용 시 호출 — 백킹 색 동기화 + 즉시 재적용.
#[tauri::command]
pub fn titlebar_backing(window: tauri::Window, r: f64, g: f64, b: f64) {
    #[cfg(target_os = "macos")]
    {
        *BACKING_COLOR.lock().unwrap() = Some((r, g, b));
        let (x, y) = *INSET.lock().unwrap();
        let win = window.clone();
        let _ = window.run_on_main_thread(move || unsafe {
            if let Ok(ptr) = win.ns_window() {
                apply_inset(&*(ptr as *const NSWindow), x, y);
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, r, g, b);
}

// 앱 수명 1회 설치: 즉시 1회 적용 + 옵저버 등록. 좌표는 conf 값(호출자 전달).
#[cfg(target_os = "macos")]
pub fn install<R: tauri::Runtime>(window: &tauri::Window<R>, x: f64, y: f64) {
    *INSET.lock().unwrap() = (x, y);
    let win = window.clone();
    let _ = window.run_on_main_thread(move || unsafe {
        let Ok(ptr) = win.ns_window() else { return };
        let ns = &*(ptr as *const NSWindow);
        apply_inset(ns, x, y);
        dump_state("install", ns);
        install_observers(ptr, x, y);
    });
}

#[cfg(target_os = "macos")]
unsafe fn install_observers(ns_window_ptr: *mut std::ffi::c_void, x: f64, y: f64) {
    use objc2_app_kit::{
        NSWindowDidBecomeKeyNotification, NSWindowDidBecomeMainNotification,
        NSWindowDidExitFullScreenNotification, NSWindowDidResignKeyNotification,
        NSWindowDidResignMainNotification, NSWindowDidResizeNotification,
    };
    use objc2_foundation::{NSNotification, NSNotificationCenter};

    let center = NSNotificationCenter::defaultCenter();
    let events: [(&'static str, &'static objc2_foundation::NSNotificationName); 6] = [
        ("becomeKey", NSWindowDidBecomeKeyNotification),
        ("resignKey", NSWindowDidResignKeyNotification),
        ("becomeMain", NSWindowDidBecomeMainNotification),
        ("resignMain", NSWindowDidResignMainNotification),
        ("resize", NSWindowDidResizeNotification),
        ("exitFullScreen", NSWindowDidExitFullScreenNotification),
    ];

    for (label, name) in events {
        let block = block2::RcBlock::new(move |note: std::ptr::NonNull<NSNotification>| {
            // 통지는 메인 스레드에서 게시된다(queue=None = 게시 스레드에서 실행).
            let note = unsafe { note.as_ref() };
            let Some(obj) = note.object() else { return };
            let Ok(ns) = obj.downcast::<NSWindow>() else { return };
            unsafe {
                dump_state(&format!("{label}:before"), &ns);
                apply_inset(&ns, x, y);
                dump_state(&format!("{label}:after"), &ns);
            }
        });
        let token = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(name),
                // 이 창의 통지만(브라우저 자식 webview 창/패널 제외).
                Some(&*(ns_window_ptr as *const objc2::runtime::AnyObject)),
                None,
                &block,
            )
        };
        // 옵저버는 앱 수명 동안 유지 — 의도된 leak(창 1개, 설치 1회).
        std::mem::forget(token);
    }
}

// tao-0.35.3 inset_traffic_lights 산식 + 컨테이너 폭 축소 + 최상단 재배열.
#[cfg(target_os = "macos")]
unsafe fn apply_inset(window: &NSWindow, x: f64, y: f64) {
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

    // tao-0.35.3 inset_traffic_lights 산식 그대로(높이/세로 위치만) — 폭/순서/
    // 가시성 조작은 절제 실험으로 하중이 없음이 확인돼 제거됨.
    let close_rect = NSView::frame(&close);
    let space = NSView::frame(&miniaturize).origin.x - close_rect.origin.x;
    let bar_height = close_rect.size.height + y;
    let mut bar_rect = NSView::frame(&container);
    bar_rect.origin.y = window.frame().size.height - bar_height;
    bar_rect.size.height = bar_height;
    container.setFrame(bar_rect);

    // 비활성 위젯의 backdrop 합성 복원 — 점 모양 그대로의 원형 백킹 3개(§상단 주석).
    // 활성 상태에선 숨김(점이 불투명 컬러라 불필요 + 테마 전환 이질감 제거).
    ensure_backing(
        [&close, &miniaturize, &zoom],
        window.isKeyWindow(),
    );

    for (i, button) in [close, miniaturize, zoom].into_iter().enumerate() {
        let mut rect = NSView::frame(&button);
        rect.origin.x = x + (i as f64 * space);
        button.setFrameOrigin(rect.origin);
    }
}

// 버튼마다 그 프레임과 동일한 원형 백킹(NSBox, cornerRadius=½)을 바로 아래에 깐다.
// 점 밖으로 새는 픽셀이 없어 테마와의 색 차가 드러나지 않는다. 멱등: 버튼들의
// superview 에 NSBox 를 넣는 건 우리뿐 — 기존 것을 수거해 재사용.
// 색 미동기화 시 시스템 windowBackgroundColor(라이트/다크 자동) 폴백.
// is_key=true(활성)면 숨김 — 백킹은 비활성 합성 복원 전용.
#[cfg(target_os = "macos")]
unsafe fn ensure_backing(buttons: [&NSView; 3], is_key: bool) {
    use objc2::{rc::Retained, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSBox, NSBoxType, NSColor, NSTitlePosition};

    let Some(sv) = buttons[0].superview() else {
        return;
    };
    let color = match *BACKING_COLOR.lock().unwrap() {
        Some((r, g, b)) => NSColor::colorWithSRGBRed_green_blue_alpha(r, g, b, 1.0),
        None => NSColor::windowBackgroundColor(),
    };

    let mut existing: Vec<Retained<NSBox>> = sv
        .subviews()
        .iter()
        .filter_map(|s| s.downcast::<NSBox>().ok())
        .collect();

    for button in buttons {
        let frame = NSView::frame(button);
        let bx = match existing.pop() {
            Some(b) => b,
            None => {
                let Some(mtm) = MainThreadMarker::new() else {
                    return;
                };
                let b = NSBox::initWithFrame(NSBox::alloc(mtm), frame);
                b.setBoxType(NSBoxType::Custom);
                b.setBorderWidth(0.0);
                b.setTitlePosition(NSTitlePosition::NoTitle);
                sv.addSubview_positioned_relativeTo(&b, NSWindowOrderingMode::Below, None);
                b
            }
        };
        bx.setFrame(frame);
        // 짧은 변 기준 ½ 반경 — 버튼 프레임(14×16)에서 사실상 원/캡슐.
        bx.setCornerRadius(frame.size.width.min(frame.size.height) / 2.0);
        bx.setFillColor(&color);
        bx.setHidden(is_key);
        // 버튼이 항상 백킹 위에 오도록 백킹은 최하단 유지.
        if let Some(parent) = bx.superview() {
            parent.addSubview_positioned_relativeTo(&bx, NSWindowOrderingMode::Below, None);
        }
    }
}

// ── 계측(디버그 빌드 전용) ───────────────────────────────────────────────────

#[cfg(all(target_os = "macos", debug_assertions))]
unsafe fn dump_state(label: &str, window: &NSWindow) {
    use std::io::Write;

    fn line(name: &str, v: &NSView) -> String {
        let f = NSView::frame(v);
        format!(
            "{name}[{:?} hid={} a={:.2} x={:.0} y={:.0} w={:.0} h={:.0}]",
            v.class(),
            v.isHidden(),
            v.alphaValue(),
            f.origin.x,
            f.origin.y,
            f.size.width,
            f.size.height
        )
    }

    let mut parts: Vec<String> = Vec::new();
    for (name, kind) in [
        ("close", NSWindowButton::CloseButton),
        ("zoom", NSWindowButton::ZoomButton),
    ] {
        match window.standardWindowButton(kind) {
            Some(b) => parts.push(line(name, &b)),
            None => parts.push(format!("{name}[None]")),
        }
    }
    if let Some(close) = window.standardWindowButton(NSWindowButton::CloseButton) {
        if let Some(sv) = close.superview() {
            parts.push(line("sv", &sv));
            // sv(NSTitlebarView) 하위 전체 — 호버 캡슐/배경 뷰의 정체 추적.
            for (i, sub) in sv.subviews().iter().enumerate() {
                parts.push(line(&format!("sv.{i}"), &sub));
            }
            if let Some(container) = sv.superview() {
                parts.push(line("ctr", &container));
                for (i, sub) in container.subviews().iter().enumerate() {
                    if !std::ptr::eq(&*sub as *const NSView, &*sv as *const NSView) {
                        parts.push(line(&format!("ctr.{i}"), &sub));
                    }
                }
                // 형제 중 컨테이너의 z 순서(인덱스가 클수록 위) — 합성 순서 추적.
                if let Some(tf) = container.superview() {
                    let subs = tf.subviews();
                    let idx = subs.iter().position(|s| {
                        std::ptr::eq(&*s as *const NSView, &*container as *const NSView)
                    });
                    parts.push(format!("z={:?}/{}", idx, subs.len()));
                }
            }
        }
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() % 100_000_000)
        .unwrap_or(0);
    let text = format!(
        "{ts:>8} {label:>16} | key={} main={} winH={:.0} | {}\n",
        window.isKeyWindow(),
        window.isMainWindow(),
        window.frame().size.height,
        parts.join(" ")
    );
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/soksak-titlebar.log")
    {
        let _ = f.write_all(text.as_bytes());
    }
}

#[cfg(all(target_os = "macos", not(debug_assertions)))]
unsafe fn dump_state(_label: &str, _window: &NSWindow) {}
