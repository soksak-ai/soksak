// 인프로세스 CEF 브라우저 엔진 — Chromium 을 앱 프로세스 안에서 windowed 로 구동해 pane 의 네이티브
// child 뷰로 임베드한다(set_as_child). 프레임이 JS 를 안 거치므로 네이티브 크롬 속도(OSR 폐기 이유).
//
// 왜 코어에 있나: macOS 는 부모 뷰(NSView)가 프로세스-로컬이라 사이드카(별프로세스)의 CEF 창을 앱 창에
// 붙일 수 없다 → CEF 가 앱 프로세스에서 렌더해야 한다. 무거운 CEF framework 는 런타임 dlopen 이라
// 바이너리에 정적 링크되지 않는다(feature "cef-browser" + env 게이트로 기본 시작 무영향).
//
// 메시지펌프(핵심): CEF 는 자기 스레드루프를 안 돈다(external_message_pump=1). 대신 "지금 work 필요"를
// OnScheduleMessagePumpWork(delay) 로 push 한다. 그걸 GCD 로 메인큐 "최상위"에 비재진입 디스패치해서
// do_message_loop_work 를 편다. tao 이벤트 콜백 안에서 직접 do_message_loop_work 를 부르면 NSApp
// 이벤트펌프가 재진입되어 didFinishLaunching 도중 CATransaction display 에서 데드락한다(실측). 이 방식은
// cefclient 의 MainMessageLoopExternalPumpMac(NSTimer) 와 동치 — 폴링 아님, CEF push 기반.

#![cfg(feature = "cef-browser")]

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, OnceLock};

use cef::args::Args;
use cef::library_loader::LibraryLoader;
use cef::rc::*;
use cef::*;

// CEF 활성 여부 — env SOKSAK_CEF=1 일 때만. 미설정 시 이 모듈의 모든 진입은 no-op(기본 시작 무영향).
pub fn enabled() -> bool {
    std::env::var("SOKSAK_CEF").ok().as_deref() == Some("1")
}

// 임베드 대기 요청(플러그인 → 커맨드 → 여기). CEF 조작은 UI(메인) 스레드에서만 하므로 큐잉 후 pump 에서 적용.
// 좌표(x,y,w,h)는 플랫폼 중립 top-left 원점 DIP(points) — 부모 뷰 안에서. macOS 는 apply 시 y-flip.
struct CreateReq {
    id: u32,
    nsview: usize,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    url: String,
}
// 기존 브라우저 대상 제어 오퍼레이션(id 로 지정). CEF 조작은 메인 스레드 전용 → 큐잉 후 pump 에서 적용.
enum Op {
    Load { id: u32, url: String },
    Reload { id: u32, ignore_cache: bool },
    Back { id: u32 },
    Forward { id: u32 },
    Bounds { id: u32, x: i32, y: i32, w: i32, h: i32 },
    Hidden { id: u32, hidden: bool },
    Focus { id: u32 },
    Close { id: u32 },
}
static PENDING: LazyLock<Mutex<Vec<CreateReq>>> = LazyLock::new(|| Mutex::new(Vec::new()));
static OPS: LazyLock<Mutex<Vec<Op>>> = LazyLock::new(|| Mutex::new(Vec::new()));
// on_before_close 가 넣는 "제거 대기" CEF identifier. Browser drop(refcount 해제)은 CEF 콜백
// 안이 아니라 다음 pump(do_work)에서 한다 — 콜백 안에서 drop 하면 파괴 재진입으로 크래시.
static CLOSING: LazyLock<Mutex<Vec<i32>>> = LazyLock::new(|| Mutex::new(Vec::new()));
static NEXT_ID: AtomicU32 = AtomicU32::new(1);
// 생성된 브라우저: id → Browser. bounds/navigate/close 는 여기서 찾아 적용.
static BROWSERS: LazyLock<Mutex<Vec<(u32, Browser)>>> = LazyLock::new(|| Mutex::new(Vec::new()));

