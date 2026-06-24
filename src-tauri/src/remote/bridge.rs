// remote::bridge — 앱-기동 glue(additive, 기본 비활성). serve_connection 의 dispatch 를 코어
// route() 로 배선한다(request_command 경유). **기본 비활성**: SOKSAK_REMOTE_TCP 가 명시적으로
// 켜졌을 때만 루프백 리스너가 바인드된다 — 꺼져 있으면 아무 포트도 안 열리고 실행 중 앱은 무영향.
//
// 이 모듈은 기존 동작을 바꾸지 않는다(ipc.rs/route()/UnixListener 무수정). request_command 는
// 이미 pub 이라 그대로 호출한다(ipc.rs 변경 0). 켜져도 레지스트리가 비어 있으면(페어링 UI 후속)
// 모든 연결이 fail-closed — 즉 "켬"이 곧 "노출"이 아니다(페어링이 별도 게이트).
#![allow(dead_code)]

use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::ipc::request_command;
use crate::remote::auth::{AuthorizedAction, DeviceRegistry, Scope};
use crate::remote::confirm::{PendingConfirms, PendingSummary};
use crate::remote::iroh::{
    accept_loop as iroh_accept_loop, build_endpoint, node_id_string, IrohListenerConfig,
};
use crate::remote::noise::{PinnedPeerRegistry, StaticKeypair};
use crate::remote::pairing;
use crate::remote::tcp::{
    bind_loopback, confirmed_accept_loop, tunnel_accept_loop, ListenerConfig,
};
use crate::remote::transport::{ConfirmRequest, SharedAuth};

use iroh::{RelayMode, SecretKey};
use tauri::Emitter;

/// 데스크톱 confirm 단일 권위의 기본 TTL(초) — 미해결 confirm 은 이 후 AUTO-DENY(matrix
/// "confirm timeout→미실행"). 사람이 모달을 못 보고 지나가도 destructive 가 영구 hang 하지 않는다.
pub const CONFIRM_TTL_SECS: u64 = 120;

/// 앱이 manage 하는 데스크톱 confirm 권위 — Tauri glue(resolve/pending 커맨드)와 serve loop 가
/// 공유하는 단일 PendingConfirms. lib.rs 가 `.manage(RemoteConfirmState::default())` 로 등록한다.
/// **이 상태가 켜져도 destructive 실행 0** — 토큰은 serve loop 의 APPROVE 에서만 만들어진다.
pub struct RemoteConfirmState {
    pub confirms: PendingConfirms,
}

impl Default for RemoteConfirmState {
    fn default() -> Self {
        RemoteConfirmState {
            confirms: PendingConfirms::new(CONFIRM_TTL_SECS),
        }
    }
}

/// 현재 Unix 초(park 의 created_at / TTL 만료 기준).
fn now_unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 데스크톱 confirm 모달의 결정을 PendingConfirms 로 전달하는 thin Tauri glue.
///
/// **데스크톱 전용 권위(RULE 0/6)**: 이 커맨드는 데스크톱 웹뷰(confirm 모달)만 호출한다 — 폰은
/// 이 IPC 표면에 닿을 경로가 없다(원격 frame 은 serve loop 가 resolve 로 라우팅하지 않는다).
/// TS confirm 모달은 얇은 표현일 뿐 — APPROVE/DENY 를 여기로 보내고, **권위는 Rust 에 있다**
/// (토큰은 serve loop 의 finish_confirmed 가 만든다, 이 커맨드가 아니라).
///
/// 반환: 결정이 전달됐으면 true. 미상/이미 해결/만료(또는 serve loop 가 timeout 으로 떠남)면 false.
/// off-by-default: 이 커맨드는 앱에 컴파일되지만 RemoteConfirmState 가 등록돼야 동작한다.
#[tauri::command]
pub fn remote_confirm_resolve(
    app: AppHandle,
    request_id: u64,
    approve: bool,
) -> Result<bool, String> {
    let state = app.state::<RemoteConfirmState>();
    // 만료분 청소(stale 누수 0) 후 resolve.
    state.confirms.expire_due(now_unix_secs());
    Ok(state.confirms.resolve(request_id, approve))
}

