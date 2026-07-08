// 브라우저 패널: 메인 창 안에 child webview(WKWebView)를 임베드한다(iframe 아님 —
// X-Frame-Options 제약 없이 실제 브라우저). 링크 클릭은 webview 기본 동작이고,
// 이전/이후는 history.back()/forward() eval, URL 변화는 on_navigation 으로 프론트에
// emit(폴링 없음). 위치/크기는 프론트 레이아웃(slot rect)을 따라 webview_bounds 로 동기화.
//
// 레이어 원칙(z-순서 역전 + 투명 홀 + hitTest 위임 — mod layer):
// DOM(메인 webview)이 항상 최상위 레이어다. child webview 는 생성 직후 메인 아래로
// 내리고, 메인은 자체 배경을 칠하지 않아(CSS 투명 슬롯 = 홀) 아래 webview 가 비친다.
// 마우스는 hitTest 가 위임한다 — 홀 안 + 오버레이 없음이면 아래 webview 가 받는다.
// 그래서 모달/메뉴/드롭 인디케이터 등 모든 DOM 레이어가 브라우저 위에 그려진다
// (과거의 "오버레이 동안 브라우저 숨김(suppress)" 우회는 폐지).

use std::sync::atomic::{AtomicUsize, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl,
    WebviewWindowBuilder,
};

#[derive(Clone, Serialize)]
struct NavPayload {
    label: String,
    url: String,
}

// 새 링크(_blank/window.open)를 "앱 내 새 탭"으로 열 때 프론트로 보내는 페이로드.
// label = 이 이벤트를 emit 한 child webview 의 label — 플러그인 host 가 label 필터로 구독하므로
// (app.webview.on(label,"open-external")) 반드시 실어 보낸다(없으면 필터에서 드롭).
#[derive(Clone, Serialize)]
struct BrowserOpenPayload {
    label: String,
    url: String,
}

#[derive(Clone, Serialize)]
struct TitlePayload {
    label: String,
    title: String,
}

// 내장 브라우저 상태표시줄용 — 링크 hover 시 그 URL(링크를 벗어나면 빈 문자열).
#[cfg(target_os = "macos")]
#[derive(Clone, Serialize)]
struct StatusPayload {
    label: String,
    url: String,
}

