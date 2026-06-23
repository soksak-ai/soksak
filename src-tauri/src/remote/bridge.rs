// remote::bridge — 앱-기동 glue(additive, 기본 비활성). serve_connection 의 dispatch 를 코어
// route() 로 배선한다(request_command 경유). **기본 비활성**: SOKSAK_REMOTE_TCP 가 명시적으로
// 켜졌을 때만 루프백 리스너가 바인드된다 — 꺼져 있으면 아무 포트도 안 열리고 실행 중 앱은 무영향.
//
// 이 모듈은 기존 동작을 바꾸지 않는다(ipc.rs/route()/UnixListener 무수정). request_command 는
// 이미 pub 이라 그대로 호출한다(ipc.rs 변경 0). 켜져도 레지스트리가 비어 있으면(페어링 UI 후속)
// 모든 연결이 fail-closed — 즉 "켬"이 곧 "노출"이 아니다(페어링이 별도 게이트).
#![allow(dead_code)]

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::ipc::request_command;
use crate::remote::auth::{AuthorizedAction, DeviceRegistry, Scope};
use crate::remote::noise::{PinnedPeerRegistry, StaticKeypair};
use crate::remote::tcp::{accept_loop, bind_loopback, ListenerConfig};
use crate::remote::transport::SharedAuth;

/// 루프백 브리지 활성 env 키 — 명시적·generic(RULE 8). 미설정/"0"/"false" ⇒ 비활성(바인드 0).
pub const ENABLE_ENV: &str = "SOKSAK_REMOTE_TCP";
/// 바인드 포트 env(선택) — 미설정 시 OS 할당(0). 항상 127.0.0.1 에만 바인드(tcp.rs).
pub const PORT_ENV: &str = "SOKSAK_REMOTE_TCP_PORT";

/// env 플래그가 명시적으로 켜졌는가. 미설정/빈/"0"/"false"(대소문자 무시) ⇒ false(기본 비활성).
fn enabled() -> bool {
    match std::env::var(ENABLE_ENV) {
        Ok(v) => {
            let v = v.trim().to_ascii_lowercase();
            !(v.is_empty() || v == "0" || v == "false" || v == "off" || v == "no")
        }
        Err(_) => false,
    }
}

/// 인가된 frame 의 불투명 request 바이트를 코어 route() 로 라우팅하는 dispatch 를 만든다.
///
/// request 바이트는 JSON `{"method": "...", "params": {...}}` 로 해석한다(소켓 JSON-RPC 와 동일
/// 모양). request_command 가 활성 창의 registry 로 디스패치하고 응답 envelope 를 동기 반환한다
/// (단일 실행 경로 — 새 채널 0). action 은 이미 인가됐으므로 여기서 권한 판단 0(로직 누수 0).
fn make_dispatch(app: AppHandle) -> impl FnMut(&AuthorizedAction, &[u8]) -> Vec<u8> + Send + 'static {
    move |action: &AuthorizedAction, request: &[u8]| -> Vec<u8> {
        // 인가된 scope 를 로깅 컨텍스트로만 사용(권한 재판단 0).
        let _scope: Scope = action.scope();
        let parsed: Result<Value, _> = serde_json::from_slice(request);
        let envelope = match parsed {
            Ok(v) => {
                let method = v.get("method").and_then(|m| m.as_str()).unwrap_or("");
                if method.is_empty() {
                    json!({ "ok": false, "code": "INVALID_PARAMS", "message": "method 누락" })
                } else {
                    let params = v.get("params").cloned().unwrap_or(Value::Null);
                    // 코어 단일 실행 경로 — request_command(이미 pub). ipc.rs 변경 0.
                    request_command(&app, method.to_string(), params, 10_000)
                }
            }
            Err(e) => json!({ "ok": false, "code": "INVALID_PARAMS", "message": format!("JSON 파싱 실패: {e}") }),
        };
        serde_json::to_vec(&envelope).unwrap_or_else(|_| b"{\"ok\":false}".to_vec())
    }
}

/// 기본 비활성 루프백 브리지를 (켜져 있을 때만) 시작한다. 꺼져 있으면 즉시 반환(바인드 0).
///
/// 켜진 경우: 새 X25519 static 키쌍 + 빈 핀닝/auth 레지스트리로 리스너를 구성한다. 레지스트리가
/// 비어 있으므로(페어링 UI 는 별도 후속) 모든 연결이 fail-closed — "켬"이 곧 "접근 허용"이 아니다.
/// 127.0.0.1 전용 바인드(tcp.rs). 어떤 실패도 앱을 죽이지 않는다(로깅 후 계속).
pub fn maybe_start_loopback_bridge(app: &AppHandle) {
    if !enabled() {
        return; // 기본 경로 — 아무것도 바인드하지 않는다(실행 중 앱 무영향).
    }
    let local = match StaticKeypair::generate() {
        Ok(k) => Arc::new(k),
        Err(e) => {
            eprintln!("[remote::bridge] static 키 생성 실패: {e}");
            return;
        }
    };
    // 빈 레지스트리 — 페어링 전이라 누구도 핀닝/인가되지 않음(fail-closed). 페어링은 후속.
    let config = Arc::new(ListenerConfig {
        local,
        noise_registry: Arc::new(PinnedPeerRegistry::new()),
        auth: SharedAuth::new(DeviceRegistry::new(8)),
    });
    let port: u16 = std::env::var(PORT_ENV).ok().and_then(|s| s.parse().ok()).unwrap_or(0);
    let app = app.clone();

    // tokio 런타임에 스폰 — accept_loop 는 무한 루프(백그라운드). 켜질 때만 도달한다.
    tauri::async_runtime::spawn(async move {
        let listener = match bind_loopback(port).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[remote::bridge] 루프백 바인드 실패: {e}");
                return;
            }
        };
        if let Ok(a) = listener.local_addr() {
            eprintln!("[remote::bridge] 루프백 원격 브리지 활성(페어링 전 fail-closed): {a}");
        }
        // now: 실제 시계(Unix secs). token: None(데스크톱 confirm 모달 왕복은 후속 — deny-until-token).
        // dispatch: 코어 route() 배선.
        accept_loop(
            listener,
            config,
            || now_unix,
            || |_peer: &str| None,
            move || make_dispatch(app.clone()),
        )
        .await;
    });
}

/// 현재 Unix 초(신선도/단조 검사 기준). serve_connection 의 now_fn 으로 매 frame 호출된다.
fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