// 부모 뷰 좌표계는 macOS 가 하단-좌 원점(비-flip) → top-left DIP 를 NSView y 로 뒤집는다.
// parent_h(부모 뷰 높이, points) - (top + h). 비-macos 는 그대로(top-left).
#[cfg(target_os = "macos")]
fn flip_y(parent_view: *mut c_void, top: i32, h: i32) -> i32 {
    if parent_view.is_null() {
        return top;
    }
    unsafe {
        let v = &*(parent_view as *const objc2::runtime::AnyObject);
        let b: objc2_foundation::NSRect = objc2::msg_send![v, bounds];
        (b.size.height as i32) - (top + h)
    }
}
#[cfg(not(target_os = "macos"))]
fn flip_y(_parent_view: *mut c_void, top: i32, _h: i32) -> i32 {
    top
}

// NSView setFrame(부모 좌표계, 하단-좌). 메인 스레드에서만.
#[cfg(target_os = "macos")]
fn set_view_frame(view: *mut c_void, x: i32, y: i32, w: i32, h: i32) {
    if view.is_null() {
        return;
    }
    unsafe {
        let v = &*(view as *const objc2::runtime::AnyObject);
        let frame = objc2_foundation::NSRect::new(
            objc2_foundation::NSPoint::new(x as f64, y as f64),
            objc2_foundation::NSSize::new(w.max(1) as f64, h.max(1) as f64),
        );
        let _: () = objc2::msg_send![v, setFrame: frame];
    }
}

// id 로 브라우저 조회(clone — refcount 증가, 호출자가 소유).
fn find_browser(id: u32) -> Option<Browser> {
    BROWSERS
        .lock()
        .ok()
        .and_then(|list| list.iter().find(|(bid, _)| *bid == id).map(|(_, b)| b.clone()))
}

// ── 메시지펌프 스케줄링(GCD 메인큐, 비재진입) ──────────────────────────────────────────────
// PUMP_SCHEDULED: GCD 블록이 하나 예약돼 있음(중복 예약 억제). IN_WORK: do_message_loop_work 실행 중
// (런루프 spin 으로 재진입 시 감지). REDO: 실행 중 새 요청이 왔음 → 끝나고 즉시 한 번 더.
static PUMP_SCHEDULED: AtomicBool = AtomicBool::new(false);
static IN_WORK: AtomicBool = AtomicBool::new(false);
static REDO: AtomicBool = AtomicBool::new(false);

// 렌더 틱: external_message_pump 에선 CEF present 가 "활동 중 메시지루프가 계속 도는 것"을 전제한다
// (안 돌면 렌더러 프레임이 합성/present 안 됨 → 흰 화면). 그래서 "보이는 브라우저 && 활동 중"일 때만
// ~60fps 로 do_message_loop_work 를 돌려 present 를 몰아준다. 유휴(정적·로드 완료 후)엔 멈춘다 → CPU 0.
// cefclient 의 external pump 타이머와 동치(꼼수 아님). schedule_pump 는 활동으로 안 침(펌프→CEF 재요청
// →bump 무한 피드백 방지). 활동 = LoadHandler 로딩 + 사용자 op(navigate/bounds/…).
static VISIBLE: LazyLock<Mutex<std::collections::HashSet<u32>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));
static LOADING: LazyLock<Mutex<std::collections::HashSet<i32>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));
static TICK_ON: AtomicBool = AtomicBool::new(false);
static ACTIVE_UNTIL_MS: AtomicU64 = AtomicU64::new(0);
static CLOCK: LazyLock<std::time::Instant> = LazyLock::new(std::time::Instant::now);
const RENDER_TICK_MS: i64 = 16; // ~60fps(활동 중에만)
const ACTIVE_GRACE_MS: u64 = 1500; // 활동 신호 후 이만큼 더 틱(로드 후 지연 페인트 커버)

