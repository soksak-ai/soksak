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
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::remote::auth::{
    AuthorizedAction, DesktopConfirmToken, DeviceRegistry, VerifyCtx,
};
use crate::remote::confirm::{ConfirmDecision, PendingConfirms};
use crate::remote::noise::{Handshake, NoiseError, PinnedPeerRegistry, StaticKeypair};
use crate::remote::session::{FrameOutcomeChunked, SecureSession};

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
        // **청크 회신**: 응답이 한 frame 을 넘으면(state.commands 류) 헤더+청크 N frame 으로 흘린다
        // (작은 응답은 단일 frame — 이전 와이어와 동일, fast-path 무회귀).
        let frames = {
            let mut reg = auth.lock();
            session.handle_frame_chunked(&ciphertext, &mut reg, ctx, token.as_ref(), &mut dispatch)
        };
        write_logical(&mut stream, &frames).await?;
    }
    Ok(())
}

/// 한 논리 응답을 이루는 frame 들(헤더+청크 또는 단일)을 순서대로 길이-프리픽스 송신한다. Noise
/// counter 가 각 frame 의 순서/재생을 강제하므로 별도 시퀀스 번호 불요 — 받는 쪽은 복호 순서대로
/// 재조립한다. 한 frame 이라도 쓰기 실패면 즉시 Err(부분 송신은 상위 read timeout/EOF 가 잡음).
async fn write_logical<W>(w: &mut W, frames: &[Vec<u8>]) -> Result<(), ServeError>
where
    W: AsyncWrite + Unpin,
{
    for frame in frames {
        write_framed(w, frame).await?;
    }
    Ok(())
}

// ===========================================================================
// 5. serve_connection_confirmed — destructive 를 데스크톱 사람 결정에 PARK 하는 변형(additive).
// ===========================================================================

/// 데스크톱 모달이 띄울 confirm 요청. 어댑터가 emit_confirm 콜백으로 받아 실제 앱에선
/// `app.emit("remote-confirm-request", {request_id, device_id, command, danger})` 한다(테스트는
/// 콜백을 직접 검사 — Tauri 비의존). danger 는 항상 true(이 경로는 destructive 만 도달).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfirmRequest {
    /// resolve 의 키(PendingConfirms 가 발급). 데스크톱 모달이 그대로 remote_confirm_resolve 로 회신.
    pub request_id: u64,
    /// 어느 원격 기기의 요청인가(표시/감사).
    pub device_id: String,
    /// 사람이 읽을 명령 요약(예: "panel.close").
    pub command: String,
    /// 항상 true — destructive 만 이 경로에 도달(데스크톱 confirm 필수).
    pub danger: bool,
}

