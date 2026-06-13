// 브라우저 패널: 메인 창 안에 child webview(WKWebView)를 임베드한다(iframe 아님 —
// X-Frame-Options 제약 없이 실제 브라우저). 링크 클릭은 webview 기본 동작이고,
// 이전/이후는 history.back()/forward() eval, URL 변화는 on_navigation 으로 프론트에
// emit(폴링 없음). 위치/크기는 프론트 레이아웃(slot rect)을 따라 browser_bounds 로 동기화.
//
// 레이어 원칙(z-순서 역전 + 투명 홀 + hitTest 위임 — mod layer):
// DOM(메인 webview)이 항상 최상위 레이어다. child webview 는 생성 직후 메인 아래로
// 내리고, 메인은 자체 배경을 칠하지 않아(CSS 투명 슬롯 = 홀) 아래 webview 가 비친다.
// 마우스는 hitTest 가 위임한다 — 홀 안 + 오버레이 없음이면 아래 webview 가 받는다.
// 그래서 모달/메뉴/드롭 인디케이터 등 모든 DOM 레이어가 브라우저 위에 그려진다
// (과거의 "오버레이 동안 브라우저 숨김(suppress)" 우회는 폐지).

use std::sync::atomic::{AtomicUsize, Ordering};

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl,
    WebviewWindowBuilder,
};

#[derive(Clone, Serialize)]
struct NavPayload {
    label: String,
    url: String,
}

#[derive(Clone, Serialize)]
struct TitlePayload {
    label: String,
    title: String,
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

// ── 레이어 정공법(macOS): z-순서 역전 + 투명 홀 + hitTest 위임 ────────────────
// Tauri 에는 webview z-order API 가 없으므로(docs.rs 실측) AppKit 수준에서 직접
// 수행한다 — browser.rs 의 기존 objc2 직접 호출(타이틀 KVO/eval/클릭 모니터)과
// 같은 층위. 홀의 단일 진실 = "보이는 child webview 의 frame" 그 자체라서 별도
// rect 레지스트리가 없다(set_position/set_size/hide 가 곧 홀 갱신).
#[cfg(target_os = "macos")]
mod layer {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Sel};
    use objc2::sel;
    use objc2_app_kit::{NSView, NSWindowOrderingMode};
    use objc2_foundation::{NSNumber, NSPoint, NSString};
    use tauri::Manager;

