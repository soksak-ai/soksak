// soksak-sidecar-chromium — Chromium 엔진 사이드카의 C ABI 표면(soksak-sidecar-engine ABI@1).
// 코어(sidecar.rs)가 dlopen 으로 이 심볼들을 해소한다. 규범 정의 = docs/SIDECARS.md §3.
//
// 계약 요점: 모든 export 는 catch_unwind 로 감싼다(-2 = 패닉 트랩 — FFI 경계 unwinding 금지),
// message/notify 는 임의 스레드에서 호출될 수 있고(엔진 내부가 메인큐로 큐잉), init/shutdown 은
// 호스트가 메인스레드를 보장한다. reply 버퍼는 모듈이 할당하고 호스트가 soksak_sidecar_engine_free 로 돌려준다.

#![cfg(target_os = "macos")]

mod engine;

use std::ffi::{c_char, c_void};
use std::sync::OnceLock;

// ── 호스트 vtable 사본(코어 sidecar.rs 와 동일 레이아웃 — SIDECARS.md §3 이 규범) ──────────────

pub const HOST_ABI_VERSION: u32 = 1;

#[repr(C)]
pub struct SoksakSidecarEngineAbi {
    pub abi: u32,
    pub interface: *const c_char,
    pub version: *const c_char,
}
unsafe impl Sync for SoksakSidecarEngineAbi {}

#[repr(C)]
pub struct SoksakSidecarEngineHost {
    pub abi: u32,
    pub ctx: *mut c_void,
    pub emit: extern "C" fn(ctx: *mut c_void, json: *const u8, len: usize),
    pub log: extern "C" fn(ctx: *mut c_void, level: i32, msg: *const u8, len: usize),
}

#[repr(C)]
pub struct SoksakBuf {
    pub ptr: *mut u8,
    pub len: usize,
    pub cap: usize,
}

// 저장된 호스트 콜백(값 복사 — 호스트가 leak 으로 영구 보장). Send/Sync: fn 포인터 + 호스트가
// 임의 스레드 호출을 허용하는 계약이므로 안전.
struct HostFns {
    ctx: usize,
    emit: extern "C" fn(ctx: *mut c_void, json: *const u8, len: usize),
}
static HOST: OnceLock<HostFns> = OnceLock::new();

// 엔진(engine.rs)이 이벤트를 호스트로 내보내는 유일한 문 — 열린 플러그인 채널 전부에 relay 된다.
pub(crate) fn host_emit_json(value: &serde_json::Value) {
    if let Some(h) = HOST.get() {
        let bytes = value.to_string().into_bytes();
        (h.emit)(h.ctx as *mut c_void, bytes.as_ptr(), bytes.len());
    }
}

// ── 자기기술(무매니페스트 — 바이너리가 곧 진실) ──────────────────────────────────────────────

static ABI: SoksakSidecarEngineAbi = SoksakSidecarEngineAbi {
    abi: HOST_ABI_VERSION,
    interface: c"soksak-browser-engine@1".as_ptr(),
    version: c"0.1.0".as_ptr(),
};

// 모델 선언 = 이 심볼 가족(soksak_sidecar_engine_*)의 존재 그 자체 — model 필드로 재진술하지 않는다
// (이중진실 금지: engine 심볼을 export 하며 다른 모델을 주장하는 모순이 성립 불가하도록).
#[no_mangle]
pub extern "C" fn soksak_sidecar_engine_abi() -> *const SoksakSidecarEngineAbi {
    &ABI
}

// ── init / shutdown (메인스레드 — 호스트 보장) ───────────────────────────────────────────────

#[no_mangle]
pub extern "C" fn soksak_sidecar_engine_init(
    host: *const SoksakSidecarEngineHost,
    cfg_json: *const u8,
    cfg_len: usize,
) -> i32 {
    std::panic::catch_unwind(|| {
        if host.is_null() || cfg_json.is_null() {
            return 1;
        }
        let h = unsafe { &*host };
        if h.abi != HOST_ABI_VERSION {
            return 2;
        }
        let _ = HOST.set(HostFns { ctx: h.ctx as usize, emit: h.emit });
        let cfg_bytes = unsafe { std::slice::from_raw_parts(cfg_json, cfg_len) };
        let Ok(cfg) = serde_json::from_slice::<serde_json::Value>(cfg_bytes) else {
            return 3;
        };
        let Some(dist) = cfg.get("distDir").and_then(|d| d.as_str()) else {
            return 3;
        };
        if engine::initialize(std::path::Path::new(dist)) {
            0
        } else {
            4
        }
    })
    .unwrap_or(-2)
}

#[no_mangle]
pub extern "C" fn soksak_sidecar_engine_shutdown() {
    let _ = std::panic::catch_unwind(engine::shutdown_engine);
}

// ── message: 불투명 요청 디스패치(soksak-browser-engine@1 프로토콜) ─────────────────────────