// 페이지 로드 완료 시 WKWebView.title(문서 <title>)을 네이티브로 읽어 프론트로 emit.
// IPC/eval 없이 KVO 와 동일 원천(WKWebView.title) — 폴링 없음. 빈 제목은 보내지 않아
// 프론트가 호스트명 폴백을 유지한다.
#[cfg(target_os = "macos")]
fn emit_page_title<R: tauri::Runtime>(webview: &tauri::Webview<R>, label: &str) {
    let app = webview.app_handle().clone();
    let label = label.to_string();
    let _ = webview.with_webview(move |pw| unsafe {
        use objc2_web_kit::WKWebView;
        let wk = &*(pw.inner() as *const WKWebView);
        if let Some(t) = wk.title() {
            let title = t.to_string();
            if !title.is_empty() {
                let _ = app.emit("browser-title", TitlePayload { label, title });
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn emit_page_title<R: tauri::Runtime>(_webview: &tauri::Webview<R>, _label: &str) {}

// ── 상태표시줄(macOS): 내장 브라우저 링크 hover 통지 ──────────────────────────
// child webview(외부 사이트)엔 Tauri IPC 가 없으므로 WKScriptMessageHandler("soksakStatus")를
// 네이티브로 등록한다 — 내비게이션 마커 우회(soksak-popup.invalid)와 달리 페이지에 부작용이 없다.
// HOVER_SCRIPT 가 링크 href 를 postMessage 하면 받아 on_message(→ browser-status emit)로 넘긴다.
#[cfg(target_os = "macos")]
mod status {
    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, ProtocolObject};
    use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_foundation::{ns_string, NSObjectProtocol, NSString};
    use objc2_web_kit::{
        WKScriptMessage, WKScriptMessageHandler, WKUserContentController, WKWebView,
    };

    // 링크 hover 감지 — closest('a[href]').href 가 바뀔 때만 보낸다(스팸 방지). 링크를 벗어나면
    // 빈 문자열(상태표시줄 숨김). 핸들러 미등록(초기 레이스) 시 try/catch 로 조용히 무시.
    pub const HOVER_SCRIPT: &str = r#"
(function () {
  var last = null;
  var send = function (u) {
    try { window.webkit.messageHandlers.soksakStatus.postMessage(u || ""); } catch (_) {}
  };
  document.addEventListener("mouseover", function (e) {
    var t = e.target;
    var a = t && t.closest ? t.closest('a[href]') : null;
    var h = a ? a.href : "";
    if (h !== last) { last = h; send(h); }
  }, true);
})();
"#;

    pub struct StatusHandlerIvars {
        pub on_message: Box<dyn Fn(String)>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = StatusHandlerIvars]
        pub struct StatusHandler;

        unsafe impl NSObjectProtocol for StatusHandler {}

        unsafe impl WKScriptMessageHandler for StatusHandler {
            #[unsafe(method(userContentController:didReceiveScriptMessage:))]
            fn did_receive(
                this: &StatusHandler,
                _controller: &WKUserContentController,
                msg: &WKScriptMessage,
            ) {
                let body = unsafe { msg.body() };
                if let Ok(s) = body.downcast::<NSString>() {
                    (this.ivars().on_message)(s.to_string());
                }
            }
        }
    );

    // 브라우저 webview 의 userContentController 에 soksakStatus 핸들러를 등록한다(메인 스레드).
    // addScriptMessageHandler 가 핸들러를 retain → controller(=webview) 수명에 묶여 자동 해제.
    pub fn install(wk: &WKWebView, on_message: Box<dyn Fn(String)>) {
        let mtm = unsafe { MainThreadMarker::new_unchecked() };
        let controller = unsafe { wk.configuration().userContentController() };
        let handler = mtm
            .alloc::<StatusHandler>()
            .set_ivars(StatusHandlerIvars { on_message });
        let handler: Retained<StatusHandler> = unsafe { msg_send![super(handler), init] };
        let proto = ProtocolObject::from_ref(&*handler);
        unsafe {
            controller.addScriptMessageHandler_name(proto, ns_string!("soksakStatus"));
        }
    }
}

// DOM 오버레이 영역(사이드바 등) 사각형 — CSS 논리 px, top-left 원점(webview_bounds 와
// 동일 규약). 프론트가 getBoundingClientRect 로 측정해 webview_dom_holes 로 보고한다.
#[derive(Clone, Deserialize)]
pub(crate) struct Hole {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

// ── 레이어 정공법(macOS): z-순서 역전 + 투명 홀 + hitTest 위임 ────────────────
// Tauri 에는 webview z-order API 가 없으므로(docs.rs 실측) AppKit 수준에서 직접
// 수행한다 — webview.rs 의 기존 objc2 직접 호출(타이틀 KVO/eval/클릭 모니터)과
// 같은 층위. 홀의 단일 진실 = "보이는 child webview 의 frame" 그 자체라서 별도
// rect 레지스트리가 없다(set_position/set_size/hide 가 곧 홀 갱신).
#[cfg(target_os = "macos")]
mod layer {
    use std::collections::{HashMap, HashSet};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{LazyLock, Mutex};

    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Sel};
    use objc2::sel;
    use objc2_app_kit::{NSView, NSWindowOrderingMode};
    use objc2_foundation::{NSNumber, NSPoint, NSString};
    use tauri::Manager;

    // 창별 레이어 상태(멀티 윈도우): label → (그 창 메인 webview 의 NSView 포인터, 오버레이 게이트).
    // 각 창이 자기 메인 view 와 오버레이 상태를 독립 보유한다. hit_test 는 this(view)가 *어느 창의*
    // 메인인지 이 맵에서 판정하고, 홀 로직은 superview/형제 기준이라 창 독립적으로 그 창의 child
    // webview 만 검사한다 — 그래서 한 맵으로 모든 창이 서로 간섭 없이 동작한다.
    struct WinLayer {
        main_ptr: usize,             // 메인 webview NSView 포인터(창 수명 동안 불변)
        overlay: bool,               // 오버레이(모달/메뉴) 활성 시 홀 통과 차단
        holes: Vec<super::Hole>,     // DOM 오버레이(사이드바 등) 영역 — 이 안은 DOM 이 이벤트를 갖는다
        host_ptr: usize,             // 엔진 호스트 컨테이너 NSView 포인터(0=미생성). 격리 계약: 모듈은
                                     // contentView 가 아니라 이 컨테이너를 surface 로 받고 그 안에만 붙는다.
    }
    static LAYERS: LazyLock<Mutex<HashMap<String, WinLayer>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    // Backend N 네이티브 surface 레지스트리 — 등록된 child NSView 포인터 집합. hit_test 는 형제 중
    // 이 집합에 든 것만 "홀"로 본다(classname 대신 멤버십 — 엔진 중립: WKWebView·Chromium surface 동일
    // 취급). identity(포인터)만 저장하고 geometry 는 live frame(sub.frame())에서 읽는다 — "홀 = 보이는
    // child frame" 불변식 보존(별도 rect 레지스트리 없음).
    static SURFACES: LazyLock<Mutex<HashSet<usize>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
    // 교체 전 원본 hitTest IMP. 클래스(WryWebView) 단위 스위즐이라 앱 전역 1회면 충분.
    static ORIG_HIT_TEST: AtomicUsize = AtomicUsize::new(0);

    // 창의 오버레이 게이트 갱신(프론트 ui 카운터 0↔1 전이 시 webview_overlay_active 가 호출).
    pub fn set_overlay(label: &str, active: bool) {
        if let Ok(mut layers) = LAYERS.lock() {
            if let Some(w) = layers.get_mut(label) {
                w.overlay = active;
            }
        }
    }

    // 창의 DOM 오버레이 홀 갱신(사이드바 열림/닫힘·폭 변화 시 webview_dom_holes 가 호출).
    pub fn set_holes(label: &str, holes: Vec<super::Hole>) {
        if let Ok(mut layers) = LAYERS.lock() {
            if let Some(w) = layers.get_mut(label) {
                w.holes = holes;
            }
        }
    }

    // Backend N surface 등록/해제 — webview_open 직후(가시 홀 편입), webview_close 직전(회수).
    // 오프스크린 추출 webview(media_extract, -20000)는 홀이 아니므로 등록하지 않는다.
    pub fn register_surface(ptr: usize) {
        if let Ok(mut s) = SURFACES.lock() {
            s.insert(ptr);
        }
    }
    pub fn unregister_surface(ptr: usize) {
        if let Ok(mut s) = SURFACES.lock() {
            s.remove(&ptr);
        }
    }

    type HitTestFn = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, NSPoint) -> *mut AnyObject;

    // hitTest: 교체 구현. 클래스(WryWebView) 단위 스위즐이므로 모든 webview 가
    // 거치지만 메인 뷰만 홀 로직을 탄다 — isa-swizzle(인스턴스 클래스 교체)은
    // AppKit 의 클래스 기반 design-property 조회(NSDP)가 런타임 서브클래스에서
    // assert 로 SIGABRT 를 내므로 금지(실측: <select> 팝업 attachPopUpWithFrame
    // 경로 크래시). 클래스 정체성은 절대 바꾸지 않는다.
    //
    // AppKit 은 부모가 서브뷰를 앞→뒤로 hitTest 하고 첫 비-nil 이 이긴다 —
    // 메인(최상위)이 nil 을 돌려주면 같은 지점의 아래 child webview 가 자연히
    // 수신한다. point 는 superview 좌표계(형제 frame 과 동일 공간)이므로 변환
    // 없이 비교한다. 메인 스레드에서만 호출된다(AppKit).
    unsafe extern "C-unwind" fn hit_test(
        this: *mut AnyObject,
        cmd: Sel,
        point: NSPoint,
    ) -> *mut AnyObject {
        let orig: HitTestFn = std::mem::transmute(ORIG_HIT_TEST.load(Ordering::Relaxed));
        let default = orig(this, cmd, point);
        // this 가 *어느 창의* 메인 view 인가 + 그 창 오버레이 활성/홀? 미등록(child/팝업)이거나
        // 맵 poisoned 면 원본 동작. (마우스 이벤트마다 호출 — lock 은 짧고 창 수는 적다.)
        // overlay 와 holes(클론)를 lock 한 번에 같이 꺼낸다.
        let (overlay, holes, host_ptr) = {
            let Ok(layers) = LAYERS.lock() else {
                return default;
            };
            match layers.values().find(|w| w.main_ptr == this as usize) {
                None => return default, // child/팝업 webview — 원본 동작 그대로.
                Some(w) => (w.overlay, w.holes.clone(), w.host_ptr),
            }
        };
        // 등록된 Backend N surface 스냅샷(마우스 이벤트마다 — 탭 수만큼 작음, holes.clone 과 동일 층위).
        let surfaces = SURFACES.lock().ok().map(|s| s.clone()).unwrap_or_default();
        if default.is_null() || overlay {
            return default;
        }
        let view = &*(this as *const NSView);
        let Some(superview) = view.superview() else {
            return default;
        };
        // 사이드바 등 DOM 오버레이 영역은 풀사이즈 브라우저 위에 떠 있어도 DOM 이 이벤트를
        // 갖는다(스크롤이 브라우저로 새지 않음). 홀 안이면 default(메인 webview)를 그대로
        // 돌려줘 DOM 이 이벤트를 받는다. holes 는 메인 webview 콘텐츠 기준 CSS 논리 px(top-left,
        // webview_bounds 와 동일 규약)이고, point 는 superview 좌표계이므로 mf(메인 frame)를
        // 통해 변환한다. mf 는 메인 webview 콘텐츠 전 영역이다.
        let mf = view.frame();
        let flipped = superview.isFlipped();
        for hole in holes.iter() {
            let xlo = mf.origin.x + hole.x;
            let xhi = mf.origin.x + hole.x + hole.w;
            // y 변환: superview 가 flipped(top-left 원점)면 hole.y 를 그대로 더한다.
            // AppKit 기본(non-flipped, bottom-left 원점)이면 콘텐츠 상단이 mf 의 위쪽 변
            // (mf.origin.y + mf.size.height)이므로 거기서 hole.y/hole.y+h 를 빼 뒤집는다.
            let (ylo, yhi) = if flipped {
                (mf.origin.y + hole.y, mf.origin.y + hole.y + hole.h)
            } else {
                let y_high = mf.origin.y + mf.size.height - hole.y;
                let y_low = mf.origin.y + mf.size.height - (hole.y + hole.h);
                (y_low, y_high)
            };
            if point.x >= xlo && point.x < xhi && point.y >= ylo && point.y < yhi {
                return default;
            }
        }
        // 등록된 surface 가 point 를 덮으면 null 반환(형제 stack 아래 child 가 이벤트 수신). surface 는
        // ① contentView 직속 형제(레거시/코어 webview) ② 엔진 호스트 컨테이너 안(격리 계약)에 있을 수
        // 있다. 두 곳 모두 검사한다. 컨테이너는 contentView 전체크기·원점(0,0)이라 그 안 surface 의 frame
        // 은 contentView(=point) 좌표와 identity — 형제와 동일 비교식이 성립한다.
        let hit = |parent: &NSView| -> bool {
            for sub in parent.subviews().iter() {
                if Retained::as_ptr(&sub) as *mut AnyObject == this || sub.isHidden() {
                    continue;
                }
                if !surfaces.contains(&(Retained::as_ptr(&sub) as usize)) {
                    continue;
                }
                let f = sub.frame();
                if point.x >= f.origin.x
                    && point.x < f.origin.x + f.size.width
                    && point.y >= f.origin.y
                    && point.y < f.origin.y + f.size.height
                {
                    return true;
                }
            }
            false
        };
        if hit(&superview) {
            return std::ptr::null_mut();
        }
        if host_ptr != 0 {
            let host = &*(host_ptr as *const NSView);
            if hit(host) {
                return std::ptr::null_mut();
            }
        }
        default
    }

    // 메인 webview 에 1회 설치: ① 자체 배경 비활성(KVC drawsBackground=false —
    // wry 의 transparent 경로와 동일 기법; CSS 불투명 표면은 그대로 그려지고
    // 투명 슬롯만 아래가 비친다) ② hitTest 메서드 스위즐(클래스 단위, 위 주석).
    pub fn install(app: &tauri::AppHandle, label: &str) {
        let Some(wv) = app.get_webview(label) else {
            eprintln!("[layer] {label} webview 없음 — 레이어 역전 미설치");
            return;
        };
        let label = label.to_string();
        let _ = wv.with_webview(move |pw| unsafe {
            let obj = pw.inner() as *mut AnyObject;
            if let Ok(mut layers) = LAYERS.lock() {
                layers.insert(
                    label,
                    WinLayer {
                        main_ptr: obj as usize,
                        overlay: false,
                        holes: Vec::new(),
                        host_ptr: 0,
                    },
                );
            }

            let no = NSNumber::new_bool(false);
            let key = NSString::from_str("drawsBackground");
            let _: () = msg_send![&*obj, setValue: Some(&*no as &AnyObject), forKey: &*key];

            // hitTest 스위즐 — 클래스(WryWebView) 단위라 앱 전역 1회면 모든 창 webview 가 거친다.
            // 원본 IMP 를 보관하고 같은 타입 인코딩으로 교체. 이미 설치됐으면(ORIG≠0) 건너뛴다.
            if ORIG_HIT_TEST.load(Ordering::Relaxed) != 0 {
                return;
            }
            let cls = (*obj).class();
            let sel = sel!(hitTest:);
            let Some(method) = cls.instance_method(sel) else {
                eprintln!("[layer] hitTest 메서드 없음 — 홀 위임 미설치");
                return;
            };
            ORIG_HIT_TEST.store(method.implementation() as usize, Ordering::Relaxed);
            objc2::ffi::class_replaceMethod(
                (cls as *const objc2::runtime::AnyClass).cast_mut(),
                sel,
                std::mem::transmute::<HitTestFn, objc2::runtime::Imp>(hit_test),
                objc2::ffi::method_getTypeEncoding(method as *const objc2::runtime::Method),
            );
        });
    }

    // 엔진 호스트 컨테이너 취득(격리 계약) — 창 label 의 contentView 안, 메인 webview 아래에 코어 소유
    // 전체크기 NSView 를 1회 생성해 그 포인터를 반환한다. 모듈은 이 컨테이너를 surface 로 받아 그 안에만
    // child/레이어를 붙인다 → 모듈 결함의 피해가 컨테이너로 국한되고 contentView(=코어 소유)는 불가침.
    // **메인 스레드에서만 호출**(NSView 생성/삽입). 미설치 창(WinLayer 없음)·실패 시 None → 호출부가
    // contentView 폴백(격리는 심층방어라, 폴백 시 hitTest 형제 경로가 그대로 동작한다).
    #[cfg(target_os = "macos")]
    pub fn ensure_engine_host(label: &str) -> Option<usize> {
        use objc2::MainThreadOnly; // NSView::alloc(mtm) 제공.
        use objc2_app_kit::NSAutoresizingMaskOptions;
        let mtm = objc2_foundation::MainThreadMarker::new()?; // 메인 스레드 계약 확인.
        unsafe {
            let main_ptr = {
                let layers = LAYERS.lock().ok()?;
                let w = layers.get(label)?;
                if w.host_ptr != 0 {
                    return Some(w.host_ptr); // 이미 생성됨(멱등).
                }
                w.main_ptr
            };
            if main_ptr == 0 {
                return None;
            }
            let main_view = &*(main_ptr as *const NSView);
            let content = main_view.superview()?; // contentView(코어 소유) — 컨테이너의 부모.
            let bounds = content.bounds();
            let host = NSView::initWithFrame(NSView::alloc(mtm), bounds);
            // 컨테이너는 콘텐츠 전면을 채우고 리사이즈를 따라간다(원점 0,0 유지 → 좌표 identity).
            host.setAutoresizingMask(
                NSAutoresizingMaskOptions::ViewWidthSizable
                    | NSAutoresizingMaskOptions::ViewHeightSizable,
            );
            // 메인 webview 아래(형제 최하단)에 삽입 — DOM 이 항상 위, 엔진 콘텐츠가 그 아래로 비친다.
            content.addSubview_positioned_relativeTo(
                &host,
                NSWindowOrderingMode::Below,
                Some(main_view),
            );
            let host_ptr = Retained::as_ptr(&host) as usize;
            // Retained 를 leak 해 컨테이너 수명을 뷰 계층에 위임(창이 소유; 창 파괴 시 함께 해제).
            std::mem::forget(host);
            if let Ok(mut layers) = LAYERS.lock() {
                if let Some(w) = layers.get_mut(label) {
                    w.host_ptr = host_ptr;
                }
            }
            Some(host_ptr)
        }
    }

    // child webview 를 메인(DOM) 아래로 강하. add_child 는 최상위에 붙이므로
    // 생성 직후 1회 호출한다. 기존 서브뷰에 addSubview:positioned:relativeTo: 를
    // 호출하면 제거 후 재삽입(AppKit 표준 동작)으로 순서만 바뀐다.
    pub fn lower_below_main<R: tauri::Runtime>(webview: &tauri::Webview<R>, label: &str) {
        let label = label.to_string();
        let _ = webview.with_webview(move |pw| unsafe {
            let main_ptr = LAYERS
                .lock()
                .ok()
                .and_then(|l| l.get(&label).map(|w| w.main_ptr))
                .unwrap_or(0);
            if main_ptr == 0 {
                return;
            }
            let child = &*(pw.inner() as *const NSView);
            let main_view = &*(main_ptr as *const NSView);
            let (Some(child_sv), Some(main_sv)) = (child.superview(), main_view.superview())
            else {
                return;
            };
            // 형제가 아니면(계층 가정 위반) 건드리지 않는다 — 진단만 남김.
            if Retained::as_ptr(&child_sv) != Retained::as_ptr(&main_sv) {
                eprintln!("[layer] child 와 main 이 형제가 아님 — z-순서 강하 생략");
                return;
            }
            child_sv.addSubview_positioned_relativeTo(
                child,
                NSWindowOrderingMode::Below,
                Some(main_view),
            );
        });
    }

    // 실측 프로브: contentView 서브뷰 트리 덤프(클래스/frame/hidden) — 계층
    // 가정(형제 구조·순서)의 검증·진단용.
    pub fn dump_view(view: &NSView, depth: usize, out: &mut String) {
        let f = view.frame();
        let _ = std::fmt::Write::write_fmt(
            out,
            format_args!(
                "{}{} frame=({}, {}, {}, {}) hidden={} ptr={:p}\n",
                "  ".repeat(depth),
                view.class().name().to_string_lossy(),
                f.origin.x,
                f.origin.y,
                f.size.width,
                f.size.height,
                view.isHidden(),
                view as *const NSView,
            ),
        );
        if depth >= 3 {
            return;
        }
        for sub in view.subviews().iter() {
            dump_view(&sub, depth + 1, out);
        }
    }
}

// 엔진 사이드카의 native surface 를 레이어 시스템(SURFACES — hitTest 위임)에 편입/해제.
// 엔진이 surface-created/destroyed 호스트 사실을 emit 하면 sidecar.rs 가 여기로 relay 한다.
// 코어는 의미를 모른다 — 포인터 멤버십만 관리(엔진 중립: WKWebView·Chromium 동일 취급).
#[cfg(target_os = "macos")]
pub(crate) fn register_engine_surface(ptr: usize) {
    layer::register_surface(ptr);
}
#[cfg(target_os = "macos")]
pub(crate) fn unregister_engine_surface(ptr: usize) {
    layer::unregister_surface(ptr);
}
// 엔진 호스트 컨테이너 취득(격리 계약) — sidecar content_view_of 가 모듈 surface 로 넘긴다.
// 메인 스레드 전용(NSView 생성). 미설치 창·실패 시 None(호출부가 contentView 폴백).
#[cfg(target_os = "macos")]
pub(crate) fn layer_ensure_engine_host(label: &str) -> Option<usize> {
    layer::ensure_engine_host(label)
}

// 오버레이(모달/메뉴/드롭다운) 상태 동기화 — 프론트 ui 스토어 카운터가 0↔1 을
// 넘을 때 호출한다. true 면 홀 마우스 통과 차단(hitTest 가 DOM 에 우선권).
#[tauri::command]
pub fn webview_overlay_active(window: tauri::Window, active: bool) {
    // window = 호출 창(MW2 — 자동 인지). 그 창의 오버레이 게이트만 갱신(프론트 label 전달 불요).
    #[cfg(target_os = "macos")]
    layer::set_overlay(window.label(), active);
    // 엔진 사이드카(예: Chromium)의 native child 는 코어 layer 시스템 밖이라 오버레이 시 DOM 모달
    // 위로 뚫고 올라온다 → 같은 호스트 사실(surface-occluded)을 로드된 모듈 전부에 통지해 모듈이
    // 자기 surface 를 숨김/복원한다(코어는 의미 모름, relay 만). 로드 모듈 0 이면 no-op.
    crate::sidecar::notify_all(&serde_json::json!({
        "type": "surface-occluded",
        "window": window.label(),
        "occluded": active,
    }));
    #[cfg(not(target_os = "macos"))]
    let _ = (window, active);
}

// 패널 디바이더 드래그 제스처 릴레이 — 프론트(GroupArea)가 드래그 시작/끝에 호출한다.
// 코어 layer 안의 child(WKWebView)는 DOM freeze-frame 이 위에서 덮으므로 조치 불요하나,
// 엔진 사이드카(CEF) surface 는 코어 layer 밖(DOM 위)이라 모듈이 직접 숨김/유예해야 한다
// → 같은 호스트 사실을 로드된 모듈 전부에 통지(webview_overlay_active 와 동형, relay 만).
#[tauri::command]
pub fn webview_resize_gesture(window: tauri::Window, active: bool) {
    crate::sidecar::notify_all(&serde_json::json!({
        "type": "resize-gesture",
        "window": window.label(),
        "active": active,
    }));
}

// DOM 오버레이 홀 동기화 — 프론트가 사이드바 열림/닫힘·폭 변화·창 리사이즈 시 측정해 보고.
// 닫힘이면 빈 배열을 보내 홀을 비운다. holes 안은 풀사이즈 브라우저 위라도 DOM 이 받는다.
#[tauri::command]
pub fn webview_dom_holes(window: tauri::Window, holes: Vec<Hole>) {
    // window = 호출 창(자동 인지). 그 창의 홀만 갱신(프론트 label 전달 불요).
    #[cfg(target_os = "macos")]
    layer::set_holes(window.label(), holes);
    #[cfg(not(target_os = "macos"))]
    let _ = (window, holes);
}

// 실측 프로브: 메인 창 뷰 계층 덤프(레이어 가정 검증·진단용).
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn webview_debug_hierarchy(window: tauri::Window) -> Result<String, String> {
    use std::sync::mpsc;
    use std::time::Duration;

    // window = 호출 창(MW2). 그 창의 뷰 계층을 덤프 — 소켓이 emit_to 로 타겟 창에 보내므로 자동.
    let (tx, rx) = mpsc::sync_channel::<String>(1);
    let win = window.clone();
    window
        .run_on_main_thread(move || {
            let mut out = String::new();
            unsafe {
                if let Ok(ns) = win.ns_window() {
                    let win_obj = &*(ns as *const objc2::runtime::AnyObject);
                    let content: *mut objc2_app_kit::NSView =
                        objc2::msg_send![win_obj, contentView];
                    if !content.is_null() {
                        layer::dump_view(&*content, 0, &mut out);
                    }
                }
            }
            let _ = tx.try_send(out);
        })
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(3))
            .map_err(|_| "계층 덤프 시간 초과".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn webview_debug_hierarchy(_app: AppHandle) -> Result<String, String> {
    Err("webview_debug_hierarchy 는 현재 macOS 전용".into())
}

// 한 창의 webview 에 레이어 역전 설치 — setup(main)·새 창 생성 시 그 창 label 로 호출.
#[cfg(target_os = "macos")]
pub fn install_layer_inversion(app: &AppHandle, label: &str) {
    layer::install(app, label);
}

static POPUP_SEQ: AtomicUsize = AtomicUsize::new(1);
const POPUP_MARKER_HOST: &str = "soksak-popup.invalid";

// 새 창 요청(target=_blank / window.open)을 마커 네비게이션으로 바꾼다. 외부 페이지는
// Tauri IPC 권한이 없으므로(주면 보안 구멍) "네비게이션" 자체를 채널로 쓴다 —
// on_navigation 이 마커를 감지해 차단하고 내장 브라우저 새 창(독립 OS 윈도우)을 연다.
const NEW_WINDOW_NAV: &str = r#"
(function () {
  var pop = function (u) {
    try {
      if (u) location.href = "https://soksak-popup.invalid/?u=" + encodeURIComponent(u);
    } catch (_) {}
  };
  window.open = function (u, target) {
    var tg = (target || "").toString().toLowerCase();
    if (u && (tg === "_self" || tg === "_top" || tg === "_parent")) { try { location.href = u; } catch (_) {} return window; }
    pop(u); return null;
  };
  document.addEventListener("click", function (e) {
    var t = e.target;
    var a = t && t.closest ? t.closest('a[target="_blank"]') : null;
    if (a && a.href) { e.preventDefault(); pop(a.href); }
  }, true);
})();
"#;

// 범용 미디어 스니프 — 페이지가 스스로 요청하는 미디어 URL(m3u8/mpd/mp4/...)을 패시브 기록한다.
// init script 라 페이지 스크립트보다 먼저 돌아 로드 시점의 요청까지 잡는다. 사이트 지식 0(어떤 페이지든
// 자기 미디어를 요청하면 기록 — 난독화·차단과 무관, 디코드 불요). 기록만 하고 동작은 안 바꾼다(near-zero
// 비용). 소비자는 window.__soksakMedia 를 webview_eval 로 읽는다(browser.media.sniff). 재사용 substrate.
const MEDIA_SNIFF: &str = r#"
(function () {
  if (window.__soksakMedia) return;
  var seen = {}, list = [];
  window.__soksakMedia = list;
  var RE = /\.(m3u8|mpd|mp4|m4s|webm|ts)(\?|#|$)/i;
  function add(u, via) {
    try {
      if (!u || typeof u !== 'string') return;
      if (u.indexOf('//') === 0) u = location.protocol + u;
      else if (u.charAt(0) === '/') u = location.origin + u;
      else if (!/^https?:/i.test(u)) return;
      if (!RE.test(u)) return;
      if (seen[u]) return;
      seen[u] = 1;
      list.push({ url: u, via: via, ref: location.href });
    } catch (_) {}
  }
  try {
    var ox = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) { add(u, 'xhr'); return ox.apply(this, arguments); };
  } catch (_) {}
  try {
    var of = window.fetch;
    if (of) window.fetch = function (i) {
      try { add(typeof i === 'string' ? i : (i && i.url), 'fetch'); } catch (_) {}
      return of.apply(this, arguments);
    };
  } catch (_) {}
  try {
    var mo = new MutationObserver(function (muts) {
      for (var a = 0; a < muts.length; a++) {
        var ns = muts[a].addedNodes || [];
        for (var b = 0; b < ns.length; b++) {
          var n = ns[b];
          if (!n || !n.tagName) continue;
          if ((n.tagName === 'VIDEO' || n.tagName === 'SOURCE') && n.src) add(n.src, n.tagName.toLowerCase());
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}
})();
"#;

// 마커 네비게이션이면 새 창으로 열 대상 URL 을 추출(query_pairs 가 percent-decode).
fn popup_target(url: &Url) -> Option<Url> {
    if url.host_str() != Some(POPUP_MARKER_HOST) {
        return None;
    }
    let u = url.query_pairs().find(|(k, _)| k == "u")?.1.into_owned();
    Url::parse(&u).ok()
}

// 내장 브라우저 새 창(독립 OS 윈도우). 새 창 안의 _blank 도 다시 새 창(재귀).
fn open_popup(app: &AppHandle, url: Url) {
    let label = format!("popup-{}", POPUP_SEQ.fetch_add(1, Ordering::Relaxed));
    let title = url.host_str().unwrap_or("browser").to_string();
    let nav_app = app.clone();
    let result = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title(title)
        .inner_size(1100.0, 800.0)
        .initialization_script(NEW_WINDOW_NAV)
        .on_navigation(move |u| {
            if let Some(target) = popup_target(u) {
                open_popup(&nav_app, target);
                return false;
            }
            true
        })
        .build();
    if let Err(e) = result {
        eprintln!("popup 창 생성 실패: {e}");
    }
}

// child webview 생성(이미 있으면 무시). label = "b-<windowLabel>-<viewId>"(프론트 webviewLabels 단일
// 진실이 창 네임스페이스로 만든다 — Tauri webview label 은 앱 전역 유일해야 하므로 창별 viewId 만으론
// 충돌). Rust 는 그 label 을 받아 add_child 할 뿐 형식은 프론트가 소유.
#[tauri::command]
pub fn webview_open(
    app: AppHandle,
    window: tauri::Window,
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
    // window = 이 명령을 invoke 한 창(MW2 — Tauri 가 호출 창을 주입). 그 창에 child webview 를
    // 붙이므로 멀티 윈도우에서 BrowserView 가 실행된 창에 정확히 들어간다(프론트 label 전달 불요).
    let parsed = Url::parse(&url).map_err(|e| e.to_string())?;
    let nav_app = app.clone();
    let nav_label = label.clone();
    let pl_app = app.clone();
    let pl_label = label.clone();
    // 상태표시줄용 hover 스크립트를 함께 주입(macOS — 메시지 핸들러가 받는다). 비-macOS 는 생략.
    #[cfg(target_os = "macos")]
    let init_script = format!("{NEW_WINDOW_NAV}\n{MEDIA_SNIFF}\n{}", status::HOVER_SCRIPT);
    #[cfg(not(target_os = "macos"))]
    let init_script = format!("{NEW_WINDOW_NAV}\n{MEDIA_SNIFF}");
    let builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .initialization_script(init_script)
        // 새 창 마커(_blank 등)는 차단하고 내장 브라우저 새 창으로. URL 동기화는 여기서 하지 않는다 —
        // on_navigation 은 iframe 등 서브프레임 내비게이션에도 발화하고(wry 가 프레임 정보를 주지 않아
        // 메인/서브 구분 불가) 그러면 주소창이 서브프레임 URL(예: 구글 ogs 위젯)로 오염된다.
        // 주소창은 메인프레임 전용 신호인 on_page_load 로만 갱신한다.
        .on_navigation(move |url| {
            if let Some(target) = popup_target(url) {
                // 마커 가로채기는 항상 차단(false). 새 탭/새 창 분기는 프론트 설정이
                // 소유하므로 여기선 무조건 emit — 프론트가 browserNewWindow 로 라우팅한다.
                let _ = nav_app.emit(
                    "browser-open-external",
                    BrowserOpenPayload {
                        label: nav_label.clone(),
                        url: target.to_string(),
                    },
                );
                return false;
            }
            true // 허용
        })
        // 메인프레임 커밋/완료(didCommit/didFinish) 시점의 URL 만 주소창에 반영 — 서브프레임은 안 온다.
        // about:blank 는 WKWebView 초기화 중간 단계라 제외. 완료 시 문서 <title> 도 함께 emit.
        .on_page_load(move |webview, payload| {
            let u = payload.url().as_str();
            if u != "about:blank" {
                let _ = pl_app.emit(
                    "browser-nav",
                    NavPayload {
                        label: pl_label.clone(),
                        url: u.to_string(),
                    },
                );
            }
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                emit_page_title(&webview, webview.label());
            }
        });
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(w, h),
        )
        .map_err(|e| e.to_string())?;
    // 레이어 원칙: child 는 DOM(부모 창 메인 webview) 아래 — 생성 직후 z-순서 강하.
    #[cfg(target_os = "macos")]
    {
        layer::lower_below_main(&webview, window.label());
        // 상태표시줄: 링크 hover → browser-status emit. 메시지 핸들러를 이 webview 에 등록.
        let st_app = app.clone();
        let st_label = label.clone();
        let _ = webview.with_webview(move |pw| {
            use objc2_web_kit::WKWebView;
            // Backend N 레지스트리 등록 — 이 child 가 hit_test 의 "홀"이 된다(NSView 포인터 = 형제 비교 키).
            layer::register_surface(pw.inner() as usize);
            let wk = unsafe { &*(pw.inner() as *const WKWebView) };
            status::install(
                wk,
                Box::new(move |url| {
                    let _ = st_app.emit(
                        "browser-status",
                        StatusPayload {
                            label: st_label.clone(),
                            url,
                        },
                    );
                }),
            );
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = webview;
    Ok(())
}

// native 마우스 브릿지(App 의 native-mousedown/move/up)를 소켓으로 구동 — 브라우저(네이티브 child)
// 위 divider 드래그를 실제 마우스 없이 E2E 자가검증한다(ui.input.drag 와 짝: 이건 native 경로,
// 그건 DOM 경로). kind = native-mousedown | native-mousemove | native-mouseup. 전역 emit —
// App 의 getCurrentWebviewWindow().listen 은 전역 이벤트도 받는다.
#[tauri::command]
pub fn webview_emit_native(window: tauri::Window, kind: String, x: f64, y: f64) {
    use tauri::Emitter;
    let _ = window.app_handle().emit(&kind, serde_json::json!({ "x": x, "y": y }));
}

// hover 중인 divider(리사이즈 경계) 강조 — 프론트가 그 요소의 화면 rect 를 넘기면 코어가 accent 바를
// 브라우저 위 네이티브 레이어에 그린다(rect=None → 숨김). 네이티브 child 위에서도 보이는 유일한 길.
#[derive(Deserialize)]
pub struct HlRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}
#[tauri::command]
pub fn webview_divider_highlight(window: tauri::Window, rect: Option<HlRect>) {
    #[cfg(target_os = "macos")]
    {
        let app = window.app_handle().clone();
        set_divider_highlight(
            &app,
            window.label().to_string(),
            rect.map(|r| (r.x, r.y, r.w, r.h)),
        );
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, rect);
    }
}

// bounds 기반 가시성 동기화 상태 — 마지막으로 적용한 visible 값(라벨별). 변화시에만 show/hide
// 를 호출한다(bounds 는 드래그 중 ~30Hz — 매번 show 하면 WebKit 재합성 낭비). webview_close 가
// 지운다(라벨 재사용 시 stale 판정 방지).
static BOUNDS_VIS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, bool>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

// 패널 레이아웃 변화(분할/리사이즈/이동)에 맞춰 위치/크기 동기화.
//
// 가시성은 기하가 결정한다: frame 이 창과 전혀 겹치지 않으면(비활성 탭 파킹 = 화면 밖 이동,
// layerPark.ts) 그 웹뷰는 사실상 안 보이는데, WKWebView 는 창 소속만으로 visible 로 판정해
// 페이지가 visibilitychange(hidden) 를 받지 못하고 풀스피드로 돈다(실측: 비활성 브라우저 탭의
// 광고·애니메이션이 상시 CPU ~10%). 교집합에 따라 hide/show 를 동기화해 웹 표준 시맨틱을
// 복원한다 — 페이지 스스로 백그라운드 스로틀에 들어간다(임의 스로틀 발명이 아니라 사실 전달).
// 의도적 오프스크린 웹뷰(media_extract)는 bounds 를 쓰지 않으므로 영향 없음.
#[tauri::command]
pub fn webview_bounds(
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
        let win = wv.window();
        if let (Ok(size), Ok(scale)) = (win.inner_size(), win.scale_factor()) {
            let (ww, wh) = (size.width as f64 / scale, size.height as f64 / scale);
            let visible = x + w > 0.0 && y + h > 0.0 && x < ww && y < wh;
            let mut map = BOUNDS_VIS.lock().unwrap();
            if map.get(&label).copied() != Some(visible) {
                if visible {
                    wv.show().map_err(|e| e.to_string())?;
                } else {
                    wv.hide().map_err(|e| e.to_string())?;
                }
                map.insert(label, visible);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn webview_navigate(app: AppHandle, label: String, url: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        wv.navigate(Url::parse(&url).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// 인스펙트(devtools) 토글 — 이 브라우저 child webview 의 Web Inspector 를 연다/닫는다.
// WKWebView 는 CDP 가 없어 OS 인스펙터(WebKit Web Inspector)가 뜬다. devtools = debug 빌드 또는 devtools feature.
// **반드시 별도 창**: wry open_devtools 는 [_inspector show] 만 호출 → WebKit 이 마지막 도킹 상태를 기억해
// 브라우저 패널 '안'에 도킹돼 뜰 때가 있다. show 직후 [_inspector detach] 를 보내 항상 떼어낸 창으로 강제한다.
// 반환 = 토글 후 열림 여부(UI 버튼 on 동기화).
#[tauri::command]
pub fn webview_devtools(app: AppHandle, label: String) -> Result<bool, String> {
    if let Some(wv) = app.get_webview(&label) {
        if wv.is_devtools_open() {
            wv.close_devtools();
            Ok(false)
        } else {
            wv.open_devtools(); // [_inspector show] — 비동기(프론트엔드 로드). 마지막 도킹 상태로 뜸.
            #[cfg(target_os = "macos")]
            {
                // [_inspector detach] — 도킹 해제(반드시 별도 창, _WKInspector WebKit SPI). show 가 비동기라
                // 인스펙터가 연결된 뒤 떼어내야 한다 → 잠깐 대기 후 detach(with_webview 가 메인스레드 디스패치).
                let wv2 = wv.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(450));
                    let _ = wv2.with_webview(|pw| unsafe {
                        use objc2::runtime::AnyObject;
                        use objc2::{msg_send, rc::Retained};
                        let wk = pw.inner() as *mut AnyObject;
                        let inspector: Retained<AnyObject> = msg_send![&*wk, _inspector];
                        let () = msg_send![&inspector, detach];
                    });
                });
            }
            Ok(true)
        }
    } else {
        Ok(false)
    }
}

// 이전/이후: webview 세션 히스토리. 호출부는 전부 delta ±1(back/forward 버튼) — WKWebView.goBack/
// goForward 네이티브를 직접 호출한다(eval 미경유, JS 가 멈춰도 동작). Tauri 는 크로스플랫폼 history
// API 를 노출하지 않아 non-macos 는 플랫폼 native(WebView2/WebKitGTK) 배선 전까지 DOM history.go 로
// 폴백한다 — delta 는 타입드 i32 라 인젝션 표면이 없다(문자열 조립 아님, 정수 파라미터).
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn webview_history(app: AppHandle, label: String, delta: i32) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        wv.with_webview(move |pw| unsafe {
            use objc2_web_kit::WKWebView;
            let wk = &*(pw.inner() as *const WKWebView);
            if delta < 0 {
                let _ = wk.goBack();
            } else if delta > 0 {
                let _ = wk.goForward();
            }
        })
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// non-macos 폴백(플랫폼 native 미배선) — WebView2 ICoreWebView2::GoBack/GoForward, WebKitGTK
// webkit_web_view_go_back/forward 를 그 플랫폼에서 빌드·검증할 때 native 로 전환한다.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn webview_history(app: AppHandle, label: String, delta: i32) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        wv.eval(format!("history.go({delta})"))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// 탭/뷰 전환 시 표시/숨김(native 레이어는 DOM 위에 떠서 CSS visibility 가 안 닿는다).
#[tauri::command]
pub fn webview_visible(app: AppHandle, label: String, visible: bool) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        if visible {
            wv.show().map_err(|e| e.to_string())?;
            // 포커스를 임의로 옮기지 않는다 — 부모 창이 이미 활성일 때만 webview 에 포커스를 준다.
            // hide→show 첫 클릭 무시 방지는 활성 창 안(탭 전환)에서만 필요하고, 백그라운드 창의
            // 뷰 mount(부팅 리스폰·플러그인 활성화 ~수초 뒤)가 그 창을 앞으로 끌어오는 지연 포커스
            // 탈취를 없앤다. set_focus 는 child webview 지만 macOS 에서 부모 창을 key 로 만든다.
            if wv.window().is_focused().unwrap_or(false) {
                let _ = wv.set_focus();
            }
        } else {
            wv.hide().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// 뷰가 영구히 닫힐 때 webview 정리.
#[tauri::command]
pub fn webview_close(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        // Backend N 레지스트리 회수 — close 전에 surface 포인터를 집합에서 제거(위생; 미제거여도
        // 형제 순회가 live subview 만 보므로 자가치유되나 누수 방지).
        #[cfg(target_os = "macos")]
        {
            let _ = wv.with_webview(|pw| layer::unregister_surface(pw.inner() as usize));
        }
        wv.close().map_err(|e| e.to_string())?;
    }
    BOUNDS_VIS.lock().unwrap().remove(&label);
    Ok(())
}

// 숨김 미디어 추출 — 오프스크린 child webview 를 잠깐 띄워 페이지가 스스로 요청하는 미디어 URL 을
// 코어 스니프 훅으로 수확하고 닫는다. 사용자에게 안 보이되(화면 밖), .hide() 가 아니라서 WKWebView 의
// occlusion 스로틀(타이머·미디어 정지)을 피한다 — 레거시가 쓰던 기법. 사이트 지식 0(R3): url 만 받고
// 페이지 자신의 요청을 가로챌 뿐 디코드·분기 없음. browser.media.sniff(보이는 탭)와 대칭인 숨김 경로.
//
// 플랫폼 중립: WKWebView 를 직접 만지지 않고 webview_eval 로 수확한다 — eval 이 동작하는 플랫폼이면
// 추출도 동작한다(macOS 하드코딩 아님). 비-macOS 의 webview_eval 미구현 갭은 별도 코어 과제이며,
// 추출은 그 위에 자동으로 올라탄다(미구현 플랫폼에선 eval 에러가 R9 로 표면화).
#[tauri::command]
pub async fn webview_media_extract(
    app: AppHandle,
    window: tauri::Window,
    url: String,
    timeout_ms: Option<u64>,
) -> Result<serde_json::Value, String> {
    use std::time::{Duration, Instant};
    let parsed = Url::parse(&url).map_err(|e| e.to_string())?;
    let label = format!("media-extract-{}", POPUP_SEQ.fetch_add(1, Ordering::Relaxed));
    let init_script = format!("{NEW_WINDOW_NAV}\n{MEDIA_SNIFF}");
    let builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .initialization_script(init_script)
        .on_navigation(|_| true);
    // 화면 밖(-20000) — 보이지 않지만 합성기에는 살아있어 JS/미디어가 정상 동작(스로틀 회피).
    window
        .add_child(
            builder,
            LogicalPosition::new(-20000.0, -20000.0),
            LogicalSize::new(1280.0, 720.0),
        )
        .map_err(|e| e.to_string())?;

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(15000).max(1000));
    let start = Instant::now();
    let mut triggered = false;
    let mut hits = serde_json::json!([]);
    loop {
        let raw = webview_eval(
            app.clone(),
            label.clone(),
            "return JSON.stringify(window.__soksakMedia || [])".to_string(),
        )
        .await
        .unwrap_or_else(|_| "[]".to_string());
        if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(&raw) {
            if !arr.is_empty() {
                hits = serde_json::json!(arr);
                // m3u8 이 잡혔으면 즉시 종료(아니면 더 기다려 본다).
                let has_m3u8 = serde_json::from_str::<Vec<serde_json::Value>>(&raw)
                    .ok()
                    .map(|v| {
                        v.iter().any(|h| {
                            h.get("url")
                                .and_then(|u| u.as_str())
                                .map(|s| s.contains(".m3u8"))
                                .unwrap_or(false)
                        })
                    })
                    .unwrap_or(false);
                if has_m3u8 {
                    break;
                }
            }
        }
        if !triggered {
            triggered = true;
            let _ = webview_eval(
                app.clone(),
                label.clone(),
                "try{var v=document.querySelector('video'); if(v){v.muted=true; v.play&&v.play().catch(function(){});}}catch(e){} return null;".to_string(),
            )
            .await;
        }
        if start.elapsed() >= timeout {
            break;
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.close();
    }
    Ok(hits)
}

// 존재하는 브라우저 child 웹뷰 라벨 목록(b-*). 프론트 GC 가 "웹뷰 집합 ⊆ 스토어의
// browser 뷰 집합" 불변식을 검증·회수하는 데 쓴다(생성/파괴 경쟁의 고아 방지).
#[tauri::command]
pub fn webview_list(app: AppHandle) -> Vec<String> {
    app.webviews()
        .keys()
        .filter(|l| l.starts_with("b-"))
        .cloned()
        .collect()
}

// 내장 브라우저 새 창을 명령으로 직접 열기(browser.open where=window).
#[tauri::command]
pub fn webview_open_window(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|e| e.to_string())?;
    open_popup(&app, parsed);
    Ok(())
}

// 브라우저 페이지에서 JS 를 실행하고 "결과를 반환"한다 — AI 의 DOM 제어 통로.
// WKWebView callAsyncJavaScript(async/await 지원) + completion handler 네이티브 콜백:
// 외부 페이지 CSP/IPC 권한과 무관, 폴링 없음. js 는 async 함수 본문으로 실행되며
// (호출측 래퍼가 JSON.stringify 로 감싼) 문자열을 반환해야 한다.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn webview_eval(app: AppHandle, label: String, js: String) -> Result<String, String> {
    use std::sync::mpsc;
    use std::time::Duration;

    let wv = app
        .get_webview(&label)
        .ok_or_else(|| format!("webview 없음: {label}"))?;
    let (tx, rx) = mpsc::sync_channel::<Result<String, String>>(1);

    wv.with_webview(move |pw| {
        use block2::RcBlock;
        use objc2::runtime::AnyObject;
        use objc2::MainThreadMarker;
        use objc2_foundation::{NSError, NSString};
        use objc2_web_kit::{WKContentWorld, WKWebView};

        // with_webview 클로저는 메인 스레드에서 실행된다(tauri 보장).
        unsafe {
            let wk = &*(pw.inner() as *const WKWebView);
            let mtm = MainThreadMarker::new_unchecked();
            let world = WKContentWorld::pageWorld(mtm);
            let body = NSString::from_str(&js);
            let tx = tx.clone();
            let block = RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
                let outcome = if !error.is_null() {
                    Err((*error).localizedDescription().to_string())
                } else if result.is_null() {
                    Ok("null".to_string())
                } else {
                    match (*result).downcast_ref::<NSString>() {
                        Some(s) => Ok(s.to_string()),
                        None => Err("eval 결과가 문자열이 아님(JSON.stringify 필요)".into()),
                    }
                };
                let _ = tx.try_send(outcome);
            });
            wk.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
                &body,
                None,
                None,
                &world,
                Some(&block),
            );
        }
    })
    .map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(15))
            .map_err(|_| "eval 시간 초과".to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn webview_eval(_app: AppHandle, _label: String, _js: String) -> Result<String, String> {
    Err("webview_eval 은 현재 macOS 전용".into())
}

// 열린 webview 에 init script(WKUserScript)를 주입한다 — 다음 내비게이션마다 자동 재주입.
// 코어가 하드코딩하던 NEW_WINDOW_NAV/MEDIA_SNIFF/HOVER_SCRIPT 를 브라우저 플러그인이 소유하게 하는 통로.
// phase = "document-start"(기본) | "document-end". macOS 전용(비-macOS no-op).
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn webview_inject_script(
    app: AppHandle,
    label: String,
    code: String,
    phase: Option<String>,
) -> Result<(), String> {
    let wv = app
        .get_webview(&label)
        .ok_or_else(|| format!("webview 없음: {label}"))?;
    let at_start = phase.as_deref() != Some("document-end");
    wv.with_webview(move |pw| {
        use objc2::MainThreadMarker;
        use objc2_foundation::NSString;
        use objc2_web_kit::{WKUserScript, WKUserScriptInjectionTime, WKWebView};
        // with_webview 클로저는 메인 스레드(tauri 보장).
        unsafe {
            let wk = &*(pw.inner() as *const WKWebView);
            let mtm = MainThreadMarker::new_unchecked();
            let controller = wk.configuration().userContentController();
            let src = NSString::from_str(&code);
            let time = if at_start {
                WKUserScriptInjectionTime::AtDocumentStart
            } else {
                WKUserScriptInjectionTime::AtDocumentEnd
            };
            let script = WKUserScript::initWithSource_injectionTime_forMainFrameOnly(
                mtm.alloc(),
                &src,
                time,
                true,
            );
            controller.addUserScript(&script);
        }
    })
    .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn webview_inject_script(
    _app: AppHandle,
    _label: String,
    _code: String,
    _phase: Option<String>,
) -> Result<(), String> {
    Ok(()) // 비-macOS no-op
}

// webview 캡처(snapshot/record/occlusion)는 tauri-plugin-webview-capture 로 분리됨
// (별도 저장소, 멀티플랫폼). 앱은 .plugin(tauri_plugin_webview_capture::init()) 로
// 등록하고 sok 명령(window.snapshot/record/occlusion)이 plugin:webview-capture|* 를 호출.

// NSWindow 포인터 → Tauri 창 label 역검색(MW1: 모든 네이티브 이벤트는 어느 창인지 label 로 식별).
// 창 수는 적고(보통 1~3) 매 이벤트마다 호출되지만 순회 비용은 무시할 수준.
// windows()(Window 레지스트리)를 쓴다 — 브라우저 child 를 add_child 한 창은 멀티-webview 가 되어
// webview_windows()(단일-webview 전용, is_webview_window 필터)에서 빠지므로, 그걸 쓰면 브라우저 연
// 창의 클릭이 label 매칭 실패로 사라진다.
#[cfg(target_os = "macos")]
fn label_for_nswindow(app: &AppHandle, ns_ptr: usize) -> Option<String> {
    use tauri::Manager;
    for (label, w) in app.windows() {
        if let Ok(ns) = w.ns_window() {
            if ns as usize == ns_ptr {
                return Some(label);
            }
        }
    }
    None
}

// 네이티브 child webview 위 클릭은 메인 webview DOM 에 도달하지 않아 포커스 추적(activeGroup)이
// 끊긴다. NSEvent 로컬 모니터(앱 전역 1회)로 *모든 창*의 좌클릭을 잡아 {label, 좌표}를 emit 한다 —
// 감지는 네이티브가, 판정(어느 창·그룹)은 레이아웃을 아는 프론트가 소유(자기 창 label 필터 +
// elementFromPoint). 이벤트는 그대로 통과(클릭 동작 불변). MW1/MW4 — 단일 창(main_ptr) 가정 제거.
#[cfg(target_os = "macos")]
pub fn install_click_monitor(app: &AppHandle) {
    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventType};

    #[derive(Clone, Serialize)]
    struct ClickPayload {
        x: f64,
        y: f64,
    }

    let handle = app.clone();
    let block = block2::RcBlock::new(
        move |event: std::ptr::NonNull<NSEvent>| -> *mut NSEvent {
            unsafe {
                let ev = event.as_ref();
                // Down/Dragged/Up 을 각각 native-mousedown/native-mousemove/native-mouseup 으로 브릿지한다.
                // 왜 3종인가: 네이티브 child(브라우저 등)는 OS 뷰라 그 위의 mousedown/move/up 이 DOM 에 오지
                // 않는다 → 그 위를 지나는 분할 divider 를 드래그로 리사이즈할 수 없다. 좌표를 프론트에 넘겨
                // 프론트가 divider 판정+합성 이벤트로 드래그를 구동하게 한다. 이벤트는 통과(동작 불변).
                // move/up 은 버튼 누른 드래그(LeftMouseDragged) 동안만 흐르므로 IPC 폭주 없음(hover 는 제외).
                let name = match ev.r#type() {
                    NSEventType::LeftMouseDown => "native-mousedown",
                    NSEventType::LeftMouseDragged => "native-mousemove",
                    NSEventType::LeftMouseUp => "native-mouseup",
                    // hover(버튼 안 누름) — divider 강조용. 브라우저 위 마우스 이동은 매우 빈번하므로
                    // 25ms(~40Hz) 스로틀한다(드래그 Dragged 는 스로틀 없음 — 리사이즈 정밀).
                    NSEventType::MouseMoved => {
                        static LAST_MS: std::sync::atomic::AtomicU64 =
                            std::sync::atomic::AtomicU64::new(0);
                        static CLOCK: std::sync::LazyLock<std::time::Instant> =
                            std::sync::LazyLock::new(std::time::Instant::now);
                        let now = CLOCK.elapsed().as_millis() as u64;
                        if now.saturating_sub(LAST_MS.load(Ordering::Relaxed)) < 25 {
                            return event.as_ptr();
                        }
                        LAST_MS.store(now, Ordering::Relaxed);
                        "native-mousemove"
                    }
                    _ => return event.as_ptr(),
                };
                // 모니터 콜백은 메인 스레드에서 호출된다(AppKit 이벤트 루프).
                let Some(mtm) = MainThreadMarker::new() else {
                    return event.as_ptr();
                };
                if let Some(win) = ev.window(mtm) {
                    let ns_ptr = Retained::as_ptr(&win) as usize;
                    if let Some(label) = label_for_nswindow(&handle, ns_ptr) {
                        if let Some(view) = win.contentView() {
                            let h = view.frame().size.height;
                            let loc = ev.locationInWindow();
                            // 그 창에만 emit_to — 프론트는 자기 창 이벤트만 받아 필터가 불필요.
                            let _ = handle.emit_to(&label, name, ClickPayload { x: loc.x, y: h - loc.y });
                        }
                    }
                }
                event.as_ptr()
            }
        },
    );
    let mask = NSEventMask(
        NSEventMask::LeftMouseDown.0
            | NSEventMask::LeftMouseDragged.0
            | NSEventMask::LeftMouseUp.0
            | NSEventMask::MouseMoved.0,
    );
    let monitor = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &block) };
    // 모니터는 앱 수명 동안 유지 — drop 되면 해제되므로 의도적으로 leak.
    std::mem::forget(monitor);
}

// divider 강조바 = 순수 시각. hitTest 를 nil 반환해 마우스를 통과시킨다 — 그래야 강조바가 divider 위를
// 덮어도 그 밑 divider 가 native-mousedown(드래그/리사이즈)을 받는다. NSBox 서브클래스(fillColor 가
// NSColor 를 직접 받음 — CALayer.setBackgroundColor 는 objc2-core-graphics feature 게이트라 회피).
#[cfg(target_os = "macos")]
objc2::define_class!(
    #[unsafe(super(objc2_app_kit::NSBox))]
    #[thread_kind = objc2::MainThreadOnly]
    struct DividerHiliteBox;

    impl DividerHiliteBox {
        #[unsafe(method(hitTest:))]
        fn hit_test(&self, _point: objc2_foundation::NSPoint) -> *mut objc2_app_kit::NSView {
            std::ptr::null_mut() // 마우스 통과 — 밑의 divider 가 드래그를 받는다
        }
    }
);

// 창별 divider 강조바(메인스레드 전용 — Retained 는 !Send 라 thread_local 로 소유).
#[cfg(target_os = "macos")]
thread_local! {
    static HL_BARS: std::cell::RefCell<
        std::collections::HashMap<String, objc2::rc::Retained<DividerHiliteBox>>,
    > = std::cell::RefCell::new(std::collections::HashMap::new());
}

// hover 중인 divider 위치(창 클라이언트 좌표 top-left, px)에 accent 바를 브라우저(네이티브 뷰) "위"에
// 그린다. rect=None 이면 숨김. seam(child 물림) 방식과 달리 브라우저를 건드리지 않아 밀림/리플로우 0 이고,
// contentView 최상위 subview 라 브라우저(네이티브)를 덮어 flat 에서도 강조가 보인다.
#[cfg(target_os = "macos")]
pub fn set_divider_highlight(app: &AppHandle, label: String, rect: Option<(f64, f64, f64, f64)>) {
    use objc2::{msg_send, MainThreadMarker};
    use objc2::rc::Retained;
    use objc2_app_kit::{NSBoxType, NSColor, NSTitlePosition, NSView, NSWindow};
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else { return };
        let Some(win) = app.get_window(&label) else { return };
        let Ok(ns) = win.ns_window() else { return };
        if ns.is_null() {
            return;
        }
        let ns_window: &NSWindow = unsafe { &*(ns as *const NSWindow) };
        let Some(content) = ns_window.contentView() else { return };
        let ch = content.frame().size.height;
        HL_BARS.with(|cell| {
            let mut bars = cell.borrow_mut();
            match rect {
                Some((x, y, w, h)) => {
                    // top-left(웹) → bottom-left(NSView) y-flip.
                    let frame = NSRect::new(
                        NSPoint::new(x, ch - (y + h)),
                        NSSize::new(w.max(1.0), h.max(1.0)),
                    );
                    let bar = bars.entry(label.clone()).or_insert_with(|| {
                        let b: Retained<DividerHiliteBox> =
                            unsafe { msg_send![mtm.alloc::<DividerHiliteBox>(), init] };
                        unsafe {
                            b.setBoxType(NSBoxType::Custom); // 커스텀 = fillColor 로 단색 채움(테두리/타이틀 X)
                            b.setTitlePosition(NSTitlePosition::NoTitle);
                            b.setBorderWidth(0.0);
                            b.setFillColor(&NSColor::controlAccentColor());
                        }
                        b
                    });
                    let view: &NSView = bar;
                    unsafe {
                        view.setFrame(frame);
                        view.removeFromSuperview();
                        content.addSubview(view); // 맨 위 subview = 브라우저 child 포함 모든 것 위.
                        view.setHidden(false);
                    }
                }
                None => {
                    if let Some(bar) = bars.get(&label) {
                        let view: &NSView = bar;
                        unsafe { view.setHidden(true) };
                    }
                }
            }
        });
    });
}