/// 데스크톱 모달용 — 현재 미해결 confirm 목록(RULE 8 노출/감사). 평문 토큰/키 0(표시 정보만).
#[tauri::command]
pub fn remote_confirm_pending(app: AppHandle) -> Result<Vec<ConfirmPendingView>, String> {
    let state = app.state::<RemoteConfirmState>();
    state.confirms.expire_due(now_unix_secs());
    Ok(state
        .confirms
        .list_pending()
        .into_iter()
        .map(ConfirmPendingView::from)
        .collect())
}

/// remote_confirm_pending 의 직렬화 뷰(프론트 모달이 읽는 모양).
#[derive(Debug, Clone, Serialize)]
pub struct ConfirmPendingView {
    pub request_id: u64,
    pub device_id: String,
    pub command: String,
    pub created_at: u64,
}

impl From<PendingSummary> for ConfirmPendingView {
    fn from(s: PendingSummary) -> Self {
        ConfirmPendingView {
            request_id: s.request_id,
            device_id: s.device_id,
            command: s.command,
            created_at: s.created_at,
        }
    }
}

/// 루프백 브리지 활성 env 키 — 명시적·generic(RULE 8). 미설정/"0"/"false" ⇒ 비활성(바인드 0).
pub const ENABLE_ENV: &str = "SOKSAK_REMOTE_TCP";
/// 바인드 포트 env(선택) — 미설정 시 OS 할당(0). 항상 127.0.0.1 에만 바인드(tcp.rs).
pub const PORT_ENV: &str = "SOKSAK_REMOTE_TCP_PORT";

/// iroh 폰-링크 transport(tier ①) 활성 env 키 — 명시적·generic(RULE 8). 미설정 ⇒ 비활성(endpoint 0).
/// 루프백 TCP 와 **독립** 플래그 — 둘은 같은 serve_connection 을 다른 transport 위에 얹을 뿐.
pub const IROH_ENABLE_ENV: &str = "SOKSAK_REMOTE_IROH";

/// 로컬 dev-server reverse-proxy **터널** 활성 env 키 — 명시적·generic(RULE 8). 미설정 ⇒ 비활성
/// (어떤 터널 리스너도 안 뜬다). 명령 dispatch 브리지(TCP/iroh)와 **독립** 플래그 — 터널은 별개
/// 명시 모드(serve_tunnel)다. 켜져도 allowlist 가 비어 있으면 **모든 터널이 fail-closed**(SSRF 0).
pub const TUNNEL_ENABLE_ENV: &str = "SOKSAK_REMOTE_TUNNEL";

/// 터널 **포트 allowlist** env(데스크톱 소유 — anti-escalation). 쉼표 구분 포트 목록(예
/// `"3000,5173,8080"`). 미설정/빈 ⇒ 빈 allowlist ⇒ 모든 터널 거부(fail-closed). 폰은 이 집합을
/// 어떤 frame 으로도 바꿀 수 없다 — allowlist 는 오직 이 env(데스크톱 설정)에서만 온다(RULE 8 observable).
pub const TUNNEL_ALLOWLIST_ENV: &str = "SOKSAK_REMOTE_TUNNEL_PORTS";

/// 터널 리스너 바인드 포트 env(선택) — 미설정 시 OS 할당. 항상 127.0.0.1 에만 바인드.
pub const TUNNEL_BIND_PORT_ENV: &str = "SOKSAK_REMOTE_TUNNEL_BIND_PORT";

/// env 값이 명시적으로 켜졌는가(공통 파서). 미설정/빈/"0"/"false"/"off"/"no" ⇒ false(기본 비활성).
fn env_flag_on(key: &str) -> bool {
    match std::env::var(key) {
        Ok(v) => {
            let v = v.trim().to_ascii_lowercase();
            !(v.is_empty() || v == "0" || v == "false" || v == "off" || v == "no")
        }
        Err(_) => false,
    }
}

/// 루프백 TCP 브리지 활성 여부(기본 비활성).
fn enabled() -> bool {
    env_flag_on(ENABLE_ENV)
}

/// iroh 폰-링크 transport 활성 여부(기본 비활성). off-by-default 회귀 테스트가 이 함수를 단언한다.
pub fn iroh_enabled() -> bool {
    env_flag_on(IROH_ENABLE_ENV)
}

/// 로컬 dev-server 터널 활성 여부(기본 비활성). off-by-default 회귀 테스트가 이 함수를 단언한다.
pub fn tunnel_enabled() -> bool {
    env_flag_on(TUNNEL_ENABLE_ENV)
}

