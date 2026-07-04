// 사이드카(engine 모델) 호스팅 — 코어의 범용 원시 primitive(A13 의 "webview hosting" 과 같은 층).
// 플러그인이 매니페스트로 선언한 공유 네이티브 모듈(dylib)을 앱 프로세스에 로드하고, 호출 창의
// surface(NSView)와 불투명 메시지 채널을 중개한다. 코어는 메시지 의미(create/navigate …)를 모른다
// — 하는 일은 (1) 선언 interface ↔ 바이너리 자기보고(soksak_sidecar_engine_abi) 대조, (2) surface 주입,
// (3) JSON bytes relay, (4) surface 이벤트(occlusion) 통지뿐. 분류·ABI 정본 = docs/SIDECARS.md.
//
// 수명: 엔진 모듈은 로드 후 절대 unload 하지 않는다(프로세스 종료 시 shutdown 만). 살아있는
// 브라우저류 child 가 모듈 코드를 참조하고, Chromium 계열은 프로세스당 1회 초기화 제약이 있다 —
// unload 는 범주적으로 unsafe. Library 는 의도적으로 leak 한다.
//
// 패닉 경계: 모듈 export 는 자체 catch_unwind(-2 반환) 계약이고, 호스트 vtable(emit/log)도 여기서
// catch_unwind 로 감싼다 — FFI 경계를 넘는 unwinding 은 양방향 0.

use std::collections::HashMap;
use std::ffi::{c_char, c_void, CStr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use tauri::ipc::Channel;

// ── C ABI v1 (docs/SIDECARS.md §3 이 규범 — 여기와 사이드카 크레이트가 동일 레이아웃을 미러) ──────

pub const HOST_ABI_VERSION: u32 = 1;

#[repr(C)]
pub struct SoksakSidecarEngineAbi {
    pub abi: u32,                 // 호스팅 ABI 버전 — 정확 일치만 수용
    pub interface: *const c_char, // "<protocol-domain>@<major>(예: soksak-sidecar-browser-spec@1)" — 메시지 프로토콜 id
    pub version: *const c_char,   // 크레이트 semver(진단용)
}

#[repr(C)]
pub struct SoksakSidecarEngineHost {
    pub abi: u32,
    pub ctx: *mut c_void,
    // 모듈→호스트 이벤트(JSON bytes). 임의 스레드. 호스트가 열린 플러그인 채널 전부에 relay.
    pub emit: extern "C" fn(ctx: *mut c_void, json: *const u8, len: usize),
    // 모듈→호스트 로그. level: 0=info 1=warn 2=error. 임의 스레드.
    pub log: extern "C" fn(ctx: *mut c_void, level: i32, msg: *const u8, len: usize),
}

#[repr(C)]
pub struct SoksakBuf {
    pub ptr: *mut u8,
    pub len: usize,
    pub cap: usize,
}

type AbiFn = unsafe extern "C" fn() -> *const SoksakSidecarEngineAbi;
type InitFn = unsafe extern "C" fn(host: *const SoksakSidecarEngineHost, cfg: *const u8, cfg_len: usize) -> i32;
type MessageFn =
    unsafe extern "C" fn(req: *const u8, len: usize, surface: usize, reply: *mut SoksakBuf) -> i32;
type NotifyFn = unsafe extern "C" fn(evt: *const u8, len: usize);
type FreeFn = unsafe extern "C" fn(buf: SoksakBuf);
type ShutdownFn = unsafe extern "C" fn();

// ── 로드된 모듈 레지스트리 ────────────────────────────────────────────────────────────────────

struct EngineModule {
    name: String,
    #[allow(dead_code)] // 진단용(로드 시 대조 후 보관)
    interface: String, // 바이너리 자기보고(선언과 대조 완료된 값)
    message: MessageFn,
    notify: NotifyFn,
    free: FreeFn,
    shutdown: ShutdownFn,
    clients: Mutex<HashMap<u64, Channel<serde_json::Value>>>,
    next_handle: AtomicU64,
}

static MODULES: LazyLock<Mutex<HashMap<String, Arc<EngineModule>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

// 호스트 vtable ctx — 모듈 이름만 담아 emit 시 레지스트리 역참조. 모듈과 함께 영구(leak).
struct HostCtx {
    name: String,
}

extern "C" fn host_emit(ctx: *mut c_void, json: *const u8, len: usize) {
    let _ = std::panic::catch_unwind(|| {
        if ctx.is_null() || json.is_null() {
            return;
        }
        let name = unsafe { &(*(ctx as *const HostCtx)).name };
        let bytes = unsafe { std::slice::from_raw_parts(json, len) };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
            eprintln!("[sidecar:{name}] emit: JSON 파싱 실패({len}B) — 무시");
            return;
        };
        // 호스트 사실 이벤트 가로채기 — 엔진 native surface 의 레이어 편입/해제(hitTest 위임 대상).
        // 클라이언트 relay 는 그대로(플러그인이 알 필요는 없지만 막을 이유도 없다).
        #[cfg(target_os = "macos")]
        if let Some(ptr) = value.get("view").and_then(|v| v.as_u64()) {
            match value.get("event").and_then(|e| e.as_str()) {
                Some("surface-created") => crate::webview::register_engine_surface(ptr as usize),
                Some("surface-destroyed") => crate::webview::unregister_engine_surface(ptr as usize),
                _ => {}
            }
        }
        let module = MODULES.lock().ok().and_then(|m| m.get(name).cloned());
        if let Some(m) = module {
            if let Ok(clients) = m.clients.lock() {
                for ch in clients.values() {
                    let _ = ch.send(value.clone());
                }
            }
        }
    });
}

