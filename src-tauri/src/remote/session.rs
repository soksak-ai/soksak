// remote::session — 두 하한선(floor)을 "보안 세션" 게이트로 합성(RULE 0 defense-in-depth).
//
// 이 모듈은 "기기 신원에 결속된 상호인증 암호 세션"이라는 generic capability 다(폰 전용
// 아님 — RULE 8 무강결합). 두 독립 floor 를 **엮는다(interlock)**, 둘을 고치지 않는다(additive):
//   - noise(remote::noise): 채널 인증 + 기밀성/PFS. 어느 기기의 암호 파이프인가.
//   - auth(remote::auth):   액션별 인가. 각 요청의 scope/freshness/단일사용.
//
// 두 게이트는 **독립**이며 둘 다 통과해야 dispatch 에 닿는다(RULE 0 "한 층이 뚫려도 전체가
// 안 무너지게"):
//   게이트 1(채널): 미페어링 peer 는 NoiseChannel 자체가 안 생긴다(noise floor) ⇒ 어떤
//                   frame 도 복호되지 않는다 ⇒ auth 층에 **도달조차 못 한다**.
//   게이트 2(인가): 완벽히 유효한 채널이라도 그 위의 frame 은 in-scope 유효 assertion 을
//                   실어야 한다. 채널 성립 ≠ 인가. 둘 중 하나만 뚫려도 접근 0.
//
// 기기-신원 결속(cross-device assertion smuggling 0): 채널이 인증한 기기(handshake peer)와
// assertion 의 device_id 가 **일치해야** 한다. 페어링이 device_id 를 그 X25519 static 키와
// Ed25519 신원키 **양쪽**에 묶으므로, 채널 peer 와 assertion 이 한 기기로 교차검증된다.
// 페어링된 기기 A 가 B 의 assertion 을 A 자기 채널로 재생해도 거부된다.
//
// 엮인 dispatch 게이트(RULE 6, 우회 0): route() 디스패치는 Granted 결정을 필수 입력으로만
// 일어난다. dispatch 를 주입 콜백(`Fn(&Request) -> Response`)으로 모델링해 live Tauri
// AppHandle 없이·ipc.rs 손대지 않고 단위테스트 가능하게 한다. dispatch 콜백은 Grant 없이는
// 구조적으로 도달 불가다 — 단일 `if` 가 아니라, auth.rs 의 AuthorizedAction(= Grant +
// 매칭 confirm 토큰에서만 구성)을 dispatch 의 필수 입력으로 요구한다. destructive Grant 가
// RequiresDesktopConfirm 를 실으면 데스크톱 confirm 토큰 없이는 dispatch 가 호출되지 않는다
// (폰은 토큰을 위조 불가 — auth.rs 의 DesktopConfirmToken 생성자 경계).
//
// 어떤 TcpListener·ipc·route() 변경도 하지 않는다 — 세션 합성 코어 + 테스트만. transport
// 배선(iroh/Go-relay/cloudflared 위에 얹기)은 다음 단계다. 공개 표면은 아직 transport 가
// 호출하지 않으므로 일부 미사용 — dead_code 허용. 테스트(`mod tests`)가 전 표면을 행위로 강제.
#![allow(dead_code)]

use crate::remote::auth::{
    AuthDecision, AuthorizeError, AuthorizedAction, CapabilityAssertion, DenyReason,
    DesktopConfirmToken, DeviceRegistry, Grant, Scope, VerifyCtx,
};
use crate::remote::noise::{Handshake, NoiseChannel, NoiseError, X25519_KEY_LEN};

// ===========================================================================
// 0. 와이어 frame — {assertion, signature, request} 의 캐노니컬 직렬화
// ===========================================================================

/// 길이-프리픽스 캐노니컬 코덱의 frame 버전 태그. 형식 진화 시 거부 표면(다운그레이드 0).
const FRAME_VERSION: u8 = 1;

/// 평문 frame: 한 원격 요청. NoiseChannel 안에서만 존재하며(평문 경로 0), 복호 후 파싱된다.
///
/// - assertion + signature: auth floor 가 검증할 capability 증명(액션 인가).
/// - request: dispatch 콜백에 넘길 불투명 바이트(명령 페이로드). 세션은 내용을 해석하지 않는다
///   (RULE 8 무강결합 — request 는 generic 바이트, 상위 layer 가 의미 부여).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestFrame {
    /// 액션 인가 주장(auth floor 가 핀닝 키로 검증).
    pub assertion: CapabilityAssertion,
    /// 분리된 Ed25519 서명(64B). auth floor 의 verify_strict 입력.
    pub signature: Vec<u8>,
    /// 명령 페이로드(불투명). dispatch 콜백이 해석.
    pub request: Vec<u8>,
}

