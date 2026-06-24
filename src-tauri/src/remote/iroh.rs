// remote::iroh — 폰-링크 transport tier ①(QUIC P2P + 릴레이 fallback). serve_connection 을 iroh 의
// bidirectional QUIC stream 위에 얹는 한 가지 transport. transport-agnostic 코어(transport.rs)는
// 손대지 않고 스트림만 넘긴다(tcp.rs 와 정확히 같은 계약 — additive).
//
// **왜 iroh(계획서 "폰 연동" ①)**: 데스크톱이 고정 IP 없음 + CGNAT(공유 IP) → 인바운드 불가.
// iroh 는 양쪽이 outbound 로 릴레이에 랑데부해 QUIC hole-punch(직결) 또는 릴레이 fallback 으로
// 잇는다 — 별도 에이전트 설치 0(앱 내장). 같은 WiFi 면 mDNS 로 0지연 직결 승급(LAN fast-path).
//
// **보안은 transport-agnostic(계획서 RULE 0/5, "릴레이는 복호 종단 절대 아님")**: iroh 의 QUIC 는
// 바이트만 운반한다. 우리 Noise KK mutual-auth + E2E(transport.rs serve_connection)가 그 bi-stream
// **위에** 그대로 얹힌다. 그래서:
//   - iroh node-id(EndpointId) = desktop 의 **TRANSPORT 주소**(폰의 다이얼 타겟)일 뿐, **auth 아님**.
//     올바른 node-id 로 닿아도 핀닝된 device key(Noise X25519 + Ed25519)가 없으면 Noise 핸드셰이크가
//     미성립 ⇒ 채널 0 ⇒ dispatch 0(defense-in-depth — 아래 node-id-without-pinned-keys 테스트가 못박음).
//   - iroh 의 QUIC TLS 가 한 겹 더 있어도(전송 암호), 우리 평문은 그 안에서 **또** Noise 로 봉인되므로
//     릴레이/transport 계층은 zero-knowledge(우리 평문 비가독) — ciphertext 만 흐른다.
//
// **node-id 안정성**: 데스크톱 endpoint 는 **STATIC iroh SecretKey** 로 만든다 → node-id 가 부팅마다
// 동일 = 폰이 한 번 페어링하면 계속 같은 주소로 닿는다(QR 페어링의 다이얼 타겟). 이 static 키는
// **iroh 전송 신원**이고, 페어링이 핀닝하는 device key(noise/auth)와는 별개다(두 키, 두 역할).
//
// **off by default**: serve loop 는 명시 호출(bridge glue 의 enable 플래그)로만 시작된다. 안 켜면
// 어떤 endpoint 도 bind 되지 않는다 — 실행 중 앱 무영향(tcp.rs/bridge.rs 와 동일 패턴).
//
// 각 incoming connection 은 독립 task 로 serve_connection 을 돌린다(연결 격리). 공유 권위
// (SharedAuth)만 한 DeviceRegistry 를 가리켜 페어링/revoke 가 전 연결에 단일 진실로 반영된다.
#![allow(dead_code)]

use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use iroh::endpoint::{Incoming, RecvStream, SendStream};
use iroh::{Endpoint, NodeId, RelayMode, SecretKey};

use crate::remote::auth::{AuthorizedAction, DesktopConfirmToken};
use crate::remote::noise::{PinnedPeerRegistry, StaticKeypair};
use crate::remote::transport::{serve_connection, SharedAuth};

// ===========================================================================
// 0. ALPN — 우리 프로토콜 식별자(iroh 가 ALPN 미스매치 연결을 accept 단계에서 거른다).
// ===========================================================================

/// soksak 폰-링크 application-level protocol id. iroh endpoint 가 이 ALPN 으로만 accept 한다
/// (다른 ALPN 연결은 QUIC 핸드셰이크에서 거부 — 우리 serve loop 에 닿지 않는다). 이건 transport
/// 라우팅용 라벨일 뿐 **보안 경계 아님** — 보안은 그 위 Noise 가 한다.
pub const IROH_ALPN: &[u8] = b"soksak/phone-link/1";