extern "C" fn host_log(ctx: *mut c_void, level: i32, msg: *const u8, len: usize) {
    let _ = std::panic::catch_unwind(|| {
        if ctx.is_null() || msg.is_null() {
            return;
        }
        let name = unsafe { &(*(ctx as *const HostCtx)).name };
        let text = String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(msg, len) });
        let tag = match level {
            2 => "error",
            1 => "warn",
            _ => "info",
        };
        eprintln!("[sidecar:{name}] {tag}: {text}");
    });
}

// ── 경로 해소(순수 — 유닛테스트 대상) ─────────────────────────────────────────────────────────

// 사이드카 이름 검증 — 경로 조립에 들어가므로 traversal 가드를 겸한다(매니페스트 파서와 동일 규칙).
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

// dylib 경로 = <identity 홈>/sidecars/soksak-sidecar-{name}/dist/… 하나뿐 — env 바이너리 주입은
// 없다(A17: 상시 env 주입 금지 — identity 홈 분리로 존재 이유가 소멸했다. dev 는 자기 홈의
// 체크아웃에 stage.sh 로 dist 를 스테이징한다).
fn module_path(name: &str, soksak_home: &std::path::Path) -> std::path::PathBuf {
    soksak_home
        .join("sidecars")
        .join(format!("soksak-sidecar-{name}"))
        .join("dist")
        .join(format!("soksak-sidecar-{name}.dylib"))
}

fn resolve_module_path(name: &str) -> Result<std::path::PathBuf, String> {
    let path = module_path(name, &crate::home::soksak_home());
    if !path.is_file() {
        return Err(format!(
            "사이드카 모듈 없음: {} (설치: 플러그인 reach 또는 dev 스테이징 `make sidecar-{name}`)",
            path.display()
        ));
    }
    Ok(path)
}

// ── 로드 + ABI 검증 + init ───────────────────────────────────────────────────────────────────

unsafe fn cstr_of(p: *const c_char, what: &str) -> Result<String, String> {
    if p.is_null() {
        return Err(format!("ABI 자기보고 {what} 가 null"));
    }
    Ok(CStr::from_ptr(p).to_string_lossy().into_owned())
}