fn now_ms() -> u64 {
    CLOCK.elapsed().as_millis() as u64
}
fn visible_nonempty() -> bool {
    VISIBLE.lock().map(|s| !s.is_empty()).unwrap_or(false)
}
fn loading_nonempty() -> bool {
    LOADING.lock().map(|s| !s.is_empty()).unwrap_or(false)
}
fn is_active() -> bool {
    loading_nonempty() || now_ms() < ACTIVE_UNTIL_MS.load(Ordering::Relaxed)
}
fn bump_active() {
    ACTIVE_UNTIL_MS.store(now_ms() + ACTIVE_GRACE_MS, Ordering::Relaxed);
    start_render_tick();
}
fn note_visible(id: u32, visible: bool) {
    if let Ok(mut s) = VISIBLE.lock() {
        if visible {
            s.insert(id);
        } else {
            s.remove(&id);
        }
    }
}
fn note_gone(id: u32) {
    if let Ok(mut s) = VISIBLE.lock() {
        s.remove(&id);
    }
}
fn start_render_tick() {
    if TICK_ON.swap(true, Ordering::SeqCst) {
        return;
    }
    unsafe { dispatch_async_f(main_queue(), std::ptr::null_mut(), render_tick) };
}
extern "C" fn render_tick(_ctx: *mut c_void) {
    if !visible_nonempty() || !is_active() {
        TICK_ON.store(false, Ordering::SeqCst);
        return;
    }
    do_work();
    unsafe {
        let when = dispatch_time(DISPATCH_TIME_NOW, RENDER_TICK_MS.saturating_mul(1_000_000));
        dispatch_after_f(when, main_queue(), std::ptr::null_mut(), render_tick);
    }
}

// libdispatch(GCD) 원시 FFI — libSystem 자동 링크. _dispatch_main_q 는 메인 시리얼 큐 심볼.
#[allow(non_upper_case_globals)]
extern "C" {
    static _dispatch_main_q: [u8; 0];
    fn dispatch_async_f(queue: *const c_void, ctx: *mut c_void, work: extern "C" fn(*mut c_void));
    fn dispatch_after_f(when: u64, queue: *const c_void, ctx: *mut c_void, work: extern "C" fn(*mut c_void));
    fn dispatch_time(when: u64, delta: i64) -> u64;
}
const DISPATCH_TIME_NOW: u64 = 0;

fn main_queue() -> *const c_void {
    core::ptr::addr_of!(_dispatch_main_q) as *const c_void
}

// CEF push(OnScheduleMessagePumpWork) 또는 request_create 가 부른다 — 어느 스레드든 안전. 메인런루프
// 최상위에서 do_work 가 돌도록 GCD 로 디스패치. 이미 예약된 블록이 있으면 합쳐 버린다(스택 방지).
fn schedule_pump(delay_ms: i64) {
    if PUMP_SCHEDULED.swap(true, Ordering::SeqCst) {
        return;
    }
    let q = main_queue();
    unsafe {
        if delay_ms <= 0 {
            dispatch_async_f(q, std::ptr::null_mut(), pump_entry);
        } else {
            let when = dispatch_time(DISPATCH_TIME_NOW, delay_ms.saturating_mul(1_000_000));
            dispatch_after_f(when, q, std::ptr::null_mut(), pump_entry);
        }
    }
}

// GCD 블록 진입(메인 스레드) — 예약 플래그 해제 후 실제 work.
extern "C" fn pump_entry(_ctx: *mut c_void) {
    PUMP_SCHEDULED.store(false, Ordering::SeqCst);
    do_work();
}

// 실제 pump — 대기 임베드 요청 적용 + do_message_loop_work. do_message_loop_work 가 런루프를 spin 하며
// 메인큐 블록을 다시 dequeue 하면 재진입될 수 있다 → IN_WORK 로 감지, 재진입이면 REDO 만 세우고 즉시 반환.
// 바깥 work 가 끝난 뒤 REDO 면 한 번 더 예약(누락된 work 회수).
fn do_work() {
    if IN_WORK.load(Ordering::SeqCst) {
        REDO.store(true, Ordering::SeqCst);
        return;
    }
    IN_WORK.store(true, Ordering::SeqCst);
    apply_pending();
    apply_ops();
    do_message_loop_work();
    reap_closing();
    IN_WORK.store(false, Ordering::SeqCst);
    if REDO.swap(false, Ordering::SeqCst) {
        schedule_pump(0);
    }
}