impl RequestFrame {
    /// 캐노니컬 바이트 — 고정 필드 순서 + 길이 프리픽스(모호성 0). 발신/수신이 정확히 동일
    /// 바이트를 재구성한다. assertion 은 auth floor 의 canonical_bytes 와 같은 순서를 따른다.
    ///
    /// 레이아웃(전부 little-endian 길이 프리픽스):
    ///   ver(1) | len(device_id) device_id | scope(1) | nonce(32) | issued_at(8) | exp(8)
    ///         | len(signature) signature | len(request) request
    pub fn encode(&self) -> Vec<u8> {
        let a = &self.assertion;
        let id = a.device_id.as_bytes();
        let mut out = Vec::with_capacity(64 + id.len() + self.signature.len() + self.request.len());
        out.push(FRAME_VERSION);
        out.extend_from_slice(&(id.len() as u64).to_le_bytes());
        out.extend_from_slice(id);
        out.push(scope_tag(a.scope));
        out.extend_from_slice(&a.nonce);
        out.extend_from_slice(&a.issued_at.to_le_bytes());
        out.extend_from_slice(&a.exp.to_le_bytes());
        out.extend_from_slice(&(self.signature.len() as u64).to_le_bytes());
        out.extend_from_slice(&self.signature);
        out.extend_from_slice(&(self.request.len() as u64).to_le_bytes());
        out.extend_from_slice(&self.request);
        out
    }

    /// 캐노니컬 바이트 → frame. 형식 불량/버전 불일치/길이 초과 ⇒ None(거부 표면).
    /// 파서는 절대 패닉하지 않는다(malformed 패킷 graceful 거부 — DoS 0).
    pub fn decode(bytes: &[u8]) -> Option<RequestFrame> {
        let mut r = Reader::new(bytes);
        if r.u8()? != FRAME_VERSION {
            return None; // 버전 불일치 = 다운그레이드/형식불량 거부.
        }
        let id_len = r.u64()? as usize;
        let device_id = std::str::from_utf8(r.take(id_len)?).ok()?.to_string();
        let scope = scope_from_tag(r.u8()?)?;
        let nonce: [u8; 32] = r.take(32)?.try_into().ok()?;
        let issued_at = r.u64()?;
        let exp = r.u64()?;
        let sig_len = r.u64()? as usize;
        let signature = r.take(sig_len)?.to_vec();
        let req_len = r.u64()? as usize;
        let request = r.take(req_len)?.to_vec();
        if !r.is_empty() {
            return None; // 잉여 바이트 = 형식불량 거부(엄격).
        }
        Some(RequestFrame {
            assertion: CapabilityAssertion {
                device_id,
                scope,
                nonce,
                issued_at,
                exp,
            },
            signature,
            request,
        })
    }
}

/// scope → 1바이트 태그(와이어 결정성). auth floor 의 내부 태그와 동일 매핑.
fn scope_tag(scope: Scope) -> u8 {
    match scope {
        Scope::ReadOnly => 0,
        Scope::Write => 1,
        Scope::Destructive => 2,
    }
}

/// 1바이트 태그 → scope. 미지 태그 ⇒ None(형식불량 거부).
fn scope_from_tag(tag: u8) -> Option<Scope> {
    match tag {
        0 => Some(Scope::ReadOnly),
        1 => Some(Scope::Write),
        2 => Some(Scope::Destructive),
        _ => None,
    }
}

/// 패닉 없는 경계검사 리더(malformed 입력 graceful 거부).
struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0 }
    }
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.pos.checked_add(n)?;
        if end > self.buf.len() {
            return None;
        }
        let s = &self.buf[self.pos..end];
        self.pos = end;
        Some(s)
    }
    fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }
    fn u64(&mut self) -> Option<u64> {
        let b: [u8; 8] = self.take(8)?.try_into().ok()?;
        Some(u64::from_le_bytes(b))
    }
    fn is_empty(&self) -> bool {
        self.pos == self.buf.len()
    }
}

// ===========================================================================
// 1. 응답 frame — dispatch 결과 또는 typed 에러(평문, 채널로 암호화되어 나감)
// ===========================================================================

/// 세션이 frame 처리 결과로 암호화해 돌려보내는 평문 응답. dispatch 가 호출됐으면 Ok(바이트),
/// 게이트에서 막혔으면 typed Err(사유) — **에러여도 dispatch 는 호출되지 않았다**.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionResponse {
    /// dispatch 콜백이 1회 호출되어 산출한 응답 바이트.
    Ok(Vec<u8>),
    /// 게이트 거부 — dispatch 미호출. 사유 동반(감사).
    Denied(SessionDenied),
}