/// serve_connection 의 **파킹 변형**: destructive grant 를 만나면 그 frame 의 응답을 PARK 하고
/// 데스크톱 사람 결정을 oneshot 으로 **await** 한다(폴링 0 — RULE 7). 읽기 전용/비파괴 경로는
/// serve_connection 과 **동일**(즉시 dispatch, 파킹 0) — destructive 분기만 추가된다(additive).
///
/// 흐름(handshake 는 serve_connection 과 동일 — 미페어링/revoked ⇒ 채널 0):
///   frame 루프:
///     - begin_frame(게이트 1·2, nonce 1회 소비) ⇒ Terminal | AwaitConfirm.
///     - Terminal(비파괴 Ok·거부): 그대로 회신(파킹 0 — 읽기 전용 무영향).
///     - AwaitConfirm(pending, destructive): confirms.park ⇒ (request_id, oneshot rx). emit_confirm
///       으로 데스크톱 모달에 요청 emit. tokio::select!{ rx, sleep(ttl) }:
///         · APPROVE ⇒ finish_confirmed — 어댑터가 (device, bound_nonce) 토큰을 **스스로** 만들어
///           같은 Grant 를 dispatch(폰은 토큰 못 만든다). 암호화된 결과 회신.
///         · DENY/TIMEOUT ⇒ finish_denied — dispatch 0, 암호화된 "denied" 회신.
///
/// **anti-escalation 불변**: destructive 는 begin_frame 이 항상 AwaitConfirm 으로 보내고, dispatch
/// 는 finish_confirmed(APPROVE)에서만 일어난다 — destructive 를 auto-grant 로 만드는 env/config
/// 플래그가 이 함수 본문 어디에도 없다(파킹+await 가 무조건 경로).
///
/// 주입:
///   - confirms: PendingConfirms — 데스크톱 confirm 단일 권위(park/resolve). 여러 연결 공유 가능.
///   - now_fn: 매 frame 의 VerifyCtx.now + park 의 created_at(같은 시계).
///   - emit_confirm: Fn(ConfirmRequest) — 데스크톱 모달 요청 emit(실제는 app.emit, 테스트는 recorder).
///   - dispatch: AuthorizedAction + request → 응답(실제는 request_command→route).
pub async fn serve_connection_confirmed<S, NowF, EmitF, Disp>(
    mut stream: S,
    local: &StaticKeypair,
    noise_registry: &PinnedPeerRegistry,
    auth: &SharedAuth,
    confirms: &PendingConfirms,
    confirm_ttl: Duration,
    mut now_fn: NowF,
    mut emit_confirm: EmitF,
    mut dispatch: Disp,
) -> Result<(), ServeError>
where
    S: AsyncRead + AsyncWrite + Unpin,
    NowF: FnMut() -> u64,
    EmitF: FnMut(ConfirmRequest),
    Disp: FnMut(&AuthorizedAction, &[u8]) -> Vec<u8>,
{
    // 1. announce + 2. KK 핸드셰이크 — serve_connection 과 동일(fail-closed, 미페어링 ⇒ 채널 0).
    let id_bytes = match read_framed(&mut stream).await? {
        Some(b) => b,
        None => return Ok(()),
    };
    if id_bytes.len() > MAX_DEVICE_ID_LEN {
        return Err(ServeError::BadDeviceId);
    }
    let device_id = String::from_utf8(id_bytes).map_err(|_| ServeError::BadDeviceId)?;
    let mut handshake = Handshake::respond(local, noise_registry, &device_id)
        .map_err(ServeError::Handshake)?;
    let m1 = match read_framed(&mut stream).await? {
        Some(b) => b,
        None => return Ok(()),
    };
    handshake.read_message(&m1).map_err(ServeError::Handshake)?;
    let m2 = handshake.write_message().map_err(ServeError::Handshake)?;
    write_framed(&mut stream, &m2).await?;
    let mut session =
        SecureSession::establish(handshake, &device_id).map_err(ServeError::Handshake)?;

    // 3. frame 루프 — 비파괴는 즉시, destructive 는 데스크톱 결정 await.
    while let Some(ciphertext) = read_framed(&mut stream).await? {
        let ctx = VerifyCtx { now: now_fn() };
        // 게이트 1·2(동기 락) — nonce 1회 소비. destructive 면 dispatch 를 미룬다. 청크 변형이라
        // 비파괴 종결 응답이 크면(read-only state.commands 류) 헤더+청크 N frame 으로 회신한다.
        let outcome = {
            let mut reg = auth.lock();
            session.begin_frame_chunked(&ciphertext, &mut reg, ctx, &mut dispatch)
            // 락은 여기서 해제된다 — 데스크톱 await 동안 auth 권위를 잡지 않는다(다른 연결 무블록).
        };
        let frames = match outcome {
            // 비파괴 Ok·거부 — 파킹 0(읽기 전용 무영향). 그대로 회신.
            FrameOutcomeChunked::Terminal(frames) => frames,
            // destructive — 데스크톱 사람 결정을 await(이벤트-우선, 폴링 0).
            FrameOutcomeChunked::AwaitConfirm(pending) => {
                let park_now = now_fn();
                let (request_id, rx) =
                    confirms.park(pending.device_id(), pending.command(), park_now);
                // 데스크톱 모달에 confirm 요청 emit(실제는 app.emit). danger=true(destructive).
                emit_confirm(ConfirmRequest {
                    request_id,
                    device_id: pending.device_id().to_string(),
                    command: pending.command().to_string(),
                    danger: true,
                });
                // oneshot OR timeout — 둘 중 먼저 오는 쪽. sleep-poll 루프 아님(select! 가 깨운다).
                let decision = tokio::select! {
                    r = rx => match r {
                        Ok(d) => d,
                        // 송신 끝 drop(만료 청소 등) ⇒ AUTO-DENY.
                        Err(_) => ConfirmDecision::Deny,
                    },
                    _ = tokio::time::sleep(confirm_ttl) => {
                        // TTL 초과 ⇒ AUTO-DENY. parked entry 를 청소(stale 누수 0).
                        confirms.resolve(request_id, false);
                        ConfirmDecision::Deny
                    }
                };
                if decision.approved() {
                    // APPROVE — 어댑터가 (device, bound_nonce) 토큰을 스스로 만들어 같은 Grant 를
                    // dispatch(폰은 이 토큰 생성자에 도달 불가). nonce 는 begin_frame 에서 이미
                    // 소비됐으므로 registry 재상담 0 — Grant 만으로 종결(엮인 게이트 유지).
                    // 청크 변형 — 승인된 destructive 가 큰 응답을 내도 헤더+청크 N frame 으로 회신.
                    session.finish_confirmed_chunked(pending, &mut dispatch)
                } else {
                    // DENY/TIMEOUT — dispatch 0, 암호화된 "denied"(작아서 단일 frame).
                    session.finish_denied_chunked(pending)
                }
            }
        };
        write_logical(&mut stream, &frames).await?;
    }
    Ok(())
}