// 최초 open 시 1회 — dlopen → soksak_sidecar_engine_abi 대조 → 메인스레드 init(rendezvous). 성공 시 등록.
fn load_module(
    window: &tauri::Window,
    name: &str,
    declared_interface: &str,
) -> Result<Arc<EngineModule>, String> {
    let path = resolve_module_path(name)?;
    let lib = unsafe { libloading::Library::new(&path) }
        .map_err(|e| format!("dlopen 실패 {}: {e}", path.display()))?;

    // 심볼 해소(전부 먼저 — 하나라도 없으면 거부, 부분 로드 없음).
    // 모델 판정 = 심볼 가족 존재 그 자체(soksak_sidecar_engine_* export = engine 모델). model 필드 재진술 없음.
    let abi_fn: AbiFn = *unsafe { lib.get(b"soksak_sidecar_engine_abi\0") }
        .map_err(|e| format!("심볼 soksak_sidecar_engine_abi 없음(engine 모델 아님?): {e}"))?;
    let init_fn: InitFn = *unsafe { lib.get(b"soksak_sidecar_engine_init\0") }
        .map_err(|e| format!("심볼 soksak_sidecar_engine_init 없음: {e}"))?;
    let message: MessageFn = *unsafe { lib.get(b"soksak_sidecar_engine_message\0") }
        .map_err(|e| format!("심볼 soksak_sidecar_engine_message 없음: {e}"))?;
    let notify: NotifyFn = *unsafe { lib.get(b"soksak_sidecar_engine_notify\0") }
        .map_err(|e| format!("심볼 soksak_sidecar_engine_notify 없음: {e}"))?;
    let free: FreeFn = *unsafe { lib.get(b"soksak_sidecar_engine_free\0") }
        .map_err(|e| format!("심볼 soksak_sidecar_engine_free 없음: {e}"))?;
    let shutdown: ShutdownFn = *unsafe { lib.get(b"soksak_sidecar_engine_shutdown\0") }
        .map_err(|e| format!("심볼 soksak_sidecar_engine_shutdown 없음: {e}"))?;

    // 자기기술 대조 — 무매니페스트 원칙의 검증 지점: 바이너리가 곧 진실, 선언과 불일치 = 거부.
    let abi = unsafe { abi_fn() };
    if abi.is_null() {
        return Err("soksak_sidecar_engine_abi() 가 null 반환".into());
    }
    let (abi_ver, iface) = unsafe { ((*abi).abi, cstr_of((*abi).interface, "interface")?) };
    if abi_ver != HOST_ABI_VERSION {
        return Err(format!("호스팅 ABI 불일치: 모듈 {abi_ver}, 코어 {HOST_ABI_VERSION}"));
    }
    if iface != declared_interface {
        return Err(format!(
            "interface 불일치: 플러그인 선언 \"{declared_interface}\" ↔ 바이너리 자기보고 \"{iface}\""
        ));
    }

    // init 은 메인스레드 계약 — invoke 스레드에서 rendezvous 로 위임(타임아웃 10s).
    let host_ctx = Box::into_raw(Box::new(HostCtx { name: name.to_string() }));
    let host = Box::into_raw(Box::new(SoksakSidecarEngineHost {
        abi: HOST_ABI_VERSION,
        ctx: host_ctx as *mut c_void,
        emit: host_emit,
        log: host_log,
    }));
    let dist_dir = path.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let cfg = serde_json::json!({ "name": name, "distDir": dist_dir })
        .to_string()
        .into_bytes();
    let (tx, rx) = std::sync::mpsc::sync_channel::<i32>(1);
    let host_addr = host as usize;
    window
        .run_on_main_thread(move || {
            let cfg = cfg; // move
            let code = unsafe { init_fn(host_addr as *const SoksakSidecarEngineHost, cfg.as_ptr(), cfg.len()) };
            let _ = tx.try_send(code);
        })
        .map_err(|e| e.to_string())?;
    let code = rx
        .recv_timeout(std::time::Duration::from_secs(10))
        .map_err(|_| "사이드카 init 시간 초과(10s)".to_string())?;
    if code != 0 {
        return Err(format!("사이드카 init 거부(code {code}) — 로그 참조"));
    }

    // 성공 — Library 는 의도적 leak(모듈 unload 금지 계약).
    std::mem::forget(lib);
    Ok(Arc::new(EngineModule {
        name: name.to_string(),
        interface: iface,
        message,
        notify,
        free,
        shutdown,
        clients: Mutex::new(HashMap::new()),
        next_handle: AtomicU64::new(1),
    }))
}

// ── surface(NSView) 취득 — 창 label 별 캐시, Destroyed 에서 무효화 ────────────────────────────

static SURFACES: LazyLock<Mutex<HashMap<String, usize>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn content_view_of(window: &tauri::Window) -> Result<usize, String> {
    let label = window.label().to_string();
    if let Some(&ptr) = SURFACES.lock().ok().as_ref().and_then(|m| m.get(&label)) {
        return Ok(ptr);
    }
    use std::sync::mpsc;
    let (tx, rx) = mpsc::sync_channel::<usize>(1);
    let win = window.clone();
    window
        .run_on_main_thread(move || {
            let mut ptr = 0usize;
            #[cfg(target_os = "macos")]
            unsafe {
                if let Ok(ns) = win.ns_window() {
                    let win_obj = &*(ns as *const objc2::runtime::AnyObject);
                    let content: *mut objc2_app_kit::NSView = objc2::msg_send![win_obj, contentView];
                    ptr = content as usize;
                }
            }
            let _ = tx.try_send(ptr);
        })
        .map_err(|e| e.to_string())?;
    let ptr = rx
        .recv_timeout(std::time::Duration::from_secs(2))
        .map_err(|_| "NSView 취득 시간 초과".to_string())?;
    if ptr == 0 {
        return Err("NSView 취득 실패".into());
    }
    if let Ok(mut m) = SURFACES.lock() {
        m.insert(label, ptr);
    }
    Ok(ptr)
}