/// 데스크톱 소유 터널 포트 allowlist 를 env 에서 파싱한다(RULE 8 observable config — 관측 가능한
/// 단일 진실). 쉼표 구분 u16 포트. 파싱 불가 토큰/포트 0 은 무시한다(fail-closed: 빈 ⇒ 전부 거부).
/// **폰은 이 함수에 영향을 줄 수 없다** — allowlist 는 오직 데스크톱 env 에서만 온다(anti-escalation).
pub fn tunnel_allowlist() -> crate::remote::tunnel::PortAllowlist {
    let raw = std::env::var(TUNNEL_ALLOWLIST_ENV).unwrap_or_default();
    let ports = raw
        .split(',')
        .filter_map(|t| t.trim().parse::<u16>().ok())
        .filter(|p| *p != 0);
    crate::remote::tunnel::PortAllowlist::from_ports(ports)
}

/// 데스크톱 앱 config 디렉터리(페어링 설정·static 키의 데스크톱 소유 위치). 해소 실패 시 None
/// (그 경우 pairing 모듈이 env 만 보거나 ephemeral 로 폴백 — RULE 8 무강결합).
fn desktop_config_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path().app_config_dir().ok()
}

/// env 조회 클로저(pairing 모듈에 주입 — Tauri 비의존, 데스크톱 소유 단일 진실).
fn env_lookup(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

/// 데스크톱 소유 설정(영속 static 키 + 페어링된 기기)으로 ListenerConfig 를 짓는다(PART A 핵심).
///
/// floor 무수정 — pairing 모듈의 PUBLIC 헬퍼만 호출한다:
///   - load_or_create_desktop_key: 안정적 데스크톱 X25519 static(앱 config/env, 폰-도달 불가).
///   - load_paired_devices + pin_devices: 데스크톱 소유 설정의 기기를 noise+auth 에 핀닝.
/// **폰은 이 경로에 못 낀다** — 핀닝 엔트리는 데스크톱 디스크/env 에서만 온다(anti-escalation).
/// 빈 설정(페어링 0) ⇒ 핀닝 0 ⇒ 모든 연결 fail-closed(핸드셰이크 미성립). 어떤 실패도 로깅 후
/// 계속(앱 무중단) — 단 키/핀닝 실패는 "그 연결이 안 됨"이지 "무인증 허용"이 절대 아니다.
fn build_pairing_parts(
    app: &AppHandle,
    label: &str,
) -> (Arc<StaticKeypair>, Arc<PinnedPeerRegistry>, SharedAuth) {
    let config_dir = desktop_config_dir(app);
    // 1. 데스크톱 static 키 — 영속(있으면 로드, 없으면 생성·저장). 안정 키 = 폰 핀닝 유지.
    let local = match pairing::load_or_create_desktop_key(config_dir.as_deref(), env_lookup) {
        Ok(k) => Arc::new(k),
        Err(e) => {
            eprintln!("[remote::bridge] {label}: 데스크톱 static 키 로드/생성 실패: {e} — 거부 전용으로 계속");
            // 키 실패 ⇒ ephemeral 생성 폴백(그래도 페어링 0 이면 어차피 fail-closed).
            Arc::new(StaticKeypair::generate().unwrap_or_else(|_| {
                StaticKeypair::from_parts([1u8; 32], [1u8; 32]).expect("dummy key")
            }))
        }
    };
    // 데스크톱 공개키 노출(RULE 4/8) — 폰이 핀닝할 값. 로그로 관측 가능(headless 페어링 표시).
    eprintln!(
        "[remote::bridge] {label}: 데스크톱 X25519 static 공개키(폰이 핀닝할 값) = {}",
        pairing::to_hex(&local.public_key())
    );

    // 2. 페어링된 기기 — 데스크톱 소유 설정에서만(폰 도달 0). 빈 ⇒ fail-closed.
    let mut noise = PinnedPeerRegistry::new();
    let max_dev = pairing::max_devices(env_lookup);
    let mut auth_reg = DeviceRegistry::new(max_dev);
    match pairing::load_paired_devices(config_dir.as_deref(), env_lookup) {
        Ok(devices) => {
            let count = devices.len();
            if let Err(e) = pairing::pin_devices(&devices, &mut noise, &mut auth_reg) {
                eprintln!("[remote::bridge] {label}: 페어링 핀닝 거부(조용한 bad-key 0): {e}");
            } else {
                eprintln!(
                    "[remote::bridge] {label}: 페어링된 기기 {count}대 핀닝(빈=fail-closed). 미페어링은 핸드셰이크 미성립."
                );
            }
        }
        Err(e) => {
            eprintln!("[remote::bridge] {label}: 페어링 설정 파싱 실패(거부 전용으로 계속): {e}");
        }
    }

    (local, Arc::new(noise), SharedAuth::new(auth_reg))
}

/// TCP/터널용 ListenerConfig(데스크톱 소유 설정으로 채움 — build_pairing_parts 재사용).
fn build_listener_config(app: &AppHandle, label: &str) -> Arc<ListenerConfig> {
    let (local, noise_registry, auth) = build_pairing_parts(app, label);
    Arc::new(ListenerConfig {
        local,
        noise_registry,
        auth,
    })
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
        let bytes = serde_json::to_vec(&envelope).unwrap_or_else(|_| b"{\"ok\":false}".to_vec());
        cap_response(bytes)
    }
}

