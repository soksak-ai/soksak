// remote::tcp — 루프백 TCP 리스너(127.0.0.1 전용). serve_connection 을 TCP 위에 얹는 한 가지
// transport(P1 데스크톱 브리지). transport-agnostic 코어(transport.rs)는 손대지 않고 스트림만 넘긴다.
//
// 보안 경계(매트릭스 "reverse-proxy SSRF" · "DNS rebinding" · "HTTP 터널 무단접근"):
//   - **127.0.0.1 전용 바인드** — 0.0.0.0/임의 노출 금지. 외부 인터페이스에 절대 노출되지 않는다.
//     원격(폰)은 이 TCP 가 아니라 P2 transport(iroh/relay) 가 같은 serve_connection 으로 닿는다.
//     이 루프백 TCP 는 로컬 개발/E2E 브리지면이다.
//   - **SSRF 0**: 이 리스너는 임의 host:port 로 forward 하지 않는다. dispatch 는 registry 명령만
//     실행한다(raw host:port 경로 부재). 터널이 임의 localhost 서비스로 피벗할 표면이 없다.
//   - **off by default**: bind_loopback 은 명시 호출로만 바인드된다. 호출 안 하면 아무 포트도
//     안 열린다 — 실행 중 앱은 무영향(RULE 8 노출은 명시적, 기본 비활성).
//
// 각 accept 는 독립 task 로 serve_connection 을 돌린다(연결 격리). 공유 권위(SharedAuth)만 한
// DeviceRegistry 를 가리켜 페어링/revoke 가 전 연결에 단일 진실로 반영된다.
#![allow(dead_code)]

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;

use tokio::net::TcpListener;

use crate::remote::auth::{AuthorizedAction, DesktopConfirmToken};
use crate::remote::confirm::PendingConfirms;
use crate::remote::noise::{PinnedPeerRegistry, StaticKeypair};
use crate::remote::transport::{
    serve_connection, serve_connection_confirmed, serve_tunnel, ConfirmRequest, SharedAuth,
};
use crate::remote::tunnel::PortAllowlist;

/// 루프백 전용 바인드 주소 — **127.0.0.1**(절대 0.0.0.0 아님). 임의 노출/rebinding 표면 0.
pub const LOOPBACK: Ipv4Addr = Ipv4Addr::LOCALHOST;

/// 리스너 구동에 필요한 불변 자원 묶음 — 데스크톱 측 신원 + 핀닝 권위 + 공유 auth.
/// dispatch/now/token 은 accept 마다 새 클로저로 만들어 각 task 에 넘긴다(아래 serve).
pub struct ListenerConfig {
    /// 데스크톱(로컬) X25519 static 키쌍 — KK responder 신원.
    pub local: Arc<StaticKeypair>,
    /// 핀닝된 원격 peer 들(채널 게이트). 미핀닝/revoked ⇒ 핸드셰이크 미성립.
    pub noise_registry: Arc<PinnedPeerRegistry>,
    /// auth 권위(액션 인가) — 공유 단일 진실(revoke 즉시 반영).
    pub auth: SharedAuth,
}

/// 127.0.0.1 의 주어진 포트(0=OS 할당)에 바인드한다. **명시 호출로만** 포트가 열린다(off by
/// default — 호출 안 하면 바인드 0). 0.0.0.0/외부 인터페이스 바인드 경로는 없다(SSRF/rebinding 0).
///
/// 반환된 TcpListener 의 local_addr().ip() 는 항상 127.0.0.1 이다(테스트가 단언).
pub async fn bind_loopback(port: u16) -> std::io::Result<TcpListener> {
    let addr = SocketAddr::new(IpAddr::V4(LOOPBACK), port);
    TcpListener::bind(addr).await
}

/// accept 루프 — 각 연결을 독립 task 로 serve_connection 에 넘긴다(연결 격리).
///
/// `now_fn`/`token_fn`/`dispatch_fn` 은 **팩토리**다: accept 마다 호출돼 그 연결 전용 클로저를
/// 만든다(연결 간 상태 누수 0). dispatch_fn 이 만든 클로저가 인가된 frame 을 registry 명령으로
/// 라우팅한다(glue 가 request_command 로 배선). 어떤 host:port forward 도 없다(SSRF 0).
///
/// 이 함수는 무한 루프다 — 호출자가 spawn 으로 백그라운드에 둔다. accept 에러는 로깅 후 계속
/// (한 연결 실패가 리스너를 죽이지 않음).
pub async fn accept_loop<NowFac, NowF, TokFac, TokF, DispFac, Disp>(
    listener: TcpListener,
    config: Arc<ListenerConfig>,
    now_fac: NowFac,
    token_fac: TokFac,
    dispatch_fac: DispFac,
) where
    NowFac: Fn() -> NowF + Send + Sync + 'static,
    NowF: FnMut() -> u64 + Send + 'static,
    TokFac: Fn() -> TokF + Send + Sync + 'static,
    TokF: FnMut(&str) -> Option<DesktopConfirmToken> + Send + 'static,
    DispFac: Fn() -> Disp + Send + Sync + 'static,
    Disp: FnMut(&AuthorizedAction, &[u8]) -> Vec<u8> + Send + 'static,
{
    let now_fac = Arc::new(now_fac);
    let token_fac = Arc::new(token_fac);
    let dispatch_fac = Arc::new(dispatch_fac);
    loop {
        let (stream, _peer) = match listener.accept().await {
            Ok(pair) => pair,
            Err(e) => {
                eprintln!("[remote::tcp] accept 실패: {e}");
                continue;
            }
        };
        let config = Arc::clone(&config);
        let now = now_fac();
        let token = token_fac();
        let dispatch = dispatch_fac();
        // 연결 격리 — 각 연결 독립 task. 한 연결 실패가 다른 연결에 무영향.
        tokio::spawn(async move {
            let r = serve_connection(
                stream,
                &config.local,
                &config.noise_registry,
                &config.auth,
                now,
                token,
                dispatch,
            )
            .await;
            if let Err(e) = r {
                // 핸드셰이크 미성립/형식불량/I/O — 정상적인 fail-closed 종료(미인증 dispatch 0).
                eprintln!("[remote::tcp] 연결 종료: {e}");
            }
        });
    }
}