/// frame 이 dispatch 에 닿지 못한 사유. 전부 fail-closed(접근 0).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionDenied {
    /// 채널 복호 실패(변조/재생/순서뒤바뀜 ciphertext) — auth 층 도달 0.
    Decrypt,
    /// 복호는 됐으나 frame 형식 불량(파싱 실패).
    MalformedFrame,
    /// frame 의 assertion.device_id 가 채널이 인증한 peer 기기와 불일치
    /// (cross-device assertion smuggling 차단).
    DeviceMismatch,
    /// auth floor 가 거부(미페어링/위조/만료/재생/scope 상승/revoked) — 사유 전달.
    Unauthorized(DenyReason),
    /// destructive Grant 인데 데스크톱 confirm 토큰 미제공/불일치 — 폰이 토큰 위조 불가.
    DesktopConfirm(AuthorizeError),
}

impl SessionResponse {
    /// dispatch 가 실제로 호출됐는가(= Ok). 테스트가 "dispatch 미호출"을 단언하는 데 쓴다.
    pub fn is_ok(&self) -> bool {
        matches!(self, SessionResponse::Ok(_))
    }

    pub fn denied(&self) -> Option<&SessionDenied> {
        match self {
            SessionResponse::Denied(d) => Some(d),
            SessionResponse::Ok(_) => None,
        }
    }

    /// 응답 바이트(Ok 일 때만).
    pub fn ok_bytes(&self) -> Option<&[u8]> {
        match self {
            SessionResponse::Ok(b) => Some(b),
            SessionResponse::Denied(_) => None,
        }
    }
}

// ===========================================================================
// 1b. 파킹 결과 — begin_frame 이 dispatch 시점을 분기(비파괴 즉시 vs destructive 파킹).
// ===========================================================================

/// begin_frame 의 결과 — 한 frame 이 즉시 종결되는가, 데스크톱 confirm 을 기다리는가.
pub enum FrameOutcome {
    /// 종결됨(암호화된 응답 바이트). 비파괴 Ok(dispatch 완료) 또는 어떤 사유의 거부.
    /// 호출자는 이 바이트를 그대로 회신한다 — 파킹/대기 0.
    Terminal(Vec<u8>),
    /// destructive grant — dispatch 미실행. 호출자가 데스크톱 결정을 await 한 뒤
    /// finish_confirmed/finish_denied 로 종결한다(데스크톱 결정 전엔 실행 0).
    AwaitConfirm(PendingDestructive),
}

impl FrameOutcome {
    /// 종결 바이트면 Some(테스트 편의). AwaitConfirm 이면 None.
    pub fn terminal_bytes(&self) -> Option<&[u8]> {
        match self {
            FrameOutcome::Terminal(b) => Some(b),
            FrameOutcome::AwaitConfirm(_) => None,
        }
    }

    /// 데스크톱 confirm 대기 상태인가(테스트 편의).
    pub fn is_await_confirm(&self) -> bool {
        matches!(self, FrameOutcome::AwaitConfirm(_))
    }
}

/// 데스크톱 결정을 기다리는 봉인된 destructive 액션. **봉인된 Grant 를 들고 있다** — dispatch
/// 는 데스크톱 APPROVE(finish_confirmed)에서만, 어댑터-구성 토큰과 함께 일어난다. 이 타입의
/// 필드는 private — 외부가 grant 를 빼내 임의 dispatch 할 수 없다(엮인 게이트 유지).
pub struct PendingDestructive {
    /// auth floor 가 봉인한 Grant(destructive — DesktopConfirmRequired 를 싣는다). nonce 는
    /// begin_frame 에서 이미 소비됨 — 재-verify 없이 이 Grant 만으로 종결한다.
    grant: Grant,
    /// dispatch 로 넘길 불투명 request 바이트(원래 frame 의 페이로드).
    request: Vec<u8>,
    /// 사람이 읽을 명령 요약(데스크톱 모달 표시 — PendingConfirms 에 함께 등록).
    command: String,
}

impl PendingDestructive {
    /// 어느 기기의 요청인가(데스크톱 모달/감사). Grant 가 봉인한 device_id.
    pub fn device_id(&self) -> &str {
        self.grant.device_id()
    }

    /// 사람이 읽을 명령 요약(데스크톱 모달 표시).
    pub fn command(&self) -> &str {
        &self.command
    }