// ===========================================================================
// 1. JoinedStream — iroh 의 split (SendStream, RecvStream) 을 단일 AsyncRead+AsyncWrite 로 합친다.
// ===========================================================================

/// iroh 의 bidirectional QUIC stream 은 `(SendStream, RecvStream)` **쌍**으로 온다(QUIC 의 자연스러운
/// 모양). 반면 serve_connection 은 단일 `S: AsyncRead + AsyncWrite` 를 받는다(TCP 처럼). 이 어댑터가
/// 그 둘을 잇는다 — **serve_connection 무수정**(계획의 "minimal, additive"). read 는 RecvStream 으로,
/// write/flush/shutdown 은 SendStream 으로 위임할 뿐 — 로직 0(꼼수 0, 순수 배선).
///
/// SendStream 은 tokio AsyncWrite, RecvStream 은 tokio AsyncRead 를 이미 구현하므로(iroh 0.95.1)
/// 위임은 그대로 통과한다. 두 방향이 독립 QUIC stream-half 라 동시 read/write 가 막히지 않는다.
pub struct JoinedStream {
    recv: RecvStream,
    send: SendStream,
}

impl JoinedStream {
    /// accept_bi()/open_bi() 가 준 (send, recv) 쌍을 합친다.
    pub fn new(send: SendStream, recv: RecvStream) -> Self {
        JoinedStream { recv, send }
    }
}

// **명시적 trait 디스패치(중요)**: iroh-quinn 의 SendStream/RecvStream 은 **인헤런트** poll_write/
// poll_read(WriteError/ReadError 반환)를 가져 trait 메서드를 그늘 가린다. `Pin::new(..).poll_write`
// 는 인헤런트(io::Error 아님)로 풀려 타입이 안 맞는다 — 그래서 trait 메서드를 풀-퀄리파이드로 부른다
// (AsyncWrite::poll_write / AsyncRead::poll_read). 이게 io::Result 를 돌려주는 올바른 위임이다.
impl AsyncRead for JoinedStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        // 읽기는 전적으로 RecvStream(QUIC 의 우리→상대 반대 방향 half).
        AsyncRead::poll_read(Pin::new(&mut self.recv), cx, buf)
    }
}

impl AsyncWrite for JoinedStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        // 쓰기는 전적으로 SendStream(QUIC 의 우리→상대 방향 half).
        AsyncWrite::poll_write(Pin::new(&mut self.send), cx, buf)
    }

    fn poll_flush(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        AsyncWrite::poll_flush(Pin::new(&mut self.send), cx)
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        // QUIC stream 의 정상 종료(FIN). serve_connection 이 끝나면 호출된다.
        AsyncWrite::poll_shutdown(Pin::new(&mut self.send), cx)
    }
}

// ===========================================================================
// 2. Endpoint 빌드 — STATIC SecretKey 로 안정적 node-id(페어링 주소).
// ===========================================================================

/// 데스크톱 endpoint 를 빌드한다. **STATIC iroh SecretKey** 로 만들어 node-id(NodeId)가
/// 부팅마다 동일하다 = 폰의 안정적 다이얼 타겟(페어링 QR 의 주소). ALPN 을 우리 것으로 고정한다
/// (다른 ALPN accept 0). relay_mode 로 CGNAT traversal(릴레이 fallback)을, mdns 로 LAN fast-path 를 켠다.
///
/// **node-id ≠ auth**: 이 SecretKey 는 iroh 전송 신원일 뿐 — 페어링이 핀닝하는 device key(noise/auth)와
/// 별개다. 누군가 이 node-id 로 정확히 다이얼해도, 핀닝된 device key 없이는 serve_connection 의 Noise
/// 핸드셰이크가 미성립한다(채널 0). 즉 node-id 는 "어디로 거는가"이지 "누구인가(권한)"가 아니다.
///
/// 반환 실패(bind 실패 등)는 호출자(glue)가 로깅하고 비활성으로 둔다(앱 죽이지 않음).
pub async fn build_endpoint(
    secret_key: SecretKey,
    relay_mode: RelayMode,
    enable_mdns: bool,
) -> Result<Endpoint, IrohError> {
    let mut builder = Endpoint::builder()
        .secret_key(secret_key)
        .alpns(vec![IROH_ALPN.to_vec()])
        .relay_mode(relay_mode);
    // LAN fast-path — 같은 네트워크면 mDNS 로 0지연 직결(릴레이/인터넷 불요). off 면 릴레이/직결 주소만.
    if enable_mdns {
        builder = builder.discovery_local_network();
    }
    let endpoint = builder.bind().await.map_err(|e| IrohError::Bind(e.to_string()))?;
    Ok(endpoint)
}