/// 단일 Noise transport frame 캡(65535) — session 이 tag(1)+AEAD(16) 를 더하므로 평문 응답은
/// 그보다 작아야 한다. 캡 초과면 session.encrypt 가 빈 frame 을 내 클라이언트가 복호 실패(silent
/// corruption)했다 — 이를 **깨끗이 복호되는 명시 에러 envelope** 로 환원한다(route() 는 실제로
/// 실행됐고 결과가 너무 큼을 정직히 보고; floor 무수정 — bridge 가드). 이 한계 자체는 transport
/// 의 단일-frame 한계다(다중-frame 청크는 별도 후속). 순수 함수 — 테스트가 행위로 강제한다.
pub const SAFE_PLAINTEXT_CAP: usize = 60_000;

fn cap_response(bytes: Vec<u8>) -> Vec<u8> {
    if bytes.len() > SAFE_PLAINTEXT_CAP {
        let err = json!({
            "ok": false,
            "code": "RESPONSE_TOO_LARGE",
            "message": format!(
                "응답 {}B 가 단일 transport frame 캡({}B)을 초과 — route() 는 실행됐으나 결과가 너무 큼(다중-frame 청크는 후속).",
                bytes.len(), SAFE_PLAINTEXT_CAP
            ),
            "size": bytes.len(),
        });
        return serde_json::to_vec(&err).unwrap_or_else(|_| b"{\"ok\":false}".to_vec());
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_response_passes_through_unchanged() {
        // 캡 이하 응답은 그대로(가공 0).
        let small = br#"{"ok":true,"count":3}"#.to_vec();
        assert_eq!(cap_response(small.clone()), small);
    }

    #[test]
    fn oversize_response_becomes_clean_decodable_error() {
        // RED(버그 재현): 캡 초과를 안 막으면 session.encrypt 가 빈 frame 을 내 클라이언트가 AEAD
        //   복호 실패(라이브 E2E 에서 state.commands 244KB 로 실제 관측). GREEN: 캡 초과는 단일
        //   frame 에 들어가는 **깨끗한 JSON 에러**(RESPONSE_TOO_LARGE + 실제 size)로 환원된다.
        let big = vec![b'x'; SAFE_PLAINTEXT_CAP + 1];
        let out = cap_response(big);
        assert!(out.len() <= SAFE_PLAINTEXT_CAP, "환원된 에러는 캡 안에 든다");
        let v: Value = serde_json::from_slice(&out).expect("환원 결과는 유효 JSON(복호 가능)");
        assert_eq!(v["ok"], json!(false));
        assert_eq!(v["code"], json!("RESPONSE_TOO_LARGE"));
        assert_eq!(v["size"], json!(SAFE_PLAINTEXT_CAP + 1), "실제 크기를 정직히 보고");
    }

    #[test]
    fn boundary_exactly_at_cap_passes() {
        // 정확히 캡 크기는 통과(경계 off-by-one 0).
        let exact = vec![b'y'; SAFE_PLAINTEXT_CAP];
        assert_eq!(cap_response(exact.clone()), exact);
    }
}

/// 기본 비활성 루프백 브리지를 (켜져 있을 때만) 시작한다. 꺼져 있으면 즉시 반환(바인드 0).
///
/// 켜진 경우(PART A): **영속 데스크톱 static 키 + 데스크톱 소유 설정의 페어링된 기기**로 리스너를
/// 구성한다(build_listener_config). 페어링이 0이면 모든 연결이 fail-closed — "켬"이 곧 "접근 허용"이
/// 아니다(페어링이 별도 게이트). 폰은 스스로 페어링 못 한다(핀닝은 데스크톱 디스크/env 단일 진실).
///
/// destructive 는 **데스크톱 confirm 권위**로 간다(confirmed_accept_loop → serve_connection_confirmed):
/// 원격 destructive frame 은 `remote-confirm-request` 를 데스크톱 모달에 emit 하고 사람 결정을 await
/// 한다(폰 우회 불가). confirms 는 RemoteConfirmState 의 단일 권위(모달의 remote_confirm_resolve 와
/// 공유). 127.0.0.1 전용 바인드(tcp.rs). 어떤 실패도 앱을 죽이지 않는다(로깅 후 계속).
pub fn maybe_start_loopback_bridge(app: &AppHandle) {
    if !enabled() {
        return; // 기본 경로 — 아무것도 바인드하지 않는다(실행 중 앱 무영향).
    }
    let config = build_listener_config(app, "loopback");
    // 데스크톱 confirm 단일 권위 — 모달 glue(remote_confirm_resolve)와 같은 PendingConfirms 를 공유.
    let confirms = {
        use tauri::Manager;
        app.state::<RemoteConfirmState>().confirms.clone()
    };
    let confirm_ttl = std::time::Duration::from_secs(CONFIRM_TTL_SECS);
    let port: u16 = std::env::var(PORT_ENV).ok().and_then(|s| s.parse().ok()).unwrap_or(0);
    let app = app.clone();

    // tokio 런타임에 스폰 — confirmed_accept_loop 는 무한 루프(백그라운드). 켜질 때만 도달한다.
    tauri::async_runtime::spawn(async move {
        let listener = match bind_loopback(port).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[remote::bridge] 루프백 바인드 실패: {e}");
                return;
            }
        };
        if let Ok(a) = listener.local_addr() {
            eprintln!("[remote::bridge] 루프백 원격 브리지 활성(페어링 전 fail-closed, destructive=데스크톱 confirm): {a}");
        }
        // now: 실제 시계. emit: 데스크톱 모달에 confirm 요청 emit(app.emit). dispatch: 코어 route().
        let emit_app = app.clone();
        confirmed_accept_loop(
            listener,
            config,
            confirms,
            confirm_ttl,
            || now_unix,
            move || {
                let app = emit_app.clone();
                move |req: ConfirmRequest| {
                    // 데스크톱 웹뷰의 RemoteConfirmModal 이 듣는 이벤트(device + command + request_id).
                    let _ = app.emit(
                        "remote-confirm-request",
                        json!({
                            "request_id": req.request_id,
                            "device_id": req.device_id,
                            "command": req.command,
                            "danger": req.danger,
                        }),
                    );
                }
            },
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

/// 기본 비활성 **iroh 폰-링크 transport(tier ①)** 를 (켜져 있을 때만) 시작한다. 꺼져 있으면 즉시
/// 반환(endpoint bind 0). 루프백 TCP 와 독립 — 같은 serve_connection 을 iroh QUIC bi-stream 위에 얹는다.
///
/// 켜진 경우: 새 iroh static SecretKey(안정적 node-id = 폰의 다이얼 주소) 로 endpoint 를 만들고,
/// RelayMode::Default(CGNAT traversal: 직결 실패 시 n0 릴레이 fallback) + mDNS(LAN fast-path)를 켠다.
/// Noise/auth 레지스트리는 **빈 채로** 둔다(페어링 UI 는 별도 후속) → 모든 연결이 fail-closed.
/// "켬"이 곧 "접근 허용"이 아니다(페어링이 별도 게이트). 어떤 실패도 앱을 죽이지 않는다(로깅 후 계속).
///
/// dispatch 는 루프백과 **동일** make_dispatch(코어 route() — request_command). confirm 권위 재사용은
/// destructive 경로의 후속(현재 token provider 는 None ⇒ deny-until-token, 루프백과 대칭).
pub fn maybe_start_iroh_bridge(app: &AppHandle) {
    if !iroh_enabled() {
        return; // 기본 경로 — 어떤 iroh endpoint 도 bind 하지 않는다(실행 중 앱 무영향).
    }
    // Noise device 신원(전송 node-id 와 별개 — node-id≠auth) + 페어링된 기기. 데스크톱 소유
    // 설정 단일 진실(TCP 브리지와 공유 — build_pairing_parts). 빈 페어링 ⇒ fail-closed.
    let (local, noise_registry, auth) = build_pairing_parts(app, "iroh");
    let config = Arc::new(IrohListenerConfig {
        local,
        noise_registry,
        auth,
    });
    // iroh 전송 신원 — 실제 앱은 영속 키를 로드해 안정적 node-id 를 유지한다(여기선 매 부팅 새 키 =
    // 페어링 UI 후속에서 영속화). 페어링이 아직 없으니 어차피 fail-closed.
    let secret = SecretKey::generate(&mut rand::rngs::OsRng);
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        // RelayMode::Default = CGNAT 직결 실패 시 n0 릴레이로 fallback(릴레이는 ciphertext 만 운반).
        // mDNS = 같은 WiFi 면 0지연 직결 승급(LAN fast-path).
        let endpoint = match build_endpoint(secret, RelayMode::Default, true).await {
            Ok(ep) => ep,
            Err(e) => {
                eprintln!("[remote::bridge] iroh endpoint bind 실패: {e}");
                return;
            }
        };
        eprintln!(
            "[remote::bridge] iroh 폰-링크 transport 활성(페어링 전 fail-closed). node-id={}",
            node_id_string(&endpoint)
        );
        // now/token/dispatch 는 루프백과 동일 계약. dispatch = 코어 route().
        iroh_accept_loop(
            endpoint,
            config,
            || now_unix,
            || |_peer: &str| None,
            move || make_dispatch(app.clone()),
        )
        .await;
    });
}

/// 기본 비활성 **로컬 dev-server reverse-proxy 터널 브리지**를 (켜져 있을 때만) 시작한다. 꺼져 있으면
/// 즉시 반환(어떤 터널 리스너도 안 뜬다). 명령 dispatch 브리지(TCP/iroh)와 **독립 명시 모드**(serve_tunnel)다.
///
/// 켜진 경우: 127.0.0.1 전용 리스너를 바인드하고, **데스크톱 소유 allowlist**(env 에서 파싱)로
/// tunnel_accept_loop 를 돈다. allowlist 가 비어 있으면(SOKSAK_REMOTE_TUNNEL_PORTS 미설정) **모든
/// 터널이 fail-closed**(SSRF 0). Noise/auth 레지스트리는 빈 채(페어링 UI 는 별도 후속) → 미페어링은
/// 핸드셰이크 미성립(터널 0). dispatch 없음 — 터널은 명령이 아니라 바이트 파이프다. 어떤 실패도
/// 앱을 죽이지 않는다(로깅 후 계속). **allowlist 는 폰이 못 바꾼다**(오직 데스크톱 env — anti-escalation).
pub fn maybe_start_tunnel_bridge(app: &AppHandle) {
    if !tunnel_enabled() {
        return; // 기본 경로 — 어떤 터널 리스너도 바인드하지 않는다(실행 중 앱 무영향).
    }
    // 데스크톱 소유 설정(영속 static 키 + 페어링된 기기) — TCP/iroh 와 공유. 빈 페어링 ⇒
    // 핸드셰이크 미성립(터널 0). allowlist 는 데스크톱 env 단일 진실(폰 상승 불가).
    let config = build_listener_config(app, "tunnel");
    let allowlist = Arc::new(tunnel_allowlist());
    let port: u16 = std::env::var(TUNNEL_BIND_PORT_ENV)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    tauri::async_runtime::spawn(async move {
        let listener = match bind_loopback(port).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[remote::bridge] 터널 루프백 바인드 실패: {e}");
                return;
            }
        };
        if let Ok(a) = listener.local_addr() {
            eprintln!(
                "[remote::bridge] 로컬 터널 브리지 활성(페어링 전 fail-closed): {a}, allowlist={:?}",
                allowlist.allowed_ports()
            );
        }
        tunnel_accept_loop(listener, config, allowlist, || now_unix).await;
    });
}
