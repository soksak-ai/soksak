// remote::transport — 보안 세션을 "아무 바이트 스트림" 위에 얹는 transport-agnostic 어댑터.
//
// 이 모듈은 이미 검증된 세 floor(noise/auth/session)를 **그대로 재사용**한다(additive — 셋을
// 손대지 않는다). 책임은 단 하나: 임의의 AsyncRead+AsyncWrite 스트림 위에서
//   (a) Noise KK 핸드셰이크를 RESPONDER 로 돌려 미페어링/미상/revoked peer 면 채널 미성립,
//   (b) 성립 시 SecureSession 봉인,
//   (c) 길이-프리픽스 ciphertext frame 을 루프 처리(handle_frame), 응답도 길이-프리픽스 암호화.
//
// **transport-agnostic 이 핵심(RULE 5 기초)**: iroh/Go-relay/cloudflared(P2) 는 이 동일
// serve_connection 을 자기 스트림(QUIC bi-stream/yamux substream/터널 소켓) 위에 재호출한다.
// 여기서 TCP 에 결속하지 않는다 — TcpListener 는 tcp.rs 가 따로 소유하고, 이 함수에 스트림만 넘긴다.
//
// 절대 불변식(세 floor 에서 상속 — 여기서 약화 0):
//   - 인증-우선-연결(fail-closed): 미핀닝/revoked peer ⇒ Handshake::respond 가 Err ⇒ 채널이
//     아예 안 생긴다(거부가 아니라 미성립) ⇒ serve_connection 이 dispatch 없이 즉시 종료.
//   - 핸드셰이크-전-데이터 0: 핸드셰이크 완료 전 어떤 frame 도 dispatch 에 닿지 않는다.
//   - 릴레이 zero-knowledge: 와이어에는 ciphertext 만 — 평문 frame/응답이 스트림에 안 나간다.
//   - malformed graceful: 길이 프리픽스 초과/잘림/garbage ⇒ 패닉 0, 연결만 닫힌다(DoS 0).
//   - 데스크톱 confirm 권위: destructive 는 desktop_token 없이는 dispatch 0(session floor 가 강제).
//
// 공개 표면 일부는 tcp.rs/glue 만 호출하므로 단위테스트가 행위로 강제한다 — dead_code 허용.
#![allow(dead_code)]

use std::sync::{Arc, Mutex};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::remote::auth::{
    AuthorizedAction, DesktopConfirmToken, DeviceRegistry, VerifyCtx,
};
use crate::remote::noise::{Handshake, NoiseError, PinnedPeerRegistry, StaticKeypair};
use crate::remote::session::SecureSession;

// ===========================================================================
// 0. 와이어 상수 — 길이 프리픽스 한계(Noise frame 캡과 정합).
// ===========================================================================

/// Noise transport 메시지의 하드 캡(snow). 한 ciphertext frame 은 이보다 클 수 없다.
/// 응답/요청 모두 이 한계를 넘는 길이 프리픽스는 거부한다(메모리 증폭/DoS 0).
pub const MAX_NOISE_MESSAGE: usize = 65535;

/// 핸드셰이크 **전** initiator 가 보내는 device_id 의 최대 바이트(작은 식별자만 — 메모리 증폭 0).
/// KK responder 는 어느 핀닝 peer 와 핸드셰이크할지 알아야 하므로, initiator 가 자기 id 를
/// 길이-프리픽스 한 줄로 먼저 announce 한다. 이 announce 는 **신뢰 입력이 아니다** — 거짓 id 면
/// responder 가 그 id 의 핀닝 키로 KK 를 세우고, initiator 가 실제로 그 키의 개인키를 갖지 않으면
/// KK 의 정적-정적 바인딩이 깨져 핸드셰이크가 미완(채널 0). id 는 핸드셰이크가 증명한다.
pub const MAX_DEVICE_ID_LEN: usize = 256;

// ===========================================================================
// 1. ServeError — 연결 처리 실패 분류(전부 fail-closed: dispatch 없이 종료).
// ===========================================================================