    /// 이 destructive 가 결속한 nonce(감사). Grant 의 DesktopConfirmRequired 에서.
    pub fn bound_nonce(&self) -> Option<[u8; 32]> {
        self.grant.desktop_confirm().map(|r| r.bound_nonce())
    }
}

/// request 바이트 → 사람이 읽을 명령 요약(데스크톱 모달 표시용). request 는 보통 JSON
/// `{"method":"panel.close",...}` 또는 raw 명령명. method 가 있으면 그걸, 없으면 앞부분을
/// UTF-8 lossy 로 자른다(표시 전용 — dispatch 로 가는 raw 바이트는 그대로 보존).
fn summarize_command(request: &[u8]) -> String {
    // JSON method 추출 시도(소켓 JSON-RPC 모양).
    if let Ok(v) = serde_json::from_slice::<serde_json::Value>(request) {
        if let Some(m) = v.get("method").and_then(|m| m.as_str()) {
            if !m.is_empty() {
                return m.to_string();
            }
        }
    }
    // fallback — 앞 64바이트를 lossy 표시(긴 페이로드 truncate).
    let head = &request[..request.len().min(64)];
    String::from_utf8_lossy(head).into_owned()
}

// ===========================================================================
// 2. SecureSession — 성립된 채널 + 인증된 peer 기기 신원의 결속
// ===========================================================================

/// 합성된 보안 세션: 한 NoiseChannel(게이트 1 산물) + 그 채널이 인증한 peer 기기 id.
///
/// **유일 생성 경로 = SecureSession::establish**(완료된 핸드셰이크에서). 평문/미인증
/// 생성자가 없으므로, SecureSession 이 존재한다는 사실 자체가 채널 게이트 통과의 증거다
/// (noise floor 의 NoiseChannel 불변식을 그대로 상속 — 미페어링 peer 는 여기 도달 불가).
///
/// `peer_device_id` 는 handshake 시 사용한 핀닝 peer 의 id 다 — 즉 **채널이 인증한 기기**.
/// handle_frame 은 매 frame 의 assertion.device_id 를 이 값과 교차검증한다(기기-신원 결속).
pub struct SecureSession {
    channel: NoiseChannel,
    /// 채널이 인증한 peer 기기 — assertion.device_id 가 이것과 같아야 한다.
    peer_device_id: String,
    /// handshake 가 제시한 상대 static 공개키(KK 라 핀닝값과 동일). 감사/단언용.
    peer_static: [u8; X25519_KEY_LEN],
}

impl SecureSession {
    /// 완료된 핸드셰이크를 보안 세션으로 봉인한다. 채널 게이트(noise floor)를 통과한
    /// Handshake 만 받는다 — 미완이면 into_channel 이 Err 라 세션도 미성립.
    ///
    /// `peer_device_id` = 이 핸드셰이크의 상대(핀닝 peer)의 id. 호출자(transport)가 어느
    /// 핀닝 기기와 핸드셰이크했는지 알며, 그 id 를 세션에 봉인한다 → 이후 모든 frame 의
    /// assertion.device_id 가 이 기기와 교차검증된다(cross-device smuggling 차단).
    ///
    /// fail-closed: 미완 핸드셰이크 ⇒ NoiseError ⇒ 세션 미생성(채널 없이 세션 0).
    pub fn establish(handshake: Handshake, peer_device_id: &str) -> Result<SecureSession, NoiseError> {
        // 상대 static 키 캡처(KK: 핀닝값과 동일해야 정상). 핸드셰이크 미완이면 None 일 수
        // 있으나, into_channel 이 그 경우 Err 라 세션은 어차피 미성립.
        let peer_static = handshake.remote_static().unwrap_or([0u8; X25519_KEY_LEN]);
        let channel = handshake.into_channel()?; // 미완 ⇒ HandshakeIncomplete.
        Ok(SecureSession {
            channel,
            peer_device_id: peer_device_id.to_string(),
            peer_static,
        })
    }

    /// 이 세션이 인증한 peer 기기 id(채널 게이트가 확립한 기기 신원).
    pub fn peer_device_id(&self) -> &str {
        &self.peer_device_id
    }

    /// 핸드셰이크가 제시한 상대 static 공개키(감사/단언).
    pub fn peer_static(&self) -> [u8; X25519_KEY_LEN] {
        self.peer_static
    }