// 창 라이브 리사이즈(가장자리 드래그) 시작/끝을 네이티브로 감지해 프론트에 emit.
// 왜 네이티브인가: JS(ResizeObserver)는 "리사이즈 중"만 알 뿐 "끝났다"를 모른다 →
// 디바운스 추측으로 반영 지연이 생긴다(사용자 지적). 네이티브 신호는 정확하다 —
// 드래그 중엔 터미널 fit 을 멈춰 깜빡임 0, 놓는 즉시(didEnd) 0지연 reflow.
// 멀티플랫폼: 프론트는 "window-live-resize" {active} 한 채널만 소비한다. macOS 는
// NSWindow live-resize 알림이 신호원이고, Windows(WM_ENTER/EXITSIZEMOVE)·Linux 도
// 같은 이벤트를 자기 신호원으로 먹이면 프론트 로직은 그대로 재사용된다(Tauri 를
// 쓴 이유 — Rust 가 모든 플랫폼의 네이티브 창 이벤트를 잡는 단일 지점).
#[cfg(target_os = "macos")]
pub fn install_live_resize_monitor(app: &AppHandle) {
    use objc2_app_kit::{
        NSWindowDidEndLiveResizeNotification, NSWindowWillStartLiveResizeNotification,
    };
    use objc2_foundation::{NSNotification, NSNotificationCenter};

    let center = NSNotificationCenter::defaultCenter();
    // 통지 이름 상수는 extern static — 접근은 unsafe(읽기 전용, 항상 유효).
    let events: [(bool, &'static objc2_foundation::NSNotificationName); 2] = unsafe {
        [
            (true, NSWindowWillStartLiveResizeNotification),
            (false, NSWindowDidEndLiveResizeNotification),
        ]
    };
    for (active, name) in events {
        let handle = app.clone();
        // object: None = 모든 창의 통지(MW1 — 단일 창 가정 제거). 콜백에서 통지의 NSWindow →
        // label 을 찾아 그 창에만 emit_to(프론트 필터 불필요). child webview 창/패널은 label 매칭
        // 실패로 자연 제외(webview_windows 에 없음).
        let block = block2::RcBlock::new(move |note: std::ptr::NonNull<NSNotification>| unsafe {
            let obj: *mut objc2::runtime::AnyObject = objc2::msg_send![note.as_ref(), object];
            if let Some(label) = label_for_nswindow(&handle, obj as usize) {
                let _ = handle.emit_to(&label, "window-live-resize", active);
            }
        });
        let token = unsafe {
            center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block)
        };
        // 옵저버는 앱 수명 동안 유지 — 의도된 leak(앱 전역, 설치 1회).
        std::mem::forget(token);
    }
}