// 창 파괴 시 캐시 무효화 — lib.rs WindowEvent::Destroyed 에서 호출(stale 포인터 방지).
pub fn forget_window(label: &str) {
    if let Ok(mut m) = SURFACES.lock() {
        m.remove(label);
    }
}

// ── Tauri 커맨드(레지스트리 미노출 — app.sidecar 전용 내부 전송) ──────────────────────────────

fn get_module(name: &str) -> Result<Arc<EngineModule>, String> {
    MODULES
        .lock()
        .map_err(|e| e.to_string())?
        .get(name)
        .cloned()
        .ok_or_else(|| format!("사이드카 미로드: {name}"))
}

#[tauri::command]
pub fn sidecar_open(
    window: tauri::Window,
    name: String,
    interface: String,
    on_event: Channel<serde_json::Value>,
) -> Result<u64, String> {
    if !valid_name(&name) {
        return Err(format!("사이드카 이름 형식 오류: {name} (^[a-z0-9][a-z0-9-]*$)"));
    }
    let module = {
        let existing = MODULES.lock().map_err(|e| e.to_string())?.get(&name).cloned();
        match existing {
            Some(m) => m, // 재open = 재사용(엔진은 프로세스당 1회 로드·초기화)
            None => {
                let m = load_module(&window, &name, &interface)?;
                MODULES.lock().map_err(|e| e.to_string())?.insert(name.clone(), m.clone());
                eprintln!("[sidecar:{name}] 로드 OK (interface {})", m.interface);
                m
            }
        }
    };
    let handle = module.next_handle.fetch_add(1, Ordering::Relaxed);
    module.clients.lock().map_err(|e| e.to_string())?.insert(handle, on_event);
    eprintln!("[sidecar:{name}] 채널 open (handle={handle})");
    Ok(handle)
}

#[tauri::command]
pub fn sidecar_send(
    window: tauri::Window,
    name: String,
    handle: u64,
    payload: String,
) -> Result<serde_json::Value, String> {
    let module = get_module(&name).inspect_err(|e| eprintln!("[sidecar:{name}] send 거부: {e}"))?;
    if !module.clients.lock().map_err(|e| e.to_string())?.contains_key(&handle) {
        eprintln!("[sidecar:{name}] send 거부: 무효 핸들 {handle} (payload {} bytes)", payload.len());
        return Err(format!("무효 핸들: {handle}"));
    }
    let surface = content_view_of(&window)?;
    let mut reply = SoksakBuf { ptr: std::ptr::null_mut(), len: 0, cap: 0 };
    let code = unsafe { (module.message)(payload.as_ptr(), payload.len(), surface, &mut reply) };
    let body = if reply.ptr.is_null() {
        Vec::new()
    } else {
        let v = unsafe { std::slice::from_raw_parts(reply.ptr, reply.len) }.to_vec();
        unsafe { (module.free)(reply) };
        v
    };
    match code {
        0 => serde_json::from_slice(&body).map_err(|e| format!("모듈 응답 JSON 파싱 실패: {e}")),
        -2 => Err("사이드카 모듈 내부 패닉(트랩됨) — 로그 참조".into()),
        c => {
            let msg = serde_json::from_slice::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
                .unwrap_or_else(|| format!("모듈 오류(code {c})"));
            Err(msg)
        }
    }
}

