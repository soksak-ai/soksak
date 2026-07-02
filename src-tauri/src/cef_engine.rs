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
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{LazyLock, Mutex};

use cef::args::Args;
use cef::library_loader::LibraryLoader;
use cef::rc::*;
use cef::*;

// CEF 활성 여부 — env SOKSAK_CEF=1 일 때만. 미설정 시 이 모듈의 모든 진입은 no-op(기본 시작 무영향).
pub fn enabled() -> bool {
    std::env::var("SOKSAK_CEF").ok().as_deref() == Some("1")
}

// 임베드 대기 요청(플러그인 → 커맨드 → 여기). CEF 조작은 UI(메인) 스레드에서만 하므로 큐잉 후 pump 에서 적용.
struct CreateReq {
    nsview: usize,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    url: String,
}
static PENDING: LazyLock<Mutex<Vec<CreateReq>>> = LazyLock::new(|| Mutex::new(Vec::new()));
static NEXT_ID: AtomicU32 = AtomicU32::new(1);
// 생성된 브라우저: id → Browser. bounds/navigate/close 는 여기서 찾아 적용(후속).
static BROWSERS: LazyLock<Mutex<Vec<(u32, Browser)>>> = LazyLock::new(|| Mutex::new(Vec::new()));

// ── 메시지펌프 스케줄링(GCD 메인큐, 비재진입) ──────────────────────────────────────────────
// PUMP_SCHEDULED: GCD 블록이 하나 예약돼 있음(중복 예약 억제). IN_WORK: do_message_loop_work 실행 중
// (런루프 spin 으로 재진입 시 감지). REDO: 실행 중 새 요청이 왔음 → 끝나고 즉시 한 번 더.
static PUMP_SCHEDULED: AtomicBool = AtomicBool::new(false);
static IN_WORK: AtomicBool = AtomicBool::new(false);
static REDO: AtomicBool = AtomicBool::new(false);

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
    do_message_loop_work();
    IN_WORK.store(false, Ordering::SeqCst);
    if REDO.swap(false, Ordering::SeqCst) {
        schedule_pump(0);
    }
}

// 대기 CreateReq → set_as_child 로 CEF child 브라우저 생성(메인 스레드에서만).
fn apply_pending() {
    let reqs: Vec<CreateReq> =
        PENDING.lock().map(|mut q| q.drain(..).collect()).unwrap_or_default();
    for r in reqs {
        let wi = WindowInfo::default().set_as_child(
            r.nsview as *mut c_void,
            &Rect { x: r.x, y: r.y, width: r.w.max(1), height: r.h.max(1) },
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
            let id = NEXT_ID.load(Ordering::Relaxed);
            if let Ok(mut list) = BROWSERS.lock() {
                list.push((id, b));
            }
            eprintln!("[cef] child browser 생성 OK (nsview={:#x})", r.nsview);
        } else {
            eprintln!("[cef] child browser 생성 실패");
        }
    }
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
                c.append_switch(Some(&CefString::from("disable-gpu")));
                c.append_switch(Some(&CefString::from("disable-gpu-compositing")));
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

wrap_client! {
    struct CefClient {}
    impl Client {}
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
    let cache = std::env::temp_dir().join(format!("soksak-cef-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&cache);
    let mut settings = Settings::default();
    settings.no_sandbox = 1;
    settings.external_message_pump = 1; // 스레드루프 안 돌고 OnScheduleMessagePumpWork 로 pump 지시
    settings.root_cache_path = CefString::from(cache.to_string_lossy().as_ref());
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
        q.push(CreateReq { nsview, x, y, w, h, url });
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