// 대기 CreateReq → set_as_child 로 CEF child 브라우저 생성(메인 스레드에서만). y 는 top-left → NSView 로 flip.
fn apply_pending() {
    let reqs: Vec<CreateReq> =
        PENDING.lock().map(|mut q| q.drain(..).collect()).unwrap_or_default();
    for r in reqs {
        let parent = r.nsview as *mut c_void;
        let ns_y = flip_y(parent, r.y, r.h.max(1));
        let wi = WindowInfo::default().set_as_child(
            parent,
            &Rect { x: r.x, y: ns_y, width: r.w.max(1), height: r.h.max(1) },
        );
        let mut client = CefClient::new();
        let url = CefString::from(r.url.as_str());
        let bs = BrowserSettings::default();
        let browser = browser_host_create_browser_sync(
            Some(&wi),
            Some(&mut client),
            Some(&url),
            Some(&bs),
            None,
            None,
        );
        if let Some(b) = browser {
            if let Ok(mut list) = BROWSERS.lock() {
                list.push((r.id, b));
            }
            note_visible(r.id, true); // 생성 시 보임
            bump_active(); // 초기 로드 present 위해 렌더 틱 가동
            eprintln!("[cef] child browser 생성 OK (id={}, nsview={:#x})", r.id, r.nsview);
        } else {
            eprintln!("[cef] child browser 생성 실패 (id={})", r.id);
        }
    }
}

// 대기 제어 오퍼레이션 적용(메인 스레드). 대상 브라우저가 없으면 조용히 건너뜀(닫힌 뒤 늦은 op).
fn apply_ops() {
    let ops: Vec<Op> = OPS.lock().map(|mut q| q.drain(..).collect()).unwrap_or_default();
    for op in ops {
        match op {
            Op::Load { id, url } => {
                if let Some(f) = find_browser(id).and_then(|b| b.main_frame()) {
                    f.load_url(Some(&CefString::from(url.as_str())));
                }
            }
            Op::Reload { id, ignore_cache } => {
                if let Some(b) = find_browser(id) {
                    if ignore_cache {
                        b.reload_ignore_cache();
                    } else {
                        b.reload();
                    }
                }
            }
            Op::Back { id } => {
                if let Some(b) = find_browser(id) {
                    if b.can_go_back() == 1 {
                        b.go_back();
                    }
                }
            }
            Op::Forward { id } => {
                if let Some(b) = find_browser(id) {
                    if b.can_go_forward() == 1 {
                        b.go_forward();
                    }
                }
            }
            Op::Bounds { id, x, y, w, h } => {
                if let Some(host) = find_browser(id).and_then(|b| b.host()) {
                    let view = host.window_handle() as *mut c_void;
                    #[cfg(target_os = "macos")]
                    {
                        // 자식 뷰의 superview(부모) 높이로 flip.
                        let parent = unsafe {
                            if view.is_null() {
                                std::ptr::null_mut()
                            } else {
                                let v = &*(view as *const objc2::runtime::AnyObject);
                                let sv: *mut objc2::runtime::AnyObject = objc2::msg_send![v, superview];
                                sv as *mut c_void
                            }
                        };
                        let ns_y = flip_y(parent, y, h.max(1));
                        set_view_frame(view, x, ns_y, w, h);
                        host.was_resized();
                    }
                    #[cfg(not(target_os = "macos"))]
                    {
                        let _ = (view, x, y, w, h);
                        host.was_resized();
                    }
                }
            }
            Op::Hidden { id, hidden } => {
                note_visible(id, !hidden);
                if !hidden {
                    bump_active(); // 다시 보일 때 present 위해 틱 가동
                }
                if let Some(host) = find_browser(id).and_then(|b| b.host()) {
                    host.was_hidden(if hidden { 1 } else { 0 });
                    // 숨김 시 네이티브 뷰도 hidden — was_hidden 만으론 windowed 뷰가 안 사라진다.
                    #[cfg(target_os = "macos")]
                    unsafe {
                        let view = host.window_handle() as *mut c_void;
                        if !view.is_null() {
                            let v = &*(view as *const objc2::runtime::AnyObject);
                            let _: () = objc2::msg_send![v, setHidden: hidden];
                        }
                    }
                }
            }
            Op::Focus { id } => {
                if let Some(host) = find_browser(id).and_then(|b| b.host()) {
                    host.set_focus(1);
                }
            }
            Op::Close { id } => {
                note_gone(id);
                // non-force(0) — 정석 close 시퀀스(do_close→on_before_close). BROWSERS 제거·drop 은
                // on_before_close 가 CLOSING 에 넣고 reap_closing 이 다음 pump 에서 한다(동기 drop 금지).
                if let Some(host) = find_browser(id).and_then(|b| b.host()) {
                    host.close_browser(0);
                }
                eprintln!("[cef] close 요청 (id={id})");
            }
        }
    }
}