// 사이드카 공급(fetch reach) — 미설치면 sha256 핀 아카이브(dist tar.gz)를 받아 설치. 멱등:
// entry(dylib) 존재 = "present" 즉시 반환. 경로는 이름에서만 파생(경로 주입 없음 — traversal 가드).
// app.sidecar.open 직전에 어댑터가 부른다(lazy 공급 — 선언에 reach 있을 때만).
#[tauri::command]
pub fn sidecar_ensure(name: String, url: String, sha256: String) -> Result<String, String> {
    if !valid_name(&name) {
        return Err(format!("사이드카 이름 형식 오류: {name}"));
    }
    // dest = dist 디렉토리 자체(아카이브 = dist 내용물). 사이드카 루트는 이미 존재할 수 있다
    // (백업·데이터) — 원자 rename 의 대상은 항상 새로 생기는 dist 다.
    let dest = crate::home::soksak_home()
        .join("sidecars")
        .join(format!("soksak-sidecar-{name}"))
        .join("dist");
    let entry = format!("soksak-sidecar-{name}.dylib");
    if dest.join(&entry).is_file() {
        return Ok("present".into());
    }
    eprintln!("[sidecar:{name}] fetch 설치 시작: {url}");
    crate::runtime_dep::download_unpack_verify(&url, &sha256, &dest, &entry)
        .inspect_err(|e| eprintln!("[sidecar:{name}] fetch 설치 실패: {e}"))?;
    eprintln!("[sidecar:{name}] fetch 설치 완료: {}", dest.display());
    Ok("fetched".into())
}

#[tauri::command]
pub fn sidecar_close(name: String, handle: u64) -> Result<(), String> {
    let module = get_module(&name)?;
    module.clients.lock().map_err(|e| e.to_string())?.remove(&handle);
    eprintln!("[sidecar:{name}] 채널 close (handle={handle})");
    // 모듈 자체는 상주 유지(unload 금지) — 채널만 닫는다.
    Ok(())
}

// ── 호스트→모듈 통지 / 종료 ──────────────────────────────────────────────────────────────────

// 로드된 모든 엔진 모듈에 호스트 사실 통지(v1: surface-occluded). 모듈 0 개면 no-op.
// 파괴 순서 계약(docs/SIDECARS.md) — 창이 닫히기 전에(CloseRequested, 메인 스레드) 그 창의
// surface(content NSView)에 부모 지정된 엔진 child 를 엔진이 먼저 닫도록 통지한다. 살아있는
// 엔진 NSView 위에서 창 dealloc 이 진행되는 것을 금지하는 수명주기 규칙 — 닫힘이 Destroyed 에
// 못 도달하는 wedge(좀비 창: 목록엔 있는데 웹뷰 죽음·claim 미해제) 부류의 구조적 차단.
#[cfg(target_os = "macos")]
pub fn notify_surface_closing(window: &tauri::Window) {
    match content_view_of(window) {
        Ok(view) => {
            eprintln!("[sidecar] surface-closing 통지 (window={}, view={view:#x})", window.label());
            notify_all(&serde_json::json!({ "type": "surface-closing", "view": view }));
        }
        Err(e) => eprintln!("[sidecar] surface-closing: content view 실패 ({}): {e}", window.label()),
    }
}

pub fn notify_all(evt: &serde_json::Value) {
    let modules: Vec<Arc<EngineModule>> = match MODULES.lock() {
        Ok(m) => m.values().cloned().collect(),
        Err(_) => return,
    };
    if modules.is_empty() {
        return;
    }
    let bytes = evt.to_string().into_bytes();
    for m in modules {
        unsafe { (m.notify)(bytes.as_ptr(), bytes.len()) };
    }
}

// 앱 종료 시에만(메인스레드 — RunEvent 핸들러). 이 뒤로 모듈 호출 없음.
pub fn shutdown_all() {
    let modules: Vec<Arc<EngineModule>> = match MODULES.lock() {
        Ok(mut m) => m.drain().map(|(_, v)| v).collect(),
        Err(_) => return,
    };
    for m in modules {
        eprintln!("[sidecar:{}] shutdown", m.name);
        unsafe { (m.shutdown)() };
    }
}

// ── 유닛테스트(순수부) ───────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_validation_guards_path_traversal() {
        assert!(valid_name("chromium"));
        assert!(valid_name("a-b-1"));
        assert!(!valid_name(""));
        assert!(!valid_name("-lead"));
        assert!(!valid_name("Upper"));
        assert!(!valid_name("../evil"));
        assert!(!valid_name("a/b"));
        assert!(!valid_name("a.b"));
    }

    #[test]
    fn module_path_default_layout_and_override() {
        // 인자는 identity 홈 자체(home.rs 파생) — 사이드카는 그 아래 sidecars/ 에 산다.
        let home = std::path::Path::new("/Users/x/.soksak-debug");
        assert_eq!(
            module_path("browser-chromium", home),
            std::path::PathBuf::from(
                "/Users/x/.soksak-debug/sidecars/soksak-sidecar-browser-chromium/dist/soksak-sidecar-browser-chromium.dylib"
            )
        );
    }
}