fn reply_into(buf: *mut SoksakBuf, value: serde_json::Value) {
    if buf.is_null() {
        return;
    }
    let mut bytes = value.to_string().into_bytes();
    let out = SoksakBuf { ptr: bytes.as_mut_ptr(), len: bytes.len(), cap: bytes.capacity() };
    std::mem::forget(bytes);
    unsafe { *buf = out };
}

fn dispatch(req: &serde_json::Value, surface: usize) -> Result<serde_json::Value, String> {
    let ty = req.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let id = || req.get("id").and_then(|v| v.as_u64()).map(|v| v as u32).ok_or("id 필요");
    let int = |k: &str| req.get(k).and_then(|v| v.as_i64()).map(|v| v as i32).unwrap_or(0);
    match ty {
        "create" => {
            if surface == 0 {
                return Err("surface(부모 뷰) 없음".into());
            }
            let url = req.get("url").and_then(|u| u.as_str()).unwrap_or("about:blank");
            let id = engine::request_create(
                surface,
                int("x"),
                int("y"),
                int("w").max(1),
                int("h").max(1),
                url.to_string(),
            );
            Ok(serde_json::json!({ "ok": true, "id": id }))
        }
        "bounds" => {
            engine::set_bounds(id()?, int("x"), int("y"), int("w").max(1), int("h").max(1));
            Ok(serde_json::json!({ "ok": true }))
        }
        "load" => {
            let url = req.get("url").and_then(|u| u.as_str()).ok_or("url 필요")?;
            engine::load(id()?, url.to_string());
            Ok(serde_json::json!({ "ok": true }))
        }
        "reload" => {
            let ignore = req.get("ignoreCache").and_then(|v| v.as_bool()).unwrap_or(false);
            engine::reload(id()?, ignore);
            Ok(serde_json::json!({ "ok": true }))
        }
        "back" => {
            engine::go_back(id()?);
            Ok(serde_json::json!({ "ok": true }))
        }
        "forward" => {
            engine::go_forward(id()?);
            Ok(serde_json::json!({ "ok": true }))
        }
        "hidden" => {
            let hidden = req.get("hidden").and_then(|v| v.as_bool()).unwrap_or(false);
            engine::set_hidden(id()?, hidden);
            Ok(serde_json::json!({ "ok": true }))
        }
        "focus" => {
            engine::set_focus(id()?);
            Ok(serde_json::json!({ "ok": true }))
        }
        "close" => {
            engine::close(id()?);
            Ok(serde_json::json!({ "ok": true }))
        }
        "popup-mode" => {
            let as_window = req.get("asWindow").and_then(|v| v.as_bool()).unwrap_or(false);
            engine::set_popup_window(as_window);
            Ok(serde_json::json!({ "ok": true }))
        }
        other => Err(format!("미지 요청 type: {other}")),
    }
}

#[no_mangle]
pub extern "C" fn soksak_sidecar_engine_message(
    req: *const u8,
    len: usize,
    surface: usize,
    reply: *mut SoksakBuf,
) -> i32 {
    std::panic::catch_unwind(|| {
        if req.is_null() {
            reply_into(reply, serde_json::json!({ "error": "빈 요청" }));
            return -1;
        }
        let bytes = unsafe { std::slice::from_raw_parts(req, len) };
        let parsed: serde_json::Value = match serde_json::from_slice(bytes) {
            Ok(v) => v,
            Err(e) => {
                reply_into(reply, serde_json::json!({ "error": format!("요청 JSON 파싱 실패: {e}") }));
                return -1;
            }
        };
        match dispatch(&parsed, surface) {
            Ok(v) => {
                reply_into(reply, v);
                0
            }
            Err(msg) => {
                reply_into(reply, serde_json::json!({ "error": msg }));
                -1
            }
        }
    })
    .unwrap_or(-2)
}

// ── notify: 호스트 사실 통지(fire-and-forget) ────────────────────────────────────────────────

#[no_mangle]
pub extern "C" fn soksak_sidecar_engine_notify(evt: *const u8, len: usize) {
    let _ = std::panic::catch_unwind(|| {
        if evt.is_null() {
            return;
        }
        let bytes = unsafe { std::slice::from_raw_parts(evt, len) };
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(bytes) else {
            return;
        };
        if v.get("type").and_then(|t| t.as_str()) == Some("surface-occluded") {
            let occluded = v.get("occluded").and_then(|o| o.as_bool()).unwrap_or(false);
            engine::set_overlay(occluded);
        }
    });
}

// ── free: message reply 버퍼 반환 ────────────────────────────────────────────────────────────

#[no_mangle]
pub extern "C" fn soksak_sidecar_engine_free(buf: SoksakBuf) {
    let _ = std::panic::catch_unwind(|| {
        if !buf.ptr.is_null() {
            unsafe { drop(Vec::from_raw_parts(buf.ptr, buf.len, buf.cap)) };
        }
    });
}