    // -----------------------------------------------------------------------
    // 터널 모드 진입 — 첫 frame 을 복호·파싱하고, 채널을 raw 바이트 파이프로 넘긴다(additive).
    //
    // 명령 dispatch(handle_frame/begin_frame)와 **별개의 명시 모드**다(blur 0). serve_tunnel 이
    // 핸드셰이크 후 첫 frame 을 이 메서드로 복호·파싱해 RequestFrame(터널 인가 페이로드)을 얻고,
    // 그 다음 into_channel 로 NoiseChannel 을 꺼내 remote::tunnel::proxy 에 넘긴다. 채널 게이트
    // (game 1)는 이미 establish 가 통과시켰으므로 — 첫 frame 복호 = 채널이 진짜라는 추가 증거.
    // -----------------------------------------------------------------------

    /// 터널 첫 frame(ciphertext)을 복호·파싱해 RequestFrame 으로 환원한다. **명령 dispatch 와
    /// 무관** — 인가(auth verify)는 호출자(tunnel::authorize_tunnel)가 한다(채널 ≠ 인가 분리 유지).
    /// 복호 실패(변조/재생/미페어링 부재) ⇒ None(fail-closed, garbage 평문 0). 형식 불량 ⇒ None.
    pub fn decrypt_first_frame(&mut self, ciphertext: &[u8]) -> Option<RequestFrame> {
        let plaintext = self.channel.decrypt(ciphertext).ok()?;
        RequestFrame::decode(&plaintext)
    }

    /// 세션을 raw NoiseChannel 로 환원한다(터널 proxy 단계로 채널 소유 이전). 명령 dispatch 모드를
    /// 떠나 바이트-파이프 모드로 전환하는 단방향 소비 — 이후 이 채널은 tunnel::proxy 의
    /// encrypt/decrypt(릴레이 zero-knowledge)에만 쓰인다. peer_device_id 결속은 이미 검증에 사용됨.
    pub fn into_channel(self) -> NoiseChannel {
        self.channel
    }

    /// 1바이트 터널 ack 태그를 채널로 암호화한다(릴레이 zero-knowledge — 결과조차 평문 0). 성립된
    /// 채널은 1바이트 암호화에 항상 성공하나, 만일 실패하면 빈 벡터(평문 누출보다 무응답이 안전).
    pub fn encrypt_tag(&mut self, tag: u8) -> Vec<u8> {
        self.channel.encrypt(&[tag]).unwrap_or_default()
    }

    // -----------------------------------------------------------------------
    // handle_frame — 두 게이트를 엮은 단일 처리점(RULE 6 단일 실행점).
    // -----------------------------------------------------------------------

    /// 암호 frame 1개를 처리한다. 게이트 순서(둘 다 통과해야 dispatch):
    ///
    ///   (게이트 1, 채널) ciphertext → NoiseChannel::decrypt. 실패(변조/재생/미페어링 peer 의
    ///        부재 등) ⇒ Decrypt. **auth 층에 도달조차 안 한다.** 평문 frame 경로는 없다 —
    ///        오직 채널 복호만이 평문을 낸다(채널 게이트 우회 불가).
    ///   파싱     평문 → RequestFrame::decode. 형식불량 ⇒ MalformedFrame.
    ///   기기결속 frame.assertion.device_id == self.peer_device_id 교차검증. 불일치 ⇒
    ///        DeviceMismatch(A 채널로 B assertion 재생 차단).
    ///   (게이트 2, 인가) DeviceRegistry::verify(assertion, sig, ctx). Denied ⇒ Unauthorized.
    ///        채널이 완벽해도 in-scope 유효 assertion 없으면 여기서 막힌다(채널 ≠ 인가).
    ///   confirm  destructive Grant 면 AuthorizedAction::authorize 가 매칭 confirm 토큰을
    ///        요구한다. 토큰 미제공/불일치 ⇒ DesktopConfirm. 폰은 토큰 위조 불가.
    ///   dispatch **AuthorizedAction 이 구성된 뒤에만** dispatch 콜백을 1회 호출한다. 콜백
    ///        시그니처가 AuthorizedAction 을 요구하므로(아래 dispatch_authorized), Grant 없이
    ///        dispatch 에 닿을 구조적 경로가 없다(단일 if 아님).
    ///   응답     Ok(응답) 또는 typed Denied 를 **둘 다 채널로 암호화**해 돌려준다.
    ///
    /// `&mut self`: 채널 nonce/counter 전진(decrypt/encrypt) + registry nonce 소비를 위해.
    /// registry 는 호출자가 소유(여러 세션이 한 권위를 공유 — 단일 진실).
    pub fn handle_frame<F>(
        &mut self,
        ciphertext: &[u8],
        registry: &mut DeviceRegistry,
        ctx: VerifyCtx,
        desktop_token: Option<&DesktopConfirmToken>,
        dispatch: F,
    ) -> Vec<u8>
    where
        F: FnOnce(&AuthorizedAction, &[u8]) -> Vec<u8>,
    {
        let response = self.process(ciphertext, registry, ctx, desktop_token, dispatch);
        // Ok/Denied 모두 채널로 암호화해 반환(릴레이는 결과조차 평문으로 못 봄).
        self.encrypt_response(&response)
    }

