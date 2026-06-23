// remote::tunnel — 로컬 dev-server reverse-proxy 터널(폰-링크 secure channel 위, additive).
//
// 모델(계획서 "폰 연동" — "용도 = 제어(JSON) + 로컬 HTTP 터널"): 터널은 **POST-AUTH 모드가
// '명령 dispatch' 가 아니라 'allowlist 된 loopback 포트로 raw 바이트 프록시'인 SecureSession** 이다.
// 폰이 먼저 인증(Noise KK 핸드셰이크)하고 터널을 인가(target 포트를 담은 capability assertion)하면,
// 데스크톱이 그 포트를 ALLOWLIST 와 대조하고, 통과할 때만 채널이 `127.0.0.1:port` 로의 양방향
// 바이트 파이프가 된다. 명령-dispatch 와 터널은 **별개의 명시 모드**다(blur 0) — serve_tunnel 은
// serve_connection 의 sibling 이고, 둘 다 같은 Noise+assertion 게이트를 먼저 통과시킨다.
//
// 절대 보안 불변식(HARD — 약화 0):
//   - **SSRF 0**: 프록시는 **오직 127.0.0.1**(loopback) 의 **allowlist 된 포트**에만 connect 한다.
//     임의 host 0 · DNS resolution 0 · non-loopback 주소 0 — 절대. allowlist 밖 포트 요청 ⇒ 거부,
//     connect 자체를 **시도조차 안 한다**(authorize_tunnel 이 TcpStream::connect 이전에 막는다).
//   - **allowlist 는 데스크톱 소유, 폰은 상승 불가**: 터널 가능 포트 집합은 데스크톱에서 설정된다
//     (anti-escalation, danger gate 의 거울 — 폰은 어떤 frame 으로도 포트를 추가할 수 없다).
//     PortAllowlist 는 **불변 입력**으로만 authorize_tunnel 에 들어간다 — 폰 frame 이 닿는 mutate
//     경로가 코드에 없다(터널 요청은 read-only 조회일 뿐 allowlist 를 건드리지 않는다).
//   - **브리지 auth 게이트**: 미페어링 peer 는 터널에 절대 못 닿는다(Noise+assertion 게이트가 먼저,
//     무수정). 유효 채널이라도 유효 터널 인가가 별도로 필요하다.
//   - **DNS rebinding 무력화**: 프록시 타겟이 고정 loopback IP(DNS 0)라 rebinding 이 적용 안 된다 —
//     공격자가 Host 헤더를 바꿔도 우리는 항상 Ipv4Addr::LOCALHOST 로만 connect 한다(주소가 Host 에서
//     파생되지 않음). HTTP 바이트를 우리가 파싱/재작성하지 않으므로 Host 헤더 자체가 라우팅에 무관 —
//     loopback-only 가 rebinding 을 구조적으로 제거한다(Hermes 패턴의 더 강한 형태: 검증이 아니라 부재).
//   - **기밀성**: 프록시되는 바이트는 Noise 채널을 탄다 — 릴레이는 ciphertext 만 본다(NoiseChannel
//     encrypt/decrypt 재사용, 평문 경로 0). inbound 복호 → local, local → outbound 암호.
//
// 이 모듈은 검증된 floor(auth/noise/session)를 **재사용**한다(셋 무수정 — additive). authorize_tunnel
// 은 auth.rs 의 verify 를 그대로 호출하고(같은 Ed25519 assertion 게이트), 그 위에 포트 ∈ allowlist 만
// 더한다. 공개 표면 일부는 serve/glue/CLI 만 호출하므로 테스트가 행위로 강제 — dead_code 허용.
#![allow(dead_code)]

use std::collections::BTreeSet;
use std::net::Ipv4Addr;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::remote::auth::{AuthDecision, CapabilityAssertion, DeviceRegistry, DenyReason, Scope, VerifyCtx};
use crate::remote::noise::NoiseChannel;

// ===========================================================================
// 0. PortAllowlist — 데스크톱 소유 터널 가능 포트 집합(anti-escalation).
// ===========================================================================