/// serve_connection 의 종료 사유. 어떤 사유든 **연결이 닫히고 dispatch 는 일어나지 않는다**.
/// (핸드셰이크 성립 후 정상 frame 루프에서 클라이언트가 끊으면 Ok(())로 끝난다.)
#[derive(Debug)]
pub enum ServeError {
    /// 스트림 I/O 실패(읽기/쓰기) 또는 클라이언트가 announce 도중 끊김.
    Io(std::io::Error),
    /// announce 된 device_id 가 길이 한계 초과/형식 불량(비-UTF8).
    BadDeviceId,
    /// 핸드셰이크 미성립 — 미핀닝/revoked/미상 peer 또는 DH/MAC 불일치. 채널 0 ⇒ dispatch 0.
    Handshake(NoiseError),
    /// 길이 프리픽스가 한계 초과 — malformed/증폭 시도. 연결만 닫는다(패닉 0).
    FrameTooLarge,
}

impl std::fmt::Display for ServeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ServeError::Io(e) => write!(f, "transport io: {e}"),
            ServeError::BadDeviceId => f.write_str("bad device id announce"),
            ServeError::Handshake(e) => write!(f, "handshake not established: {e}"),
            ServeError::FrameTooLarge => f.write_str("frame length prefix exceeds cap"),
        }
    }
}

impl std::error::Error for ServeError {}

impl From<std::io::Error> for ServeError {
    fn from(e: std::io::Error) -> Self {
        ServeError::Io(e)
    }
}

// ===========================================================================
// 2. 길이-프리픽스 코덱(u32 BE) — Noise frame 1개 = [len:u32][bytes].
// ===========================================================================

/// 길이-프리픽스 1개를 읽는다: u32(BE) 길이 → 그 길이만큼 바이트. 캡 초과면 FrameTooLarge,
/// EOF(0바이트 읽힘)면 None(정상 종료), 부분 읽힘은 read_exact 가 UnexpectedEof 로 거부.
async fn read_framed<R>(r: &mut R) -> Result<Option<Vec<u8>>, ServeError>
where
    R: AsyncRead + Unpin,
{
    let mut len_buf = [0u8; 4];
    // 첫 바이트가 안 오면(클라이언트 정상 종료) None. 부분 프리픽스는 에러.
    match r.read_exact(&mut len_buf).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(ServeError::Io(e)),
    }
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > MAX_NOISE_MESSAGE {
        return Err(ServeError::FrameTooLarge); // 증폭/형식불량 — 연결 닫음.
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).await?; // 잘림 ⇒ UnexpectedEof ⇒ Io 에러(graceful).
    Ok(Some(body))
}

/// 길이-프리픽스 1개를 쓴다: u32(BE) 길이 → 바이트. 캡 초과 페이로드는 쓰지 않는다(불변식).
async fn write_framed<W>(w: &mut W, bytes: &[u8]) -> Result<(), ServeError>
where
    W: AsyncWrite + Unpin,
{
    if bytes.len() > MAX_NOISE_MESSAGE {
        return Err(ServeError::FrameTooLarge);
    }
    let len = (bytes.len() as u32).to_be_bytes();
    w.write_all(&len).await?;
    w.write_all(bytes).await?;
    w.flush().await?;
    Ok(())
}

// ===========================================================================
// 3. SharedAuth — auth 권위의 단일 진실(여러 연결 공유). 락은 frame 처리 동안만.
// ===========================================================================

/// DeviceRegistry(페어링/nonce/revoke 의 단일 권위)를 여러 동시 연결이 공유하는 핸들.
///
/// `serve_connection` 은 **frame 1개를 처리하는 동안만** 동기 락을 잡는다(handle_frame 은
/// 동기 함수 — await 를 가로지르지 않으므로 std Mutex 로 충분하고 교착 0). 그래서 두 동시
/// 연결이 핸드셰이크/I/O 는 병렬로 하면서 인가 판정만 같은 권위로 직렬화된다. 한 탭을 mid-session
/// revoke 하면(다른 곳에서 lock().revoke()) **그 연결의 다음 frame 부터** Denied — 다른 연결은
/// 무영향(매트릭스 "1탭 unpair→즉시 drop", 연결 격리).
#[derive(Clone)]
pub struct SharedAuth {
    inner: Arc<Mutex<DeviceRegistry>>,
}

