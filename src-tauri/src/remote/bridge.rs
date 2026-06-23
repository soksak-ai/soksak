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
use crate::remote::tcp::{accept_loop, bind_loopback, tunnel_accept_loop, ListenerConfig};
use crate::remote::transport::SharedAuth;

use iroh::{RelayMode, SecretKey};

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
    // Noise device 신원(전송 node-id 와 별개 — node-id≠auth). 빈 핀닝/auth 로 fail-closed.
    let local = match StaticKeypair::generate() {
        Ok(k) => Arc::new(k),
        Err(e) => {
            eprintln!("[remote::bridge] iroh: Noise static 키 생성 실패: {e}");
            return;
        }
    };
    let config = Arc::new(IrohListenerConfig {
        local,
        noise_registry: Arc::new(PinnedPeerRegistry::new()),
        auth: SharedAuth::new(DeviceRegistry::new(8)),
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
pub fn maybe_start_tunnel_bridge(_app: &AppHandle) {
    if !tunnel_enabled() {
        return; // 기본 경로 — 어떤 터널 리스너도 바인드하지 않는다(실행 중 앱 무영향).
    }
    let local = match StaticKeypair::generate() {
        Ok(k) => Arc::new(k),
        Err(e) => {
            eprintln!("[remote::bridge] 터널: static 키 생성 실패: {e}");
            return;
        }
    };
    // 빈 핀닝/auth 레지스트리 — 페어링 전이라 fail-closed. allowlist 는 데스크톱 env 단일 진실.
    let config = Arc::new(ListenerConfig {
        local,
        noise_registry: Arc::new(PinnedPeerRegistry::new()),
        auth: SharedAuth::new(DeviceRegistry::new(8)),
    });
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