// on_before_close 가 기록한 닫힌 브라우저를 BROWSERS 에서 제거(=Rust Browser drop). CEF 콜백
// 밖(do_message_loop_work 이후)에서 실행돼 파괴 재진입을 피한다.
fn reap_closing() {
    let ids: Vec<i32> = CLOSING.lock().map(|mut q| q.drain(..).collect()).unwrap_or_default();
    if ids.is_empty() {
        return;
    }
    if let Ok(mut list) = BROWSERS.lock() {
        list.retain(|(_, br)| !ids.contains(&br.identifier()));
    }
}

// 제어 op 큐잉 + 즉시 pump 예약(메인 스레드에서 apply_ops 가 실제 적용). 어느 스레드든 안전.
fn request_op(op: Op) {
    if let Ok(mut q) = OPS.lock() {
        q.push(op);
    }
    bump_active(); // 네비/뒤로/리로드/bounds 등 = 활동 → 렌더 틱 가동(present)
    schedule_pump(0);
}

pub fn load(id: u32, url: String) {
    request_op(Op::Load { id, url });
}
pub fn reload(id: u32, ignore_cache: bool) {
    request_op(Op::Reload { id, ignore_cache });
}
pub fn go_back(id: u32) {
    request_op(Op::Back { id });
}
pub fn go_forward(id: u32) {
    request_op(Op::Forward { id });
}
pub fn set_bounds(id: u32, x: i32, y: i32, w: i32, h: i32) {
    request_op(Op::Bounds { id, x, y, w, h });
}
pub fn set_hidden(id: u32, hidden: bool) {
    request_op(Op::Hidden { id, hidden });
}
pub fn set_focus(id: u32) {
    request_op(Op::Focus { id });
}
pub fn close(id: u32) {
    request_op(Op::Close { id });
}

// disable-gpu 로 GPU 프로세스 서명 이슈 회피(ad-hoc 서명 dev). 정식 서명 시 재검토.
// browser_process_handler 를 노출해 CEF 의 메시지펌프 스케줄 콜백을 받는다(external_message_pump 핵심).
wrap_app! {
    struct CefApp {}
    impl App {
        fn on_before_command_line_processing(
            &self,
            _pt: Option<&CefString>,
            cmd: Option<&mut CommandLine>,
        ) {
            if let Some(c) = cmd {
                // 풀 GPU — disable-gpu 를 켜지 않는다(브라우저는 GPU 가속이 정상, CPU 렌더는 타협).
                // GPU 프로세스 서명은 ad-hoc(arm64 링커 자동) 로 통과. 키체인은 in-memory 로 회피.
                c.append_switch(Some(&CefString::from("use-mock-keychain")));
                // 팝업 차단 해제 — target=_blank/window.open 을 막지 않고 on_before_popup 으로 설정대로
                // 라우팅(새 탭/새 창). 차단이 아니라 라우팅이 브라우저의 올바른 동작.
                c.append_switch(Some(&CefString::from("disable-popup-blocking")));
            }
        }
        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
            Some(CefBrowserProcessHandler::new())
        }
    }
}