    /// 내부 처리 — 게이트 흐름을 SessionResponse 로 환원(암호화 전 단계). 테스트가 평문
    /// 결과(dispatch 호출 여부·사유)를 직접 단언할 수 있게 분리한다.
    ///
    /// dispatch 콜백은 **AuthorizedAction 을 필수 인자로** 받는다(`FnOnce(&AuthorizedAction,
    /// &[u8]) -> Vec<u8>`). AuthorizedAction 은 auth floor 에서 Grant(+ destructive 면 매칭
    /// confirm 토큰) 로만 구성된다 → Grant 없이는 콜백을 호출할 인자 자체를 만들 수 없다.
    /// 이것이 "엮인 게이트": dispatch 가능성이 AuthorizedAction 의 존재에 묶여 있다.
    fn process<F>(
        &mut self,
        ciphertext: &[u8],
        registry: &mut DeviceRegistry,
        ctx: VerifyCtx,
        desktop_token: Option<&DesktopConfirmToken>,
        dispatch: F,
    ) -> SessionResponse
    where
        F: FnOnce(&AuthorizedAction, &[u8]) -> Vec<u8>,
    {
        // (게이트 1, 채널) 복호. 미페어링 peer 는 애초에 채널이 없어 여기 도달 불가;
        // 도달한 frame 이라도 변조/재생이면 AEAD 가 거부 ⇒ auth 층 도달 0.
        let plaintext = match self.channel.decrypt(ciphertext) {
            Ok(pt) => pt,
            Err(_) => return SessionResponse::Denied(SessionDenied::Decrypt),
        };

        // 파싱 — 복호된 평문만 파싱된다(평문 frame 직통 경로 없음).
        let frame = match RequestFrame::decode(&plaintext) {
            Some(f) => f,
            None => return SessionResponse::Denied(SessionDenied::MalformedFrame),
        };

        // 기기-신원 결속 — 채널이 인증한 기기와 assertion 의 기기가 같아야 한다.
        // A 의 채널로 B 의 (유효 서명된) assertion 을 재생해도 여기서 거부(smuggling 0).
        if frame.assertion.device_id != self.peer_device_id {
            return SessionResponse::Denied(SessionDenied::DeviceMismatch);
        }

        // (게이트 2, 인가) auth floor 검증. 채널이 완벽해도 in-scope 유효 assertion 필수.
        let grant = match registry.verify(&frame.assertion, &frame.signature, ctx) {
            AuthDecision::Granted(g) => g,
            AuthDecision::Denied(reason) => {
                return SessionResponse::Denied(SessionDenied::Unauthorized(reason));
            }
        };

        // confirm — destructive Grant 는 매칭 데스크톱 confirm 토큰을 요구한다. AuthorizedAction
        // 구성이 성공해야만 dispatch 의 필수 인자가 생긴다(엮인 게이트). 토큰 미제공/불일치 ⇒
        // dispatch 의 인자가 **만들어지지 않아** 콜백 호출 자체가 불가능 ⇒ DesktopConfirm.
        let action = match AuthorizedAction::authorize(&grant, desktop_token) {
            Ok(a) => a,
            Err(e) => return SessionResponse::Denied(SessionDenied::DesktopConfirm(e)),
        };

        // dispatch — AuthorizedAction(= Grant 의 봉인 산물)을 필수 입력으로 1회 호출.
        // 이 줄 외에 dispatch 를 호출하는 경로가 없고, 호출하려면 위 모든 게이트를 통과한
        // `action` 이 있어야 한다 ⇒ Grant 없이 dispatch 도달 불가(구조적 no-bypass).
        let out = dispatch(&action, &frame.request);
        SessionResponse::Ok(out)
    }