/// 터널링이 허용된 loopback 포트 집합 — **데스크톱이 소유**한다(설정/glue 가 구성). 폰은 이
/// 집합을 어떤 frame 으로도 바꿀 수 없다(danger gate config-freeze 의 거울).
///
/// 이 타입의 mutate 메서드(allow/clear)는 **데스크톱 측 glue/설정만** 호출한다 — authorize_tunnel
/// 은 `&self`(불변)로만 받으므로, 폰 frame 처리 경로에서 allowlist 가 변이될 구조적 경로가 없다.
/// "phone cannot escalate" 불변식은 이 `&self` 경계로 강제된다(타입 시스템 — mutate 인자 부재).
#[derive(Debug, Clone, Default)]
pub struct PortAllowlist {
    /// 허용 포트 — 정렬 집합(결정적 열거, 노출/감사 RULE 8). loopback 포트만 의미가 있다.
    ports: BTreeSet<u16>,
}

impl PortAllowlist {
    /// 빈 allowlist — 기본값. 어떤 포트도 터널 불가(fail-closed: 명시 allow 없으면 전부 거부).
    pub fn new() -> Self {
        PortAllowlist {
            ports: BTreeSet::new(),
        }
    }

    /// 명시 포트 목록으로 allowlist 구성(데스크톱 설정/glue 전용). 0 은 무의미하므로 무시한다
    /// (포트 0 = OS 할당 placeholder, 실 타겟 아님).
    pub fn from_ports(ports: impl IntoIterator<Item = u16>) -> Self {
        let mut set = BTreeSet::new();
        for p in ports {
            if p != 0 {
                set.insert(p);
            }
        }
        PortAllowlist { ports: set }
    }

    /// 포트 하나를 allow 한다 — **데스크톱 권위 전용**(설정 변경). 폰 frame 은 이 메서드에 닿지
    /// 못한다(authorize_tunnel 은 &self 만 받는다). 포트 0 은 무시(placeholder).
    pub fn allow(&mut self, port: u16) {
        if port != 0 {
            self.ports.insert(port);
        }
    }

    /// 포트를 제거한다(데스크톱 권위 전용 — kill).
    pub fn deny(&mut self, port: u16) -> bool {
        self.ports.remove(&port)
    }

    /// 전부 비운다(데스크톱 권위 전용).
    pub fn clear(&mut self) {
        self.ports.clear();
    }

    /// 이 포트가 터널 가능한가 — **순수 조회(불변)**. authorize_tunnel 의 유일한 allowlist 게이트.
    /// 포트 0 은 절대 통과 안 한다(placeholder — 실 타겟 아님).
    pub fn is_allowed(&self, port: u16) -> bool {
        port != 0 && self.ports.contains(&port)
    }

    /// 허용 포트의 정렬 사본 — 데스크톱 UI/감사 노출(RULE 8 observable config). 평문 키/토큰 0.
    pub fn allowed_ports(&self) -> Vec<u16> {
        self.ports.iter().copied().collect()
    }

    /// 허용 포트 수(회계/테스트).
    pub fn len(&self) -> usize {
        self.ports.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ports.is_empty()
    }
}

// ===========================================================================
// 1. 터널 요청 페이로드 — 첫 frame 의 request 바이트가 담는 target 포트.
// ===========================================================================

/// 터널 요청 와이어 prefix(첫 frame 의 request 바이트). 명령 dispatch 와 **명시적으로 구분**되는
/// 별개 모드 마커 + target 포트. 형식: `b"tunnel:" + port(u16 LE 2바이트)`.
///
/// 명령 dispatch frame 의 request 는 JSON(`{"method":...}`)이고, 터널 frame 의 request 는 이
/// prefix 다 — 둘은 와이어에서 구분되며 serve_tunnel/serve_connection 이 각자 자기 모드만 처리한다
/// (blur 0). 파서는 절대 패닉하지 않는다(malformed ⇒ None, graceful 거부).
const TUNNEL_REQUEST_PREFIX: &[u8] = b"tunnel:";

/// 터널 요청 request 바이트를 만든다(클라이언트 측 — open_tunnel 이 사용). `tunnel:` + port LE.
pub fn encode_tunnel_request(port: u16) -> Vec<u8> {
    let mut out = Vec::with_capacity(TUNNEL_REQUEST_PREFIX.len() + 2);
    out.extend_from_slice(TUNNEL_REQUEST_PREFIX);
    out.extend_from_slice(&port.to_le_bytes());
    out
}