// CEF 가 "지금(또는 delay 후) do_message_loop_work 필요" 를 push 하는 콜백. 어느 스레드든 호출될 수 있다.
wrap_browser_process_handler! {
    struct CefBrowserProcessHandler {}
    impl BrowserProcessHandler {
        fn on_schedule_message_pump_work(&self, delay_ms: i64) {
            schedule_pump(delay_ms);
        }
    }
}

// LifeSpanHandler — close 시퀀스의 정석. close_browser 후 CEF 가 do_close → on_before_close 를
// 부른다. on_before_close 에서야 Browser 를 놓는 게 안전하다(그 전에 동기 drop 하면 파괴 중
// use-after-free 로 크래시 — 실측). BROWSERS 제거를 여기서만 한다.
// 새 링크(target=_blank/window.open) 열기 정책 — 플러그인 browserNewWindow 설정 반영. true=새 창(CEF
// 네이티브 팝업), false=새 탭(팝업 취소 + URL 을 프론트로 emit → 플러그인이 인앱 새 탭). 전역(플러그인
// 설정이 전역이라 브라우저별 아님).
static POPUP_AS_WINDOW: AtomicBool = AtomicBool::new(false);
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

pub fn set_app_handle(h: tauri::AppHandle) {
    let _ = APP_HANDLE.set(h);
}
pub fn set_popup_window(as_window: bool) {
    POPUP_AS_WINDOW.store(as_window, Ordering::Relaxed);
}

wrap_life_span_handler! {
    struct CefLifeSpanHandler {}
    impl LifeSpanHandler {
        // 새 링크 열기 — 설정 반영(꼼수 아님, 코어가 CEF 팝업을 설정대로 라우팅).
        fn on_before_popup(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _popup_id: i32,
            target_url: Option<&CefString>,
            _target_frame_name: Option<&CefString>,
            _target_disposition: WindowOpenDisposition,
            _user_gesture: i32,
            _popup_features: Option<&PopupFeatures>,
            _window_info: Option<&mut WindowInfo>,
            _client: Option<&mut Option<Client>>,
            _settings: Option<&mut BrowserSettings>,
            _extra_info: Option<&mut Option<DictionaryValue>>,
            _no_js_access: Option<&mut i32>,
        ) -> i32 {
            let url = target_url.map(|u| u.to_string()).unwrap_or_default();
            if POPUP_AS_WINDOW.load(Ordering::Relaxed) {
                eprintln!("[cef] on_before_popup → 새 창(네이티브) url={url}");
                return 0; // 새 창 = CEF 네이티브 팝업 허용
            }
            // 새 탭 = 팝업 취소 + URL 을 프론트로 emit(플러그인이 인앱 새 탭으로 연다)
            if let Some(app) = APP_HANDLE.get() {
                use tauri::Emitter;
                let _ = app.emit("cef-popup", url.clone());
            }
            eprintln!("[cef] on_before_popup → 새 탭(emit cef-popup) url={url}");
            1 // cancel
        }
        fn do_close(&self, _browser: Option<&mut Browser>) -> i32 {
            // 1 = 앱이 close 를 처리(CEF 가 호스트 NSWindow 를 닫지 못하게). set_as_child 의 부모
            // 창은 Tauri 소유라, 0(기본)이면 CEF 가 그 창을 닫으려다 내부 무한 재귀로 행(실측).
            // 1 이면 CEF 는 child 뷰만 정리하고 on_before_close 로 이어진다.
            1
        }
        fn on_before_close(&self, browser: Option<&mut Browser>) {
            // 콜백 안에서 Browser 를 drop 하지 않는다(파괴 재진입 크래시). identifier 만 기록하고
            // 실제 제거/drop 은 다음 pump(reap_closing)로 미룬다.
            if let Some(b) = browser {
                let closing = b.identifier();
                if let Ok(mut q) = CLOSING.lock() {
                    q.push(closing);
                }
                schedule_pump(0);
                eprintln!("[cef] on_before_close (cef_id={closing})");
            }
        }
    }
}