impl SharedAuth {
    pub fn new(registry: DeviceRegistry) -> Self {
        SharedAuth {
            inner: Arc::new(Mutex::new(registry)),
        }
    }

    /// 공유 권위에 잠금 접근(페어링/revoke 등 — 호출자가 관리). frame 처리와 같은 Mutex.
    pub fn lock(&self) -> std::sync::MutexGuard<'_, DeviceRegistry> {
        self.inner.lock().expect("auth registry mutex poisoned")
    }
}

// ===========================================================================
// 4. serve_connection — transport-agnostic 핸드셰이크 + frame 루프(fail-closed).
// ===========================================================================

/// 한 바이트 스트림을 보안 세션으로 서비스한다. **어떤** AsyncRead+AsyncWrite 위에서도 동일하게
/// 동작한다(TCP·iroh QUIC·yamux·cloudflared 소켓 — RULE 5 기초).
///
/// 흐름(전부 fail-closed):
///   1. announce: initiator 가 자기 device_id 를 길이-프리픽스 한 줄로 보낸다(핸드셰이크 전).
///      id 는 "어느 핀닝 peer 로 KK 를 세울지" 의 힌트일 뿐 신뢰 입력이 아니다(핸드셰이크가 증명).
///   2. (게이트 1, 채널) Handshake::respond(local, noise_registry, announced_id) — 미핀닝/revoked
///      /미상 id ⇒ Err ⇒ **채널 미성립** ⇒ 즉시 반환(dispatch 0). 그 다음 KK 2-메시지 교환:
///      <- 읽기(m1), -> 쓰기(m2). initiator 가 실제 핀닝 키의 개인키를 안 가지면 read_message
///      에서 DH/MAC 불일치 ⇒ HandshakeFailed ⇒ 채널 0.
///   3. SecureSession::establish(handshake, announced_id) — 봉인. 이제 peer 기기 신원이 채널에
///      결속(이후 frame 의 assertion.device_id 가 이것과 교차검증됨).
///   4. frame 루프: 길이-프리픽스 ciphertext 를 읽어 session.handle_frame(...) 호출(요청별 ctx 를
///      now_fn 으로 신선하게 산출) → 암호화된 응답을 길이-프리픽스로 회신. 클라이언트가 끊으면 Ok.
///
/// `auth`/`desktop_token_for`/`dispatch` 는 호출자(transport/glue)가 주입한다:
///   - auth: SharedAuth — DeviceRegistry 권위(여러 연결이 한 권위를 공유 — 단일 진실).
///     frame 처리 동안만 락(handle_frame 동기 호출). 다른 연결/관리코드의 revoke 가 즉시 반영.
///   - now_fn: 매 frame 의 VerifyCtx.now 를 산출(신선도 검사 — 테스트는 고정값, 실제는 시계).
///   - desktop_token_for: peer 기기에 대해 데스크톱이 발급해 둔 confirm 토큰이 있으면 제공
///     (destructive 경로). 토큰은 (device, nonce) 결속이라 session floor 가 frame 의 실제 nonce
///     와 매칭한다 — 불일치/부재면 dispatch 0. **THIS STEP**: 데스크톱 모달→토큰 발급 왕복은
///     별도 후속이므로, 실제 앱 glue 는 항상 None 을 돌려주는 provider 를 주입한다 ⇒ destructive 는
///     fail-closed deny-until-token(올바른 계층화, 꼼수 아님 — 폰은 토큰을 위조 불가, auth.rs 의
///     DesktopConfirmToken 생성자 경계). 토큰을 데스크톱이 보유한 경우만 그 보유분을 노출한다.
///   - dispatch: AuthorizedAction(인가 산물) + 불투명 request 바이트 → 응답 바이트. session floor 가
///     Grant 없이는 이 콜백에 닿지 못하게 구조적으로 강제한다(엮인 게이트).
///
/// 반환: 정상 종료(클라이언트 끊김) ⇒ Ok(()). 핸드셰이크 미성립/형식불량/I/O ⇒ Err(ServeError)
/// — 어느 경우든 dispatch 는 인가된 frame 에서만 일어났고, 미인증 경로는 0.
pub async fn serve_connection<S, NowF, TokF, Disp>(
    mut stream: S,
    local: &StaticKeypair,
    noise_registry: &PinnedPeerRegistry,
    auth: &SharedAuth,
    mut now_fn: NowF,
    mut desktop_token_for: TokF,
    mut dispatch: Disp,
) -> Result<(), ServeError>
where
    S: AsyncRead + AsyncWrite + Unpin,
    NowF: FnMut() -> u64,
    TokF: FnMut(&str) -> Option<DesktopConfirmToken>,
    Disp: FnMut(&AuthorizedAction, &[u8]) -> Vec<u8>,
{
    // 1. announce — initiator 가 자기 device_id 를 보낸다(핸드셰이크 전, 길이-프리픽스).
    let id_bytes = match read_framed(&mut stream).await? {
        Some(b) => b,
        None => return Ok(()), // 아무것도 안 보내고 끊김 — 정상(빈 연결).
    };
    if id_bytes.len() > MAX_DEVICE_ID_LEN {
        return Err(ServeError::BadDeviceId);
    }
    let device_id = String::from_utf8(id_bytes).map_err(|_| ServeError::BadDeviceId)?;

    // 2. (게이트 1) responder 핸드셰이크 — 미핀닝/revoked/미상 ⇒ 채널 미성립(dispatch 0).
    let mut handshake = Handshake::respond(local, noise_registry, &device_id)
        .map_err(ServeError::Handshake)?;

    // KK 2-메시지: <- m1 읽기, -> m2 쓰기. (initiator 가 e,es,ss 를 보내고 우리가 e,ee,se 응답.)
    let m1 = match read_framed(&mut stream).await? {
        Some(b) => b,
        None => return Ok(()), // announce 후 끊김 — 핸드셰이크 미완(채널 0).
    };
    handshake.read_message(&m1).map_err(ServeError::Handshake)?; // 틀린 키 ⇒ HandshakeFailed.
    let m2 = handshake.write_message().map_err(ServeError::Handshake)?;
    write_framed(&mut stream, &m2).await?;

    // 3. 봉인 — 미완 핸드셰이크면 establish 가 Err(채널 0). announce id 를 peer 신원으로 결속.
    let mut session =
        SecureSession::establish(handshake, &device_id).map_err(ServeError::Handshake)?;

    // 4. frame 루프 — 길이-프리픽스 ciphertext 마다 handle_frame, 암호화된 응답을 길이-프리픽스 회신.
    while let Some(ciphertext) = read_framed(&mut stream).await? {
        // 매 frame 신선한 ctx(신선도/단조 검사). destructive 면 provider 가 데스크톱 보유
        // 토큰을 노출한다(없으면 None ⇒ deny-until-token). session floor 가 토큰의 (device,
        // nonce) 를 복호된 frame 과 매칭하므로, 엉뚱한 토큰은 ConfirmMismatch 로 dispatch 0.
        let ctx = VerifyCtx { now: now_fn() };
        let token = desktop_token_for(session.peer_device_id());
        // 공유 권위 락 — handle_frame(동기) 동안만. await 를 가로지르지 않으므로 교착 0.
        // 락 안에서 인가 판정 + nonce 소비가 원자적 → 동시 연결의 재생/revoke race-free.
        let response = {
            let mut reg = auth.lock();
            session.handle_frame(&ciphertext, &mut reg, ctx, token.as_ref(), &mut dispatch)
        };
        write_framed(&mut stream, &response).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
