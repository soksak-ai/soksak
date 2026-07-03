// macOS 신호등(트래픽 라이트) — webview 앱이라는 경계 때문에 생기는, 누구의
// 책임도 아닌 문제 두 가지에 대한 최소 보정. 위치의 단일 진실은 tauri.conf.json
// trafficLightPosition 이고, 이 모듈은 그것을 "유지"시키는 역할만 한다.
//
// 문제 1 — 위치 풀림(tauri#14072, 업스트림 버그):
//   정상 경로에선 wry(WryWebViewParent.drawRect)가 매 redraw 마다 inset 을
//   재적용하지만, unstable(child webview) 경로에선 창의 trafficLightPosition 이
//   자식 webview attributes 로 전파되지 않아 그 루프가 설치되지 않는다 → 키 상태
//   전환/리사이즈/전체화면 해제 때 AppKit 표준 재배치를 덮어쓸 주체가 없다.
//   치료: NSNotificationCenter 옵저버(becomeKey/resignKey/becomeMain/resignMain/
//   resize/exitFullScreen)에서 tao-0.35.3 inset_traffic_lights 와 동일 산식을
//   "동기" 재적용. (슬립 지연 재적용은 AppKit 후속 패스와 경쟁 — 폐기.)
//   업스트림이 #14072 를 고치면 이 재적용은 삭제 가능.
//
// 문제 2 — 비활성 유령(Apple 동작, 고칠 주체 없음):
//   비활성 회색 점은 backdrop 합성(뒤 픽셀 샘플링)으로 그려지는데, 뒤가
//   out-of-process WKWebView 레이어라 샘플링이 실패해 배경과 Δ2~3 의 유령이 된다.
//   계측으로 뷰 상태(hidden/alpha/frame/z)는 전부 정상임을 확인 — 그리기 단계 문제.
//   네이티브 앱의 전제(샘플링 가능한 backdrop) 밖이라 Apple 도 tauri 도 안 고친다.
//   치료: 버튼 프레임과 동일한 원형 백킹(테마색, 활성 시 숨김)을 점 바로 뒤에 공급.
//
// 절제 실험 기록(2026-06-12): 컨테이너 재배열·vibrancy/장식 뷰 숨김·폭 축소·
// hidden/alpha 복원은 전부 하중 없음이 실측돼 제거됨 — 유령은 "덮임"이 아니었고,
// 흰 캡슐은 재배열(자기 개입)이 노출시킨 것이었다. 이 모듈에 보정을 추가할 땐
// 반드시 빼고도 실측(활성/비활성 캡처 + 디버그 덤프)으로 하중을 증명할 것.
//
// 계측(디버그 빌드): 각 전환의 전/후 상태를 /tmp/soksak-titlebar.log 에 기록 —
// macOS 메이저 업데이트 후 회귀 진단의 1차 도구.

#[cfg(target_os = "macos")]
use objc2_app_kit::{NSView, NSWindow, NSWindowButton, NSWindowOrderingMode};

// 백킹 색(문제 2 — 머리말 참조). 프런트 테마 엔진이 titlebar_backing 으로 동기화,
// 미동기화 시 ensure_backing 이 시스템 windowBackgroundColor 로 폴백.
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

// 창 생성 시 즉시 1회 신호등 inset 적용(이후 유지는 앱 전역 옵저버가 담당). 좌표는 conf 값.
#[cfg(target_os = "macos")]
pub fn install<R: tauri::Runtime>(window: &tauri::Window<R>, x: f64, y: f64) {
    *INSET.lock().unwrap() = (x, y);
    let win = window.clone();
    let _ = window.run_on_main_thread(move || unsafe {
        let Ok(ptr) = win.ns_window() else { return };
        let ns = &*(ptr as *const NSWindow);
        apply_inset(ns, x, y);
        dump_state("install", ns);
    });
}

// 신호등 유지 옵저버 — 앱 전역 1회 설치(lib.rs setup). object:None 으로 *모든 창*의 통지를 받아 그
// 통지의 창에 inset 을 재적용한다(통지의 sender = 그 NSWindow). 과거엔 창마다 옵저버를 달고
// std::mem::forget 했는데(단일 창 가정), 멀티 윈도우에선 창을 닫아도 옵저버가 안 빠져 창마다 누적
// 누수였다. install_live_resize_monitor(webview.rs)와 동일 패턴 — 앱 전역 6개면 충분, 진짜 1회 leak.
#[cfg(target_os = "macos")]
pub fn install_global_observers(x: f64, y: f64) {
    use objc2_app_kit::{
        NSWindowDidBecomeKeyNotification, NSWindowDidBecomeMainNotification,
        NSWindowDidExitFullScreenNotification, NSWindowDidResignKeyNotification,
        NSWindowDidResignMainNotification, NSWindowDidResizeNotification,
    };
    use objc2_foundation::{NSNotification, NSNotificationCenter};

    let center = NSNotificationCenter::defaultCenter();
    // dump = 전/후 상태를 /tmp/soksak-titlebar.log 에 기록할지(디버그 빌드 한정). resize 는
    // 끈다 — 드래그/최대화 애니메이션 중 60~120Hz 로 통지가 오는데, dump_state 는 NSView
    // 서브트리 introspection + 매 호출 파일 open+write(메인 스레드 동기 I/O)라, 켜 두면
    // 리사이즈가 그 자체로 마비된다(실측: /tmp/soksak-titlebar.log 가 resize:before/after 로
    // 폭증, 내용·제스처 무관 버벅임의 원인). 신호등 inset 유지(apply_inset — 파일 I/O 없는
    // 가벼운 재배치)는 resize 에도 계속 돈다. 진단(포커스 전환 유령)은 becomeKey/resignKey/
    // becomeMain/resignMain 같은 저빈도 이벤트에서만 기록한다.
    let events: [(&'static str, bool, &'static objc2_foundation::NSNotificationName); 6] = unsafe {
        [
            ("becomeKey", true, NSWindowDidBecomeKeyNotification),
            ("resignKey", true, NSWindowDidResignKeyNotification),
            ("becomeMain", true, NSWindowDidBecomeMainNotification),
            ("resignMain", true, NSWindowDidResignMainNotification),
            ("resize", false, NSWindowDidResizeNotification),
            ("exitFullScreen", true, NSWindowDidExitFullScreenNotification),
        ]
    };

    for (label, dump, name) in events {
        let block = block2::RcBlock::new(move |note: std::ptr::NonNull<NSNotification>| {
            // 통지는 메인 스레드에서 게시된다(queue=None = 게시 스레드에서 실행).
            let note = unsafe { note.as_ref() };
            let Some(obj) = note.object() else { return };
            let Ok(ns) = obj.downcast::<NSWindow>() else { return };
            unsafe {
                if dump {
                    dump_state(&format!("{label}:before"), &ns);
                }
                apply_inset(&ns, x, y);
                if dump {
                    dump_state(&format!("{label}:after"), &ns);
                }
            }
        });
        let token = unsafe {
            // object:None = 모든 창의 통지. 통지 sender 로 대상 창을 판정(브라우저 자식 webview 창은
            // downcast::<NSWindow> 가 매칭되더라도 신호등 버튼이 없어 apply_inset 가 자연히 no-op).
            center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block)
        };
        // 앱 전역 6개 — 앱 수명 동안 유지(진짜 1회 leak, 창 수와 무관).
        std::mem::forget(token);
    }
}

// 위치 재적용(문제 1) + 원형 백킹 갱신(문제 2) — 통지마다 멱등 실행되는 단일 진입점.
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