/// endpoint 의 node-id(NodeId) — 폰에게 노출할 **전송 주소**(다이얼 타겟). 페어링 QR/표시에 쓴다.
/// 이건 auth 가 아니다 — 폰이 이 id 로 닿아도 핀닝된 device key 로 Noise 를 통과해야 채널이 생긴다.
pub fn node_id(endpoint: &Endpoint) -> NodeId {
    endpoint.node_id()
}

/// node-id 의 사람이-읽는 형태(QR/로깅/감사). 비밀 아님(공개키, z-base-32 인코딩).
pub fn node_id_string(endpoint: &Endpoint) -> String {
    endpoint.node_id().to_string()
}

// ===========================================================================
// 3. IrohError — endpoint/accept 실패 분류(전부 비활성/연결 종료로 귀결, 앱 무영향).
// ===========================================================================

#[derive(Debug)]
pub enum IrohError {
    /// endpoint bind 실패(포트/소켓). glue 가 로깅 후 비활성으로 둔다.
    Bind(String),
}

impl std::fmt::Display for IrohError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IrohError::Bind(e) => write!(f, "iroh endpoint bind: {e}"),
        }
    }
}

impl std::error::Error for IrohError {}

// ===========================================================================
// 4. IrohListenerConfig — 리스너 자원 묶음(tcp::ListenerConfig 와 동형).
// ===========================================================================

/// iroh accept 루프 구동에 필요한 불변 자원 — 데스크톱 Noise 신원 + 핀닝 권위 + 공유 auth.
/// (iroh endpoint 자체는 accept_loop 인자로 따로 넘긴다 — endpoint 수명은 glue 가 관리.)
///
/// **두 신원 분리**: endpoint 의 iroh SecretKey(전송 node-id)와 여기 `local`(Noise X25519 device 신원)은
/// 별개다. 전자는 "어디로", 후자는 "누구"(+핀닝). 이 분리가 node-id≠auth defense-in-depth 의 코드적 근거.
pub struct IrohListenerConfig {
    /// 데스크톱(로컬) X25519 static 키쌍 — Noise KK responder 신원(전송 node-id 와 별개).
    pub local: Arc<StaticKeypair>,
    /// 핀닝된 원격 peer 들(채널 게이트). 미핀닝/revoked ⇒ Noise 핸드셰이크 미성립 ⇒ 채널 0.
    pub noise_registry: Arc<PinnedPeerRegistry>,
    /// auth 권위(액션 인가) — 공유 단일 진실(revoke 즉시 반영).
    pub auth: SharedAuth,
}

// ===========================================================================
// 5. accept_loop — incoming iroh connection 마다 serve_connection(연결 격리, fail-closed).
// ===========================================================================