/// 터널 요청 request 바이트 → target 포트. prefix 불일치/길이 불량 ⇒ None(거부 표면, 패닉 0).
pub fn decode_tunnel_request(request: &[u8]) -> Option<u16> {
    let rest = request.strip_prefix(TUNNEL_REQUEST_PREFIX)?;
    if rest.len() != 2 {
        return None;
    }
    let arr: [u8; 2] = rest.try_into().ok()?;
    Some(u16::from_le_bytes(arr))
}

// ===========================================================================
// 2. TunnelGrant / TunnelDenied — 터널 인가 결정(브리지 게이트 + allowlist).
// ===========================================================================

/// 터널이 인가된 결과 — **target 포트를 봉인**해 들고 있다. 이 값이 존재한다는 사실 자체가
/// (1) auth floor 통과(유효 페어링/서명/신선도/scope) + (2) 포트 ∈ allowlist 의 증거다.
/// 필드 private — port() 로만 읽는다(임의 포트 주입 불가, proxy 는 이 봉인 포트로만 connect).
#[derive(Debug)]
pub struct TunnelGrant {
    device_id: String,
    port: u16,
}

impl TunnelGrant {
    /// 인가된 터널의 target 포트(allowlist 통과 + auth 통과의 봉인 산물). proxy 가 이 포트로만
    /// 127.0.0.1 에 connect 한다 — 외부에서 다른 포트를 끼워넣을 경로가 없다.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// 어느 기기의 터널인가(감사/표시).
    pub fn device_id(&self) -> &str {
        &self.device_id
    }
}

/// 터널 인가 거부 사유 — 전부 fail-closed(connect 0). 어떤 사유든 TcpStream::connect 시도 0.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TunnelDenied {
    /// 첫 frame 이 터널 요청 형식이 아님(prefix/길이 불량). 모드 혼동 거부.
    MalformedRequest,
    /// auth floor 거부(미페어링/위조/만료/재생/scope 상승/revoked) — 사유 전달. 브리지 게이트.
    Unauthorized(DenyReason),
    /// frame 의 assertion.device_id 가 채널이 인증한 peer 기기와 불일치(smuggling 차단).
    DeviceMismatch,
    /// 포트가 allowlist 밖 — **SSRF 0**(connect 시도 전 거부). 폰은 포트를 추가할 수 없다.
    PortNotAllowed(u16),
}

/// 터널 인가 결과 — Granted(봉인 포트) | Denied(사유). 기본값은 Denied(fail-closed).
#[derive(Debug)]
pub enum TunnelDecision {
    Granted(TunnelGrant),
    Denied(TunnelDenied),
}

impl TunnelDecision {
    pub fn granted(&self) -> Option<&TunnelGrant> {
        match self {
            TunnelDecision::Granted(g) => Some(g),
            TunnelDecision::Denied(_) => None,
        }
    }

    pub fn denied(&self) -> Option<&TunnelDenied> {
        match self {
            TunnelDecision::Denied(d) => Some(d),
            TunnelDecision::Granted(_) => None,
        }
    }

    pub fn is_granted(&self) -> bool {
        matches!(self, TunnelDecision::Granted(_))
    }
}

// ===========================================================================
// 3. authorize_tunnel — 브리지 auth 게이트 + allowlist(connect 이전, SSRF 0).
// ===========================================================================