    // -----------------------------------------------------------------------
    // 파킹 API(additive) — destructive 는 데스크톱 사람 결정을 await 한 뒤에만 dispatch.
    //
    // serve_connection 은 매 frame 을 동기 락 안에서 처리하지만, 데스크톱 confirm 은 **비동기**
    // 사람 결정을 기다려야 한다(oneshot await). 그래서 한 frame 처리를 둘로 쪼갠다:
    //   1) begin_frame — 복호+파싱+기기결속+인가(게이트 1·2, nonce **단 1회** 소비)를 동기로
    //      끝낸다. 비파괴(read-only/write)거나 어떤 사유로든 거부면 **즉시 종결**(암호화된 응답).
    //      destructive grant 면 dispatch 를 **미루고** PendingDestructive(봉인된 Grant 보유)를
    //      돌려준다 — 아직 토큰도 dispatch 도 없다.
    //   2) 데스크톱 결정 후:
    //      - finish_confirmed(pending, dispatch) — 어댑터가 (device, bound_nonce) 토큰을 **스스로**
    //        만들어(폰은 못 만든다 — auth.rs private 생성자) 같은 Grant 를 authorize+dispatch.
    //      - finish_denied(pending) — dispatch 0, 암호화된 "denied".
    //
    // nonce 는 begin_frame 에서 한 번만 소비된다 — 승인 후 재-복호/재-verify 가 없으므로 재생
    // 판정과 충돌하지 않는다(꼼수 없는 단일 패스).
    // -----------------------------------------------------------------------

    /// 한 frame 의 게이트 1·2 를 동기로 처리하고, dispatch 시점을 분기한다.
    ///
    /// 반환:
    ///   - FrameOutcome::Terminal(ciphertext) — 비파괴 Ok(이미 dispatch 됨) 또는 거부. 호출자는
    ///     이 바이트를 그대로 회신한다(파킹 불요).
    ///   - FrameOutcome::AwaitConfirm(pending) — destructive grant. dispatch 는 아직 0. 호출자가
    ///     데스크톱 결정을 await 한 뒤 finish_confirmed/finish_denied 로 종결한다.
    ///
    /// `dispatch` 는 비파괴 경로에서만 호출된다(destructive 는 finish_confirmed 가 호출). 즉
    /// dispatch 가능성은 여전히 AuthorizedAction 에 묶여 있다(엮인 게이트 불변).
    pub fn begin_frame<F>(
        &mut self,
        ciphertext: &[u8],
        registry: &mut DeviceRegistry,
        ctx: VerifyCtx,
        dispatch: F,
    ) -> FrameOutcome
    where
        F: FnOnce(&AuthorizedAction, &[u8]) -> Vec<u8>,
    {
        // (게이트 1, 채널) 복호 — 변조/재생/미페어링 ⇒ Decrypt. nonce 미소비.
        let plaintext = match self.channel.decrypt(ciphertext) {
            Ok(pt) => pt,
            Err(_) => return self.terminal(SessionResponse::Denied(SessionDenied::Decrypt)),
        };
        // 파싱.
        let frame = match RequestFrame::decode(&plaintext) {
            Some(f) => f,
            None => return self.terminal(SessionResponse::Denied(SessionDenied::MalformedFrame)),
        };
        // 기기-신원 결속.
        if frame.assertion.device_id != self.peer_device_id {
            return self.terminal(SessionResponse::Denied(SessionDenied::DeviceMismatch));
        }
        // (게이트 2, 인가) — 여기서 nonce 가 **단 1회** 소비된다(Granted 일 때).
        let grant = match registry.verify(&frame.assertion, &frame.signature, ctx) {
            AuthDecision::Granted(g) => g,
            AuthDecision::Denied(reason) => {
                return self.terminal(SessionResponse::Denied(SessionDenied::Unauthorized(reason)));
            }
        };

        // 비파괴 vs destructive 분기 — destructive 는 Grant 가 DesktopConfirmRequired 를 싣는다.
        if grant.requires_desktop_confirm() {
            // dispatch 를 미룬다 — 봉인된 Grant + request + 명령 요약을 PendingDestructive 로 들고
            // 나간다. 아직 토큰도 dispatch 도 없다(데스크톱 결정 전엔 실행 0 — anti-escalation).
            let command = summarize_command(&frame.request);
            FrameOutcome::AwaitConfirm(PendingDestructive {
                grant,
                request: frame.request,
                command,
            })
        } else {
            // 비파괴 — confirm 불요. 즉시 authorize(None)+dispatch 하고 종결.
            let action = match AuthorizedAction::authorize(&grant, None) {
                Ok(a) => a,
                // read-only/write 는 None 토큰으로 항상 Ok — 이 분기는 실질적으로 도달 안 함
                // (방어적 fail-closed: 혹시라도 confirm 요구가 새어 들어오면 거부).
                Err(e) => {
                    return self.terminal(SessionResponse::Denied(SessionDenied::DesktopConfirm(e)));
                }
            };
            let out = dispatch(&action, &frame.request);
            self.terminal(SessionResponse::Ok(out))
        }
    }