    // 오버레이(모달/메뉴 등 DOM 레이어)가 떠 있는 동안 true — 홀 마우스 통과를
    // 차단해 "바깥 클릭=닫기"가 성립한다(브라우저는 보이되 비활성).
    pub static OVERLAY_ACTIVE: AtomicBool = AtomicBool::new(false);
    // 메인 webview 의 NSView 포인터. install 1회 저장, 메인 webview 는 앱 수명
    // 동안 파괴되지 않으므로 불변.
    static MAIN_VIEW: AtomicUsize = AtomicUsize::new(0);
    // 교체 전 원본 hitTest IMP(클래스 메서드 스위즐의 폴백 경로).
    static ORIG_HIT_TEST: AtomicUsize = AtomicUsize::new(0);

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
        if this as usize != MAIN_VIEW.load(Ordering::Relaxed) {
            return default; // child/팝업 webview — 원본 동작 그대로.
        }
        if default.is_null() || OVERLAY_ACTIVE.load(Ordering::Relaxed) {
            return default;
        }
        let view = &*(this as *const NSView);
        let Some(superview) = view.superview() else {
            return default;
        };
        for sub in superview.subviews().iter() {
            if Retained::as_ptr(&sub) as *mut AnyObject == this || sub.isHidden() {
                continue;
            }
            // 형제 중 webview(WKWebView 계열)만 홀이다 — 그 외 장식 뷰는 무시.
            if !sub.class().name().to_string_lossy().contains("WebView") {
                continue;
            }
            let f = sub.frame();
            if point.x >= f.origin.x
                && point.x < f.origin.x + f.size.width
                && point.y >= f.origin.y
                && point.y < f.origin.y + f.size.height
            {
                return std::ptr::null_mut();
            }
        }
        default
    }

    // 메인 webview 에 1회 설치: ① 자체 배경 비활성(KVC drawsBackground=false —
    // wry 의 transparent 경로와 동일 기법; CSS 불투명 표면은 그대로 그려지고
    // 투명 슬롯만 아래가 비친다) ② hitTest 메서드 스위즐(클래스 단위, 위 주석).
    pub fn install(app: &tauri::AppHandle) {
        let Some(wv) = app.get_webview("main") else {
            eprintln!("[layer] main webview 없음 — 레이어 역전 미설치");
            return;
        };
        let _ = wv.with_webview(|pw| unsafe {
            let obj = pw.inner() as *mut AnyObject;
            MAIN_VIEW.store(obj as usize, Ordering::Relaxed);

            let no = NSNumber::new_bool(false);
            let key = NSString::from_str("drawsBackground");
            let _: () = msg_send![&*obj, setValue: Some(&*no as &AnyObject), forKey: &*key];

            // hitTest 스위즐 — 원본 IMP 를 보관하고 같은 타입 인코딩으로 교체.
            // (인스턴스가 hitTest 를 직접 구현하지 않았으면 상속분이 원본이 된다.)
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

    // child webview 를 메인(DOM) 아래로 강하. add_child 는 최상위에 붙이므로
    // 생성 직후 1회 호출한다. 기존 서브뷰에 addSubview:positioned:relativeTo: 를
    // 호출하면 제거 후 재삽입(AppKit 표준 동작)으로 순서만 바뀐다.
    pub fn lower_below_main<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
        let _ = webview.with_webview(|pw| unsafe {
            let main_ptr = MAIN_VIEW.load(Ordering::Relaxed);
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

// 오버레이(모달/메뉴/드롭다운) 상태 동기화 — 프론트 ui 스토어 카운터가 0↔1 을
// 넘을 때 호출한다. true 면 홀 마우스 통과 차단(hitTest 가 DOM 에 우선권).
#[tauri::command]
pub fn browser_overlay_active(active: bool) {
    #[cfg(target_os = "macos")]
    layer::OVERLAY_ACTIVE.store(active, Ordering::Relaxed);
    #[cfg(not(target_os = "macos"))]
    let _ = active;
}

// 실측 프로브: 메인 창 뷰 계층 덤프(레이어 가정 검증·진단용).
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn browser_debug_hierarchy(app: AppHandle) -> Result<String, String> {
    use std::sync::mpsc;
    use std::time::Duration;

    let window = app.get_window("main").ok_or("main window 없음")?;
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
pub async fn browser_debug_hierarchy(_app: AppHandle) -> Result<String, String> {
    Err("browser_debug_hierarchy 는 현재 macOS 전용".into())
}

// 메인 webview 레이어 설치(setup 에서 1회) — lib.rs 가 호출.
#[cfg(target_os = "macos")]
pub fn install_layer_inversion(app: &AppHandle) {
    layer::install(app);
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
  window.open = function (u) { pop(u); return null; };
  document.addEventListener("click", function (e) {
    var t = e.target;
    var a = t && t.closest ? t.closest('a[target="_blank"]') : null;
    if (a && a.href) { e.preventDefault(); pop(a.href); }
  }, true);
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
        .initialization_script(NEW_WINDOW_NAV)
        // 링크 클릭 등 네비게이션을 프론트로 통지(URL 바 동기화, 폴링 없음).
        // about:blank 는 WKWebView 초기화 과정의 중간 단계 — URL 상태를 덮어쓰지 않게 제외.
        // 새 창 마커는 차단하고 내장 브라우저 새 창으로.
        .on_navigation(move |url| {
            if let Some(target) = popup_target(url) {
                open_popup(&nav_app, target);
                return false;
            }
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
        })
        // 로드 완료 시 문서 <title> 을 읽어 탭/타이틀바 제목으로 emit.
        .on_page_load(move |webview, payload| {
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
    // 레이어 원칙: child 는 DOM(메인 webview) 아래 — 생성 직후 z-순서 강하.
    #[cfg(target_os = "macos")]
    layer::lower_below_main(&webview);
    #[cfg(not(target_os = "macos"))]
    let _ = webview;
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

// 존재하는 브라우저 child 웹뷰 라벨 목록(b-*). 프론트 GC 가 "웹뷰 집합 ⊆ 스토어의
// browser 뷰 집합" 불변식을 검증·회수하는 데 쓴다(생성/파괴 경쟁의 고아 방지).
#[tauri::command]
pub fn browser_list(app: AppHandle) -> Vec<String> {
    app.webviews()
        .keys()
        .filter(|l| l.starts_with("b-"))
        .cloned()
        .collect()
}

// 내장 브라우저 새 창을 명령으로 직접 열기(browser.open where=window).
#[tauri::command]
pub fn browser_open_window(app: AppHandle, url: String) -> Result<(), String> {
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
pub async fn browser_eval(app: AppHandle, label: String, js: String) -> Result<String, String> {
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
pub async fn browser_eval(_app: AppHandle, _label: String, _js: String) -> Result<String, String> {
    Err("browser_eval 은 현재 macOS 전용".into())
}

// 메인 webview(DOM + WebGL 합성 결과)를 PNG 로 캡처해 path 에 저장한다 — 외부
// screencapture 없이 앱 내부에서 정확한 프레임을 찍는 통로(E2E/디버그). WKWebView
// takeSnapshot 은 화면에 합성된 결과(가속 레이어=WebGL 캔버스 포함)를 캡처하므로
// 터미널 렌더도 찍힌다. 창이 가려지면 WebKit 렌더가 스로틀되니 호출 시 창은 보여야 한다.
#[cfg(target_os = "macos")]
async fn snapshot_to(app: &AppHandle, path: &str) -> Result<(), String> {
    use std::sync::mpsc;
    use std::time::Duration;

    let wv = app.get_webview("main").ok_or("main webview 없음")?;
    let (tx, rx) = mpsc::sync_channel::<Result<(), String>>(1);
    let out = path.to_string();

    wv.with_webview(move |pw| {
        use block2::RcBlock;
        use objc2::msg_send;
        use objc2::rc::Retained;
        use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
        use objc2_foundation::{NSData, NSError, NSString};
        use objc2_web_kit::WKWebView;

        unsafe {
            let wk = &*(pw.inner() as *const WKWebView);
            let tx = tx.clone();
            let out = out.clone();
            // 완료 핸들러: NSImage → TIFF → NSBitmapImageRep → PNG → 파일.
            let block = RcBlock::new(move |img: *mut NSImage, error: *mut NSError| {
                let outcome = (|| -> Result<(), String> {
                    if !error.is_null() {
                        return Err((*error).localizedDescription().to_string());
                    }
                    if img.is_null() {
                        return Err("snapshot 이미지 nil".into());
                    }
                    let image = &*img;
                    let tiff: Option<Retained<NSData>> = msg_send![image, TIFFRepresentation];
                    let tiff = tiff.ok_or("TIFF 표현 실패")?;
                    let rep: Option<Retained<NSBitmapImageRep>> =
                        msg_send![objc2::class!(NSBitmapImageRep), imageRepWithData: &*tiff];
                    let rep = rep.ok_or("bitmap rep 실패")?;
                    // properties=nil → 기본 PNG 인코딩.
                    let png: Option<Retained<NSData>> = msg_send![
                        &*rep,
                        representationUsingType: NSBitmapImageFileType::PNG,
                        properties: std::ptr::null::<objc2::runtime::AnyObject>()
                    ];
                    let png = png.ok_or("PNG 인코딩 실패")?;
                    let nspath = NSString::from_str(&out);
                    let ok: bool = msg_send![&*png, writeToFile: &*nspath, atomically: true];
                    if ok {
                        Ok(())
                    } else {
                        Err("파일 쓰기 실패".into())
                    }
                })();
                let _ = tx.try_send(outcome);
            });
            // config=nil → 현재 보이는 전체 콘텐츠.
            let _: () = msg_send![
                wk,
                takeSnapshotWithConfiguration: std::ptr::null::<objc2::runtime::AnyObject>(),
                completionHandler: &*block
            ];
        }
    })
    .map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| "snapshot 시간 초과".to_string())?
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(())
}

// 단일 스냅샷 → path. 저장 경로를 그대로 반환.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn window_snapshot(app: AppHandle, path: String) -> Result<String, String> {
    snapshot_to(&app, &path).await?;
    Ok(path)
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn window_snapshot(_app: AppHandle, _path: String) -> Result<String, String> {
    Err("window_snapshot 은 현재 macOS 전용".into())
}

// 연사 캡처(내장 "동영상"): dir/f0000.png .. 를 frames 개, interval_ms 간격으로 저장.
// 외부에서 동시에 리사이즈 스톰을 돌리면 전환 프레임을 정확히 잡는다. 반환=찍은 수.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn window_record(
    app: AppHandle,
    dir: String,
    frames: u32,
    interval_ms: u64,
) -> Result<u32, String> {
    use std::time::Duration;
    let n = frames.min(600); // 폭주 방지 상한
    for i in 0..n {
        let path = format!("{dir}/f{i:04}.png");
        snapshot_to(&app, &path).await?;
        if i + 1 < n {
            tauri::async_runtime::spawn_blocking(move || {
                std::thread::sleep(Duration::from_millis(interval_ms))
            })
            .await
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(n)
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn window_record(
    _app: AppHandle,
    _dir: String,
    _frames: u32,
    _interval_ms: u64,
) -> Result<u32, String> {
    Err("window_record 은 현재 macOS 전용".into())
}

// 네이티브 child webview 위 클릭은 메인 webview DOM 에 도달하지 않아 포커스
// 추적(activeGroup)이 끊긴다. NSEvent 로컬 모니터로 메인 윈도 안 모든 좌클릭의
// 좌표(top-left logical)를 프론트에 emit 한다 — 감지는 네이티브가, 판정(어느
// 그룹인가)은 레이아웃을 아는 프론트가 소유(elementFromPoint). 이벤트는 그대로
// 통과시킨다(클릭 동작 불변).
#[cfg(target_os = "macos")]
pub fn install_click_monitor(app: &AppHandle) {
    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSEvent, NSEventMask};
    use tauri::Manager;

    #[derive(Clone, Serialize)]
    struct ClickPayload {
        x: f64,
        y: f64,
    }

    let Some(main) = app.get_window("main") else {
        return;
    };
    let Ok(main_ns) = main.ns_window() else {
        return;
    };
    let main_ptr = main_ns as usize;
    let handle = app.clone();
    let block = block2::RcBlock::new(
        move |event: std::ptr::NonNull<NSEvent>| -> *mut NSEvent {
            unsafe {
                let ev = event.as_ref();
                // 모니터 콜백은 메인 스레드에서 호출된다(AppKit 이벤트 루프).
                let Some(mtm) = MainThreadMarker::new() else {
                    return event.as_ptr();
                };
                if let Some(win) = ev.window(mtm) {
                    if Retained::as_ptr(&win) as usize == main_ptr {
                        if let Some(view) = win.contentView() {
                            let h = view.frame().size.height;
                            let loc = ev.locationInWindow();
                            let _ = handle.emit(
                                "native-mousedown",
                                ClickPayload {
                                    x: loc.x,
                                    y: h - loc.y,
                                },
                            );
                        }
                    }
                }
                event.as_ptr()
            }
        },
    );
    let monitor =
        unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::LeftMouseDown, &block) };
    // 모니터는 앱 수명 동안 유지 — drop 되면 해제되므로 의도적으로 leak.
    std::mem::forget(monitor);
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

    #[derive(Clone, Serialize)]
    struct LiveResizePayload {
        active: bool,
    }

    let Some(main) = app.get_window("main") else {
        return;
    };
    let Ok(main_ns) = main.ns_window() else {
        return;
    };
    let main_ptr = main_ns as usize;

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
        let block = block2::RcBlock::new(move |_note: std::ptr::NonNull<NSNotification>| {
            // 통지는 메인 스레드에서 게시된다.
            let _ = handle.emit("window-live-resize", LiveResizePayload { active });
        });
        let token = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(name),
                // 이 창의 통지만(브라우저 자식 webview 창/패널 제외).
                Some(&*(main_ptr as *const objc2::runtime::AnyObject)),
                None,
                &block,
            )
        };
        // 옵저버는 앱 수명 동안 유지 — 의도된 leak(창 1개, 설치 1회).
        std::mem::forget(token);
    }
}