/// 터널 첫 frame 을 인가한다 — **TcpStream::connect 이전에 모든 게이트를 통과시킨다**(SSRF 0).
///
/// 게이트 순서(전부 통과해야 Granted):
///   1. 기기-신원 결속: assertion.device_id == peer_device_id(채널이 인증한 기기). 불일치 ⇒
///      DeviceMismatch(A 채널로 B assertion 재생 차단 — session.rs 와 동일 불변식).
///   2. (브리지 auth 게이트) registry.verify(assertion, sig, ctx) — **auth.rs 의 동일 Ed25519 게이트
///      재사용**(평행 구현 0). 미페어링/위조/만료/재생/scope 상승/revoked ⇒ Unauthorized. 유효
///      채널이라도 유효 assertion 없으면 여기서 막힌다(채널 ≠ 인가).
///   3. request 파싱: `tunnel:port` ⇒ target 포트. 형식 불량 ⇒ MalformedRequest.
///   4. (allowlist 게이트, **SSRF 0**) allowlist.is_allowed(port). 밖이면 PortNotAllowed —
///      **connect 를 시도조차 안 한다**(이 함수는 connect 를 안 한다; proxy 가 Granted 일 때만 한다).
///      allowlist 는 `&self`(불변)로만 들어오므로 폰이 추가할 수 없다(anti-escalation).
///
/// 반환: Granted(TunnelGrant{봉인 포트}) — proxy 가 이 포트로만 127.0.0.1 에 connect.
///        Denied(사유) — connect 0(어떤 TcpStream 도 안 열린다).
///
/// **nonce 소비**: verify 가 nonce 를 1회 소비한다(재생 차단) — 명령 frame 과 동일 게이트.
/// `&mut DeviceRegistry`: nonce 소비 + 워터마크 전진(auth floor 의 부작용).
pub fn authorize_tunnel(
    assertion: &CapabilityAssertion,
    signature: &[u8],
    request: &[u8],
    peer_device_id: &str,
    registry: &mut DeviceRegistry,
    ctx: VerifyCtx,
    allowlist: &PortAllowlist,
) -> TunnelDecision {
    // (1) 기기-신원 결속 — 채널 peer 와 assertion 기기 교차검증. nonce 미소비(검증 전).
    if assertion.device_id != peer_device_id {
        return TunnelDecision::Denied(TunnelDenied::DeviceMismatch);
    }

    // (3) request 파싱 먼저 — 형식 불량이면 auth 게이트(nonce 소비) 전에 거부(nonce 보존).
    //     포트 추출은 allowlist 게이트의 입력이지만 verify 와 독립이므로 순서는 무관.
    let port = match decode_tunnel_request(request) {
        Some(p) => p,
        None => return TunnelDecision::Denied(TunnelDenied::MalformedRequest),
    };

    // (2) 브리지 auth 게이트 — auth.rs 의 동일 verify 재사용(평행 구현 0). nonce 1회 소비.
    //     이 호출 하나가 미페어링/위조/만료/재생/롤백/scope 상승/revoked 전부를 fail-closed 로 막는다.
    let grant = match registry.verify(assertion, signature, ctx) {
        AuthDecision::Granted(g) => g,
        AuthDecision::Denied(reason) => {
            return TunnelDecision::Denied(TunnelDenied::Unauthorized(reason));
        }
    };

    // (4) allowlist 게이트 — **SSRF 0**. allowlist 밖 포트 ⇒ connect 시도 0, 거부.
    //     allowlist 는 &self(불변) — 폰 frame 은 이 집합을 바꿀 수 없다(anti-escalation).
    if !allowlist.is_allowed(port) {
        return TunnelDecision::Denied(TunnelDenied::PortNotAllowed(port));
    }

    // 모든 게이트 통과 — 봉인된 포트로 TunnelGrant. proxy 가 이 포트로만 loopback 에 connect.
    TunnelDecision::Granted(TunnelGrant {
        device_id: grant.device_id().to_string(),
        port,
    })
}

// ===========================================================================
// 4. proxy — 인가된 채널 ↔ 127.0.0.1:port 양방향 바이트 파이프(loopback-only, E2E).
// ===========================================================================

/// 프록시 종료 사유 — 어느 쪽이 먼저 닫혔는지/실패했는지(감사/테스트). 패닉 0.
#[derive(Debug)]
pub enum ProxyError {
    /// 로컬 포트가 안 떠 있음(connect 실패) — clean 에러(데스크톱에서 dev-server 미기동 등).
    LocalConnect(std::io::Error),
    /// 채널/스트림 I/O 실패(읽기/쓰기) 도중.
    Io(std::io::Error),
    /// inbound ciphertext 복호 실패(변조/순서뒤바뀜) — fail-closed(garbage 평문 0).
    Decrypt,
    /// outbound 평문 암호화 실패(채널 버퍼) — 정상 경로 도달 0.
    Encrypt,
}

impl std::fmt::Display for ProxyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProxyError::LocalConnect(e) => write!(f, "local connect: {e}"),
            ProxyError::Io(e) => write!(f, "proxy io: {e}"),
            ProxyError::Decrypt => f.write_str("inbound decrypt failed (AEAD)"),
            ProxyError::Encrypt => f.write_str("outbound encrypt failed"),
        }
    }
}