    /// 데스크톱 APPROVE 후 — 파킹된 destructive grant 를 종결한다. **어댑터가 토큰을 직접 만든다**:
    /// Grant 의 DesktopConfirmRequired 에서 정확한 (device, bound_nonce) 를 읽어 그 결속의
    /// DesktopConfirmToken 을 auth.rs 의 데스크톱-권위 생성자로 만든다(폰은 이 생성자에 도달 불가).
    /// 그 토큰으로 같은 Grant 를 authorize → dispatch 1회 → 암호화된 결과.
    ///
    /// 토큰이 Grant 의 (device, nonce) 와 정확히 일치하므로 authorize 는 성공한다. 다른 Grant
    /// 의 토큰을 끼워넣을 수 없다(이 함수는 self 의 parked grant 에서만 토큰을 만든다 — 재사용 0).
    pub fn finish_confirmed<F>(&mut self, pending: PendingDestructive, dispatch: F) -> Vec<u8>
    where
        F: FnOnce(&AuthorizedAction, &[u8]) -> Vec<u8>,
    {
        let required = match pending.grant.desktop_confirm() {
            Some(r) => r,
            // 파킹된 것은 destructive 만이므로 항상 Some. 방어적으로 None 이면 거부(dispatch 0).
            None => {
                return self.terminal_bytes(SessionResponse::Denied(SessionDenied::DesktopConfirm(
                    AuthorizeError::DesktopConfirmRequired,
                )))
            }
        };
        // 어댑터-구성 토큰 — 정확히 이 Grant 의 (device, bound_nonce). 폰은 이 생성자를 못 부른다.
        let token = DesktopConfirmToken::issue_after_desktop_confirm(
            required.device_id(),
            required.bound_nonce(),
        );
        let action = match AuthorizedAction::authorize(&pending.grant, Some(&token)) {
            Ok(a) => a,
            Err(e) => {
                return self
                    .terminal_bytes(SessionResponse::Denied(SessionDenied::DesktopConfirm(e)))
            }
        };
        let out = dispatch(&action, &pending.request);
        self.terminal_bytes(SessionResponse::Ok(out))
    }

    /// 데스크톱 DENY 또는 TIMEOUT 후 — dispatch 0, 암호화된 "denied"(confirm 사유코드). 파킹된
    /// Grant 는 여기서 버려진다(토큰 미구성 ⇒ dispatch 불가). 폰은 결과로 거부만 받는다.
    pub fn finish_denied(&mut self, _pending: PendingDestructive) -> Vec<u8> {
        self.terminal_bytes(SessionResponse::Denied(SessionDenied::DesktopConfirm(
            AuthorizeError::DesktopConfirmRequired,
        )))
    }

    /// SessionResponse 를 즉시 암호화해 Terminal 로 감싼다(begin_frame 의 종결 경로).
    fn terminal(&mut self, response: SessionResponse) -> FrameOutcome {
        FrameOutcome::Terminal(self.encrypt_response(&response))
    }

    /// SessionResponse 를 암호화 바이트로(finish_* 의 종결 경로).
    fn terminal_bytes(&mut self, response: SessionResponse) -> Vec<u8> {
        self.encrypt_response(&response)
    }

    /// SessionResponse 를 채널로 암호화한다 — Ok/Denied 모두 ciphertext(릴레이 zero-knowledge).
    /// 응답 와이어: tag(1) | 페이로드. Ok=0x01 + 바이트, Denied=0x00 + 사유코드(1).
    fn encrypt_response(&mut self, response: &SessionResponse) -> Vec<u8> {
        let mut plaintext = Vec::new();
        match response {
            SessionResponse::Ok(body) => {
                plaintext.push(0x01);
                plaintext.extend_from_slice(body);
            }
            SessionResponse::Denied(d) => {
                plaintext.push(0x00);
                plaintext.push(denied_code(d));
            }
        }
        // 채널이 살아있는 한 encrypt 는 성공한다(성립된 AEAD). 실패 시(버퍼) 빈 벡터 —
        // 평문 누출보다 무응답이 안전(fail-closed). 정상 경로에선 도달 안 함.
        self.channel.encrypt(&plaintext).unwrap_or_default()
    }
}

/// SessionDenied → 1바이트 사유코드(응답 와이어 결정성). 평문 사유 문자열 누출 0.
fn denied_code(d: &SessionDenied) -> u8 {
    match d {
        SessionDenied::Decrypt => 1,
        SessionDenied::MalformedFrame => 2,
        SessionDenied::DeviceMismatch => 3,
        SessionDenied::Unauthorized(_) => 4,
        SessionDenied::DesktopConfirm(_) => 5,
    }
}

#[cfg(test)]
mod tests;