/// **confirmed** accept 루프 — accept_loop 의 sibling 이며, destructive 를 데스크톱 사람 결정에
/// PARK 하는 serve_connection_confirmed 를 돈다(데스크톱 confirm 권위 — RULE 0). 비파괴 경로는
/// accept_loop 와 동일(즉시 dispatch), destructive 만 emit_confirm 으로 데스크톱 모달에 요청을
/// 띄우고 oneshot await(폴링 0). confirms(PendingConfirms)는 데스크톱 glue(remote_confirm_resolve)
/// 와 공유하는 단일 권위 — 모달의 APPROVE/DENY 가 이 await 를 깨운다.
///
/// emit_fac/now_fac/dispatch_fac 는 팩토리(accept 마다 그 연결 전용 클로저). emit 은 실제 앱에서
/// `app.emit("remote-confirm-request", ConfirmRequest)` 를 한다(테스트는 recorder). confirm_ttl
/// 초과 ⇒ AUTO-DENY(matrix "confirm timeout→미실행"). 무한 루프 — 호출자가 spawn.
pub async fn confirmed_accept_loop<NowFac, NowF, EmitFac, EmitF, DispFac, Disp>(
    listener: TcpListener,
    config: Arc<ListenerConfig>,
    confirms: PendingConfirms,
    confirm_ttl: std::time::Duration,
    now_fac: NowFac,
    emit_fac: EmitFac,
    dispatch_fac: DispFac,
) where
    NowFac: Fn() -> NowF + Send + Sync + 'static,
    NowF: FnMut() -> u64 + Send + 'static,
    EmitFac: Fn() -> EmitF + Send + Sync + 'static,
    EmitF: FnMut(ConfirmRequest) + Send + 'static,
    DispFac: Fn() -> Disp + Send + Sync + 'static,
    Disp: FnMut(&AuthorizedAction, &[u8]) -> Vec<u8> + Send + 'static,
{
    let now_fac = Arc::new(now_fac);
    let emit_fac = Arc::new(emit_fac);
    let dispatch_fac = Arc::new(dispatch_fac);
    loop {
        let (stream, _peer) = match listener.accept().await {
            Ok(pair) => pair,
            Err(e) => {
                eprintln!("[remote::tcp] confirmed accept 실패: {e}");
                continue;
            }
        };
        let config = Arc::clone(&config);
        let confirms = confirms.clone();
        let now = now_fac();
        let emit = emit_fac();
        let dispatch = dispatch_fac();
        tokio::spawn(async move {
            let r = serve_connection_confirmed(
                stream,
                &config.local,
                &config.noise_registry,
                &config.auth,
                &confirms,
                confirm_ttl,
                now,
                emit,
                dispatch,
            )
            .await;
            if let Err(e) = r {
                eprintln!("[remote::tcp] confirmed 연결 종료: {e}");
            }
        });
    }
}

/// 터널 accept 루프 — 각 연결을 독립 task 로 **serve_tunnel** 에 넘긴다(연결 격리). 명령 dispatch
/// accept_loop 의 sibling 이며 **별개 모드**(dispatch 없음, allowlist 있음). 어떤 host:port forward 도
/// 없다 — serve_tunnel 은 connect_local(고정 127.0.0.1 + allowlist 포트)만 한다(SSRF 0).
///
/// allowlist 는 **데스크톱 소유**(Arc<PortAllowlist> 불변 공유) — 폰 frame 이 닿는 mutate 경로가 없다.
/// now_fac 는 팩토리(accept 마다 그 연결 전용 클로저). 무한 루프 — 호출자가 spawn 으로 백그라운드에 둔다.
pub async fn tunnel_accept_loop<NowFac, NowF>(
    listener: TcpListener,
    config: Arc<ListenerConfig>,
    allowlist: Arc<PortAllowlist>,
    now_fac: NowFac,
) where
    NowFac: Fn() -> NowF + Send + Sync + 'static,
    NowF: FnMut() -> u64 + Send + 'static,
{
    let now_fac = Arc::new(now_fac);
    loop {
        let (stream, _peer) = match listener.accept().await {
            Ok(pair) => pair,
            Err(e) => {
                eprintln!("[remote::tcp] 터널 accept 실패: {e}");
                continue;
            }
        };
        let config = Arc::clone(&config);
        let allowlist = Arc::clone(&allowlist);
        let now = now_fac();
        tokio::spawn(async move {
            let r = serve_tunnel(
                stream,
                &config.local,
                &config.noise_registry,
                &config.auth,
                &allowlist,
                now,
            )
            .await;
            if let Err(e) = r {
                // 핸드셰이크 미성립/형식불량/I/O — fail-closed 종료(미인증 프록시 0).
                eprintln!("[remote::tcp] 터널 연결 종료: {e}");
            }
        });
    }
}

#[cfg(test)]
mod tests;