// ===========================================================================
// 6. serve_tunnel — 보안 세션의 POST-AUTH 모드가 "allowlist loopback 포트 프록시"인 변형(additive).
// ===========================================================================

/// serve_connection 의 **터널 변형(sibling)**: 핸드셰이크는 **정확히 동일**(미페어링/revoked/틀린
/// 키 ⇒ 채널 0 — 브리지 auth 게이트 무수정)하고, 그 다음 **터널-인가 첫 frame**을 받아 모드를
/// 명령 dispatch 가 아니라 **127.0.0.1:allowlist-port 로의 양방향 바이트 프록시**로 전환한다.
///
/// 명령 dispatch 와 터널은 **별개의 명시 모드**다(blur 0) — 이 함수는 dispatch 콜백을 받지 않고,
/// serve_connection 은 allowlist 를 받지 않는다. 호출자(glue)가 어느 serve 를 쓸지 명시 선택한다.
///
/// 흐름(전부 fail-closed):
///   1. announce + KK 핸드셰이크 — serve_connection 과 **동일**(미페어링 ⇒ 채널 0 ⇒ 프록시 0).
///   2. SecureSession::establish — peer 기기 신원을 채널에 결속.
///   3. 첫 frame(ciphertext) 읽기 → session.decrypt_first_frame → RequestFrame(터널 인가 페이로드).
///   4. tunnel::authorize_tunnel(assertion, sig, request, peer_id, registry, ctx, allowlist):
///      브리지 auth 게이트(auth.rs verify 재사용) + 포트 ∈ allowlist. Denied ⇒ **connect 0**,
///      거부 frame 회신 후 종료(어떤 TcpStream 도 안 열린다 — SSRF 0).
///   5. Granted ⇒ "tunnel-ok" ack 회신 → tunnel::connect_local(127.0.0.1:port) → tunnel::proxy
///      (채널 ↔ 로컬 양방향, 평문은 와이어에 안 나감). 로컬 미기동 ⇒ clean 에러 frame 후 종료(패닉 0).
///
/// **allowlist 는 데스크톱 소유**: `&PortAllowlist`(불변)로만 들어온다 — 폰 frame 이 닿는 mutate
/// 경로가 없다(anti-escalation). **SSRF 0**: connect 는 connect_local(고정 LOCALHOST)만, allowlist
/// 통과 포트만. **DNS rebinding 무력**: 타겟이 Host 헤더가 아니라 봉인 포트라 rebinding 부재.
pub async fn serve_tunnel<S, NowF>(
    mut stream: S,
    local: &StaticKeypair,
    noise_registry: &PinnedPeerRegistry,
    auth: &SharedAuth,
    allowlist: &crate::remote::tunnel::PortAllowlist,
    mut now_fn: NowF,
) -> Result<(), ServeError>
where
    S: AsyncRead + AsyncWrite + Unpin,
    NowF: FnMut() -> u64,
{
    use crate::remote::tunnel::{authorize_tunnel, connect_local, proxy, TunnelDecision};

    // 1. announce + 2. KK 핸드셰이크 — serve_connection 과 동일(fail-closed, 미페어링 ⇒ 채널 0).
    let id_bytes = match read_framed(&mut stream).await? {
        Some(b) => b,
        None => return Ok(()),
    };
    if id_bytes.len() > MAX_DEVICE_ID_LEN {
        return Err(ServeError::BadDeviceId);
    }
    let device_id = String::from_utf8(id_bytes).map_err(|_| ServeError::BadDeviceId)?;
    let mut handshake =
        Handshake::respond(local, noise_registry, &device_id).map_err(ServeError::Handshake)?;
    let m1 = match read_framed(&mut stream).await? {
        Some(b) => b,
        None => return Ok(()),
    };
    handshake.read_message(&m1).map_err(ServeError::Handshake)?;
    let m2 = handshake.write_message().map_err(ServeError::Handshake)?;
    write_framed(&mut stream, &m2).await?;
    let mut session =
        SecureSession::establish(handshake, &device_id).map_err(ServeError::Handshake)?;

    // 3. 터널-인가 첫 frame — ciphertext 읽기 → 복호·파싱. 없으면 정상 종료(빈 연결).
    let first_ct = match read_framed(&mut stream).await? {
        Some(b) => b,
        None => return Ok(()),
    };
    let frame = match session.decrypt_first_frame(&first_ct) {
        Some(f) => f,
        // 복호/파싱 실패 — fail-closed(프록시 0). 채널로 거부 ack 회신 후 종료.
        None => {
            let nak = session_encrypt_tag(&mut session, TUNNEL_NAK)?;
            let _ = write_framed(&mut stream, &nak).await;
            return Ok(());
        }
    };

    // 4. authorize — 브리지 auth 게이트(auth.rs verify 재사용) + allowlist(SSRF 0, connect 이전).
    let ctx = VerifyCtx { now: now_fn() };
    let peer_id = session.peer_device_id().to_string();
    let grant = {
        let mut reg = auth.lock();
        authorize_tunnel(
            &frame.assertion,
            &frame.signature,
            &frame.request,
            &peer_id,
            &mut reg,
            ctx,
            allowlist,
        )
    };
    let grant = match grant {
        TunnelDecision::Granted(g) => g,
        // 거부(미페어링/위조/scope/allowlist 밖) — **connect 0**. 채널로 거부 ack 회신 후 종료.
        TunnelDecision::Denied(_reason) => {
            let nak = session_encrypt_tag(&mut session, TUNNEL_NAK)?;
            let _ = write_framed(&mut stream, &nak).await;
            return Ok(());
        }
    };

    // 5. Granted — **loopback-only connect 를 ack 이전에 시도**(127.0.0.1:allowlist-port). 미기동 ⇒
    //    NAK 회신 후 종료(패닉 0). connect 성공해야만 ACK 를 보낸다 — 클라이언트가 ACK 를 받으면
    //    프록시가 진짜 시작됐다는 뜻이다(미기동에 ACK 0 — 클라이언트가 NAK 로 깔끔히 거부).
    let local_stream = match connect_local(&grant).await {
        Ok(s) => s,
        Err(_e) => {
            let nak = session_encrypt_tag(&mut session, TUNNEL_NAK)?;
            let _ = write_framed(&mut stream, &nak).await;
            return Ok(());
        }
    };

    // connect 성공 — "tunnel-ok" ack 회신 → 양방향 프록시.
    let ack = session_encrypt_tag(&mut session, TUNNEL_ACK)?;
    write_framed(&mut stream, &ack).await?;

    // 채널을 raw 파이프로 환원(명령 모드 떠남) + 스트림을 read/write 절반으로 split → 양방향 프록시.
    let channel = session.into_channel();
    let (rd, wr) = tokio::io::split(stream);
    // 프록시 종료(어느 한쪽 닫힘)는 정상 — Io 에러는 ServeError 로 환원하지 않고 Ok 로 닫는다.
    let _ = proxy(rd, wr, channel, local_stream).await;
    Ok(())
}

/// 터널 핸드셰이크 ack 와이어 태그 — ACK(0x01)=인가됨/프록시 시작, NAK(0x00)=거부/에러.
/// 채널로 암호화되어 나간다(릴레이 zero-knowledge — 결과조차 평문 0). 클라이언트가 이 1바이트로
/// "프록시 시작" vs "거부"를 안다(이후부터 raw 바이트 파이프).
const TUNNEL_ACK: u8 = 0x01;
const TUNNEL_NAK: u8 = 0x00;

/// 1바이트 태그를 세션 채널로 암호화한다(터널 ack). encrypt 실패는 정상 경로 도달 0(빈 벡터 회피
/// 위해 FrameTooLarge 로 환원하지 않고, 성립된 채널은 1바이트 암호화에 항상 성공).
fn session_encrypt_tag(session: &mut SecureSession, tag: u8) -> Result<Vec<u8>, ServeError> {
    Ok(session.encrypt_tag(tag))
}

#[cfg(test)]
mod tests;