// LoadHandler — 로딩 상태. 로딩 중엔 LOADING 에 넣어 렌더 틱을 확실히 유지(present 가 가장 필요한 구간),
// 완료 시 빼고 grace 를 준다(로드 후 지연 페인트).
wrap_load_handler! {
    struct CefLoadHandler {}
    impl LoadHandler {
        fn on_loading_state_change(
            &self,
            browser: Option<&mut Browser>,
            is_loading: i32,
            _can_go_back: i32,
            _can_go_forward: i32,
        ) {
            if let Some(b) = browser {
                let cid = b.identifier();
                if let Ok(mut s) = LOADING.lock() {
                    if is_loading == 1 { s.insert(cid); } else { s.remove(&cid); }
                }
            }
            bump_active();
        }
    }
}

wrap_client! {
    struct CefClient {}
    impl Client {
        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(CefLifeSpanHandler::new())
        }
        fn load_handler(&self) -> Option<LoadHandler> {
            Some(CefLoadHandler::new())
        }
    }
}

// 프로세스 진입 최초 — framework 로드 + api_hash + execute_process. CEF 서브프로세스면 Some(code) 반환
// (호출자가 그 코드로 종료). 브라우저(메인) 프로세스면 None(계속 진행). enabled() 아니면 None.
pub fn execute_and_route() -> Option<i32> {
    if !enabled() {
        return None;
    }
    // framework 로드: 번들(../Frameworks) 우선, dev 는 SOKSAK_CEF_FRAMEWORK 로 명시 경로.
    let exe = std::env::current_exe().ok()?;
    let loaded = if let Ok(dir) = std::env::var("SOKSAK_CEF_FRAMEWORK") {
        let p = std::path::Path::new(&dir)
            .join("Chromium Embedded Framework.framework/Chromium Embedded Framework");
        load_framework_at(&p)
    } else {
        LibraryLoader::new(&exe, false).load()
    };
    if !loaded {
        eprintln!("[cef] framework 로드 실패 — CEF 비활성");
        return None;
    }
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);

    let args = Args::new();
    let is_browser = args
        .as_cmd_line()
        .map(|c| c.has_switch(Some(&CefString::from("type"))) != 1)
        .unwrap_or(true);
    let mut app = CefApp::new();
    let code = execute_process(Some(args.as_main_args()), Some(&mut app), std::ptr::null_mut());
    if is_browser {
        None // 메인 프로세스 — 계속 진행(이후 init 호출)
    } else {
        Some(code) // 서브프로세스 — 이 코드로 종료
    }
}

fn load_framework_at(path: &std::path::Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    unsafe { load_library(Some(&*c.as_ptr().cast())) == 1 }
}