impl std::error::Error for ProxyError {}

/// **loopback 전용 connect** — 인가된 포트로 `127.0.0.1:port` 에 TCP 연결한다. **오직 LOCALHOST**
/// (DNS 0 · host 입력 0 · non-loopback 0). 이 함수가 우리의 유일한 outbound connect 표면이며,
/// 주소가 어떤 입력(Host 헤더 등)에서도 파생되지 않으므로 SSRF/DNS-rebinding 이 구조적으로 부재한다.
///
/// 포트가 안 떠 있으면 LocalConnect 에러(clean — 패닉 0). grant.port() 는 authorize_tunnel 이
/// allowlist 통과로만 봉인한 포트라, 여기 도달하는 포트는 항상 allowlist 안이다.
pub async fn connect_local(grant: &TunnelGrant) -> Result<TcpStream, ProxyError> {
    // **고정 loopback IP** — Ipv4Addr::LOCALHOST(127.0.0.1). 절대 다른 주소로 안 간다.
    TcpStream::connect((Ipv4Addr::LOCALHOST, grant.port()))
        .await
        .map_err(ProxyError::LocalConnect)
}

/// 인가된 Noise 채널 ↔ 로컬 스트림(127.0.0.1:port) 을 **양방향 바이트 파이프**로 잇는다.
///
/// 두 방향(동시):
///   - inbound  : 채널에서 길이-프리픽스 ciphertext frame 을 읽어 **복호**(NoiseChannel::decrypt)
///                → 평문 바이트를 **로컬 스트림에 write**(폰 → dev-server).
///   - outbound : 로컬 스트림에서 raw 바이트를 읽어 **암호화**(NoiseChannel::encrypt) → 길이-프리픽스
///                ciphertext frame 을 **채널에 write**(dev-server → 폰).
///
/// 어느 한쪽이 닫히면(EOF/에러) 둘 다 정리하고 반환한다(graceful). **평문은 와이어에 안 나간다**
/// (릴레이 zero-knowledge — inbound 는 채널에서 복호, outbound 는 채널로 암호화). 멀티-청크 응답이
/// 스트리밍으로 흐른다(한 왕복이 아니라 양방향 연속 복사).
///
/// `channel_*` = 폰과의 Noise 채널의 read/write 절반(transport 가 split 해서 넘긴다). `local` =
/// 127.0.0.1:port 에 connect 된 TcpStream(connect_local 산물). 채널의 send/recv counter 는 단조
/// 증가하므로 한 채널을 두 task 가 나눠 쓰려면 채널을 한쪽이 소유해야 한다 — 그래서 채널은 단일
/// task 에서 read↔decrypt↔write 양방향을 교대로 처리하는 select 루프로 돌린다(아래 구현).
pub async fn proxy<CR, CW, L>(
    mut channel_read: CR,
    mut channel_write: CW,
    mut channel: NoiseChannel,
    local: L,
) -> Result<(), ProxyError>
where
    CR: AsyncRead + Unpin,
    CW: AsyncWrite + Unpin,
    L: AsyncRead + AsyncWrite + Unpin,
{
    // 로컬 스트림을 read/write 절반으로 split — 두 방향을 동시에 처리(streaming, 한 왕복 아님).
    let (mut local_read, mut local_write) = tokio::io::split(local);

    // 로컬에서 읽을 raw 청크 버퍼. dev-server 응답이 멀티-청크여도 each 청크를 즉시 forward.
    let mut local_buf = vec![0u8; 16 * 1024];

    loop {
        tokio::select! {
            // inbound: 폰 → dev-server. 채널 ciphertext frame 읽기 → 복호 → 로컬 write.
            framed = read_framed(&mut channel_read) => {
                match framed? {
                    Some(ciphertext) => {
                        // 복호 — 변조/순서뒤바뀜 ⇒ Decrypt(fail-closed, garbage 평문 0).
                        let plaintext = channel.decrypt(&ciphertext).map_err(|_| ProxyError::Decrypt)?;
                        if plaintext.is_empty() {
                            // 빈 평문 = 폰 측 EOF 신호(write half 종료). 로컬도 닫는다(graceful).
                            let _ = local_write.shutdown().await;
                            // 채널 read 가 다음 None 을 줄 때까지 outbound 만 계속 흐를 수 있으므로
                            // 여기서 끊지 않고, 채널 EOF(None) 가 루프를 끝내게 둔다.
                            continue;
                        }
                        local_write.write_all(&plaintext).await.map_err(ProxyError::Io)?;
                        local_write.flush().await.map_err(ProxyError::Io)?;
                    }
                    None => {
                        // 채널 EOF(폰이 끊음) — 로컬도 닫고 종료(graceful).
                        let _ = local_write.shutdown().await;
                        return Ok(());
                    }
                }
            }
            // outbound: dev-server → 폰. 로컬 raw 읽기 → 암호화 → 채널 frame write.
            n = local_read.read(&mut local_buf) => {
                let n = n.map_err(ProxyError::Io)?;
                if n == 0 {
                    // 로컬 EOF(dev-server 가 응답 끝/끊음) — 채널에 빈 평문(EOF 신호) 보내고 종료.
                    let eof = channel.encrypt(&[]).map_err(|_| ProxyError::Encrypt)?;
                    write_framed(&mut channel_write, &eof).await?;
                    return Ok(());
                }
                // 암호화 — 평문은 와이어에 안 나간다(릴레이 zero-knowledge). 각 청크를 즉시 frame.
                let ciphertext = channel.encrypt(&local_buf[..n]).map_err(|_| ProxyError::Encrypt)?;
                write_framed(&mut channel_write, &ciphertext).await?;
            }
        }
    }
}