/// iroh accept 루프 — 각 incoming connection 을 독립 task 로 serve_connection 에 넘긴다(연결 격리).
///
/// 흐름(연결 1개):
///   1. endpoint.accept() → incoming. ALPN 미스매치는 iroh 가 이미 걸렀다(우리 ALPN 만 온다).
///   2. incoming.await → Connection(QUIC 핸드셰이크 완료). 실패 시 그 연결만 버리고 루프 계속.
///   3. conn.accept_bi() → (SendStream, RecvStream). **상대가 먼저 써야** accept_bi 가 깬다 —
///      우리 프로토콜은 announce(device_id)를 먼저 보내므로 정상적으로 깬다.
///   4. JoinedStream 으로 합쳐 serve_connection 을 **무수정** 호출 — Noise 핸드셰이크 + auth + confirm
///      이 그대로 적용된다(우리 E2E 가 iroh QUIC 위에 얹힌다). 미핀닝/revoked ⇒ 채널 0 ⇒ dispatch 0.
///   5. remote node-id(conn.remote_id())는 감사/바인딩 용으로 가용 — 단 **auth 는 Noise 가** 한다.
///
/// `now_fac`/`token_fac`/`dispatch_fac` 는 팩토리다(tcp.rs 와 동일): accept 마다 호출돼 그 연결 전용
/// 클로저를 만든다(연결 간 상태 누수 0). 어떤 host:port forward 도 없다(SSRF 0 — registry 명령만).
///
/// 이 함수는 무한 루프다 — 호출자가 spawn 으로 백그라운드에 둔다. accept None(endpoint 닫힘)이면 종료.
/// 한 연결 실패가 루프를 죽이지 않는다(연결 격리 + endpoint 생존).
pub async fn accept_loop<NowFac, NowF, TokFac, TokF, DispFac, Disp>(
    endpoint: Endpoint,
    config: Arc<IrohListenerConfig>,
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
        // accept() None ⇒ endpoint 닫힘 ⇒ 루프 종료(정상).
        let incoming = match endpoint.accept().await {
            Some(inc) => inc,
            None => {
                eprintln!("[remote::iroh] endpoint 닫힘 — accept 루프 종료");
                return;
            }
        };
        let config = Arc::clone(&config);
        let now = now_fac();
        let token = token_fac();
        let dispatch = dispatch_fac();
        // 연결 격리 — 각 연결 독립 task. 한 연결 실패가 다른 연결/endpoint 에 무영향.
        tokio::spawn(async move {
            serve_one(incoming, config, now, token, dispatch).await;
        });
    }
}

/// incoming 하나를 serve_connection 으로 서비스한다(QUIC 핸드셰이크 → bi-stream → 보안 세션).
/// 어떤 실패(QUIC 핸드셰이크/bi accept/serve)든 그 연결만 닫힌다(fail-closed, dispatch 는 인가 frame 만).
async fn serve_one<NowF, TokF, Disp>(
    incoming: Incoming,
    config: Arc<IrohListenerConfig>,
    now: NowF,
    token: TokF,
    dispatch: Disp,
) where
    NowF: FnMut() -> u64 + Send + 'static,
    TokF: FnMut(&str) -> Option<DesktopConfirmToken> + Send + 'static,
    Disp: FnMut(&AuthorizedAction, &[u8]) -> Vec<u8> + Send + 'static,
{
    // QUIC 핸드셰이크 완료까지 await. 실패 시 그 연결만 버린다(루프 계속).
    let conn = match incoming.await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[remote::iroh] QUIC 연결 실패: {e}");
            return;
        }
    };
    // remote node-id 는 감사/바인딩 용으로 가용 — 단 **auth 권위는 Noise 가**(node-id≠auth).
    // 로깅만(권한 판단 0). 핀닝/인가는 아래 serve_connection 의 Noise+auth 가 한다.
    if let Ok(remote) = conn.remote_node_id() {
        eprintln!("[remote::iroh] incoming from node-id {remote} (transport addr only — Noise가 auth)");
    }
    // bidirectional stream accept. 상대가 announce 를 먼저 쓰므로 깬다.
    let (send, recv) = match conn.accept_bi().await {
        Ok(pair) => pair,
        Err(e) => {
            eprintln!("[remote::iroh] bi-stream accept 실패: {e}");
            return;
        }
    };
    // split 쌍 → 단일 스트림 → serve_connection 무수정. Noise+auth+confirm 이 전부 적용된다.
    let stream = JoinedStream::new(send, recv);
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
        eprintln!("[remote::iroh] 연결 종료: {e}");
    }
}

#[cfg(test)]
mod tests;