// cef_initialize — execute_and_route 가 None(메인) 반환 후 1회. 성공 시 true.
pub fn initialize_engine() -> bool {
    if !enabled() {
        return false;
    }
    let args = Args::new();
    let mut settings = Settings::default();
    settings.no_sandbox = 1;
    settings.external_message_pump = 1; // 스레드루프 안 돌고 OnScheduleMessagePumpWork 로 pump 지시
    // root_cache_path 미설정(in-memory) — 디스크 쿠키 DB 가 없으면 os_crypt 가 키체인("Chromium Safe
    // Storage")을 안 건드려 ad-hoc dev 재프롬프트가 원천 사라진다(그 모달이 메인 스레드를 막아 흰 화면의
    // 진짜 공범이었다). dev 브라우저는 세션 지속 불요. 프로덕션은 정식 서명 + 영속 cache 로 전환.
    // 서브프로세스 helper 경로(env). 미설정 시 번들 자동 파생.
    if let Ok(helper) = std::env::var("SOKSAK_CEF_HELPER") {
        settings.browser_subprocess_path = CefString::from(helper.as_str());
    }
    // dlopen 한 framework 의 리소스(icudtl.dat/locales/.pak)를 CEF 에 알려준다 — 앱 번들에 CEF 가 없는
    // dev 경로에선 필수(없으면 "icudtl.dat not found" 로 죽음). framework_dir_path=.framework 디렉토리,
    // resources_dir_path=그 Resources.
    if let Ok(fw_dir) = std::env::var("SOKSAK_CEF_FRAMEWORK") {
        let framework = format!("{fw_dir}/Chromium Embedded Framework.framework");
        settings.framework_dir_path = CefString::from(framework.as_str());
        settings.resources_dir_path = CefString::from(format!("{framework}/Resources").as_str());
    }
    // main_bundle_path — CEF mach-port rendezvous 서비스명은 메인 번들 정체성에서 파생된다. helper 가
    // 사이드카 번들 정체성으로 서비스를 찾으므로, 브라우저(soksak) 프로세스도 같은 번들을 메인으로
    // 인식하게 해 서비스명을 일치시킨다(dev — soksak.app 에 CEF 정식 번들 전까지의 경로).
    if let Ok(bundle) = std::env::var("SOKSAK_CEF_MAIN_BUNDLE") {
        settings.main_bundle_path = CefString::from(bundle.as_str());
    }
    let mut app = CefApp::new();
    let ok = initialize(
        Some(args.as_main_args()),
        Some(&settings),
        Some(&mut app),
        std::ptr::null_mut(),
    ) == 1;
    if ok {
        eprintln!("[cef] initialize OK (in-process)");
    } else {
        eprintln!("[cef] initialize 실패");
    }
    ok
}

// 플러그인/커맨드가 부르는 임베드 요청 — nsview(부모)·rect·url 로 pane 에 CEF child 를 만든다. id 반환.
// PENDING 에 넣고 즉시 pump 를 예약(메인 스레드에서 apply_pending 이 실제 생성).
pub fn request_create(nsview: usize, x: i32, y: i32, w: i32, h: i32, url: String) -> u32 {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut q) = PENDING.lock() {
        q.push(CreateReq { id, nsview, x, y, w, h, url });
    }
    schedule_pump(0);
    id
}

// 커맨드 구현 — 창의 contentView(NSView)를 부모로 CEF child 임베드 요청. 메인 스레드에서 NSView 취득.
pub fn create_in_window(
    window: &tauri::Window,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    url: String,
) -> Result<u32, String> {
    if !enabled() {
        return Err("CEF 비활성(SOKSAK_CEF 미설정)".into());
    }
    use std::sync::mpsc;
    use std::time::Duration;
    let (tx, rx) = mpsc::sync_channel::<usize>(1);
    let win = window.clone();
    window
        .run_on_main_thread(move || {
            let mut ptr = 0usize;
            #[cfg(target_os = "macos")]
            unsafe {
                if let Ok(ns) = win.ns_window() {
                    let win_obj = &*(ns as *const objc2::runtime::AnyObject);
                    let content: *mut objc2_app_kit::NSView =
                        objc2::msg_send![win_obj, contentView];
                    ptr = content as usize;
                }
            }
            let _ = tx.try_send(ptr);
        })
        .map_err(|e| e.to_string())?;
    let nsview = rx
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "NSView 취득 시간 초과".to_string())?;
    if nsview == 0 {
        return Err("NSView 취득 실패".into());
    }
    Ok(request_create(nsview, x, y, w, h, url))
}

pub fn shutdown_engine() {
    if enabled() {
        shutdown();
    }
}