// ===========================================================================
// 5. 길이-프리픽스 코덱(u32 BE) — transport.rs / client.rs 와 정확히 같은 와이어.
// ===========================================================================

/// Noise transport 메시지 하드 캡(transport.rs MAX_NOISE_MESSAGE 와 동일 — 증폭/DoS 0).
const MAX_FRAME: usize = 65535;

/// 길이-프리픽스 1개 읽기: u32(BE) → 그만큼 바이트. 캡 초과 ⇒ Io(InvalidData), EOF ⇒ None.
async fn read_framed<R>(r: &mut R) -> Result<Option<Vec<u8>>, ProxyError>
where
    R: AsyncRead + Unpin,
{
    let mut len_buf = [0u8; 4];
    match r.read_exact(&mut len_buf).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(ProxyError::Io(e)),
    }
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > MAX_FRAME {
        return Err(ProxyError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "frame length prefix exceeds cap",
        )));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).await.map_err(ProxyError::Io)?;
    Ok(Some(body))
}

/// 길이-프리픽스 1개 쓰기: u32(BE) → 바이트. 캡 초과는 쓰지 않는다(불변식).
async fn write_framed<W>(w: &mut W, bytes: &[u8]) -> Result<(), ProxyError>
where
    W: AsyncWrite + Unpin,
{
    if bytes.len() > MAX_FRAME {
        return Err(ProxyError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "frame length prefix exceeds cap",
        )));
    }
    let len = (bytes.len() as u32).to_be_bytes();
    w.write_all(&len).await.map_err(ProxyError::Io)?;
    w.write_all(bytes).await.map_err(ProxyError::Io)?;
    w.flush().await.map_err(ProxyError::Io)?;
    Ok(())
}

/// 터널 모드가 read-only/write/destructive 어느 scope 를 요구하는가 — 터널은 **Write** 로 본다
/// (비파괴 양방향 바이트 통로지만 read-only 보다는 강한 권한 — 명시 opt-in). read-only 폰은
/// 터널을 열 수 없다(scope ⊆ granted 게이트가 auth.rs 에서 강제). destructive 까지 요구하지는
/// 않는다(데스크톱 confirm 은 명령 파괴성에 대한 것이지 바이트 통로에 대한 것이 아님).
pub const TUNNEL_SCOPE: Scope = Scope::Write;

/// 테스트 전용 — authorize_tunnel 의 봉인을 거치지 않고 TunnelGrant 를 만든다(connect_local 단위
/// 검증용). private 필드라 같은 모듈에서만 구성 가능 — 프로덕션 경로는 authorize_tunnel 만이 봉인한다.
#[cfg(test)]
pub(crate) fn grant_for_test(device_id: &str, port: u16) -> TunnelGrant {
    TunnelGrant {
        device_id: device_id.to_string(),
        port,
    }
}

#[cfg(test)]
mod tests;
