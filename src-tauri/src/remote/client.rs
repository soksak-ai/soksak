// remote::client — 폰-링크 프로토콜의 INITIATOR(폰) 측 재사용 라이브러리(SYMMETRIC 절반).
//
// 이 모듈은 데스크톱을 제어하기 위해 **폰이 실행하는** 코드다 — responder/security 코어(auth/
// noise/session/confirm/serve_connection/transport/iroh-server)의 대칭쌍이다. 그 floor 들을
// 손대지 않고(ADD-only, RULE 5 기초), 그것들과 **대화하는** 클라이언트 표면을 추가한다. P3 의
// Tauri 모바일 앱이 이 라이브러리를 임베드한다(클라이언트=라이브러리, UI=얇은 표현).
//
// 무엇을 재사용하나(전부 기존 floor 의 PUBLIC API — 평행 구현 0):
//   - noise.rs: Handshake::initiate(KK INITIATOR) + StaticKeypair(X25519 device 신원) + NoiseChannel.
//   - auth.rs:  CapabilityAssertion(빌드) + 폰의 Ed25519 신원키로 SIGN + Scope(최소권한).
//   - session.rs(와이어 형식): RequestFrame::encode(서버의 decode 와 정확히 같은 바이트) + 응답
//     와이어 tag(Ok=0x01 / Denied=0x00 + 사유코드) — 서버 encrypt_response 의 정확한 역.
//   - transport.rs: 길이-프리픽스(u32 BE) frame 코덱(서버 read_framed/write_framed 와 동일).
//   - iroh.rs: JoinedStream(split (Send,Recv)→단일 스트림) 재사용 + Endpoint::connect 다이얼 경로.
//
// 절대 불변식(서버에서 상속 — 클라이언트가 약화 0; 올바른 클라이언트는 서버 게이트를 절대 안
// 건드린다):
//   - 인증-우선-연결(fail-closed): 데스크톱 static 키가 미핀닝/불일치면 KK INITIATOR 핸드셰이크가
//     **미성립**한다 — ClientSession 이 아예 안 생긴다(서버 fail-closed 의 거울). 틀린 키로
//     핀닝하면 KK 의 정적-정적 바인딩이 깨져 m2 read 에서 DH/MAC 불일치.
//   - per-call 신선 nonce + 단조 비감소 issued_at: 올바른 클라이언트는 매 호출 새 nonce 와
//     비감소 issued_at 을 써서 **서버의 재생/롤백 게이트를 절대 트립하지 않는다**(NonceReplay/
//     ClockRollback 0). 이건 서버 게이트를 끄는 게 아니라 — 게이트를 통과하도록 올바르게 만드는 것.
//   - 폰 기본 = read-only(좁은 scope). destructive 는 **명시 opt-in**(per-call). destructive 는
//     데스크톱 confirm 권위로 가며, 클라이언트는 "데스크톱 승인 대기"를 surface 하고 같은 채널에서
//     이벤트-우선(폴링 0)으로 최종 결과(승인-결과 또는 거부)를 받는다.
//   - 클라이언트 자신의 framing/encryption 정확성: 응답 ciphertext 가 깨지면 clean error(패닉 0).
//
// 공개 표면 일부는 P3 UI/CLI 만 호출하므로 테스트가 행위로 강제한다 — dead_code 허용.
#![allow(dead_code)]

use ed25519_dalek::{Signer, SigningKey};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use zeroize::Zeroize;

use crate::remote::auth::{CapabilityAssertion, Scope};
use crate::remote::noise::{
    Handshake, NoiseChannel, NoiseError, PinnedPeerRegistry, StaticKeypair, X25519_KEY_LEN,
};
use crate::remote::session::RequestFrame;
use crate::remote::transport::MAX_NOISE_MESSAGE;

// ===========================================================================
// 0. ClientError — 클라이언트 측 실패 분류(전부 fail-closed: 세션/응답 미생성).
// ===========================================================================

/// 폰 클라이언트의 실패 사유. 어떤 사유든 ClientSession/응답이 만들어지지 않는다(서버 거울).
#[derive(Debug)]
pub enum ClientError {
    /// 스트림 I/O 실패(읽기/쓰기) 또는 서버가 핸드셰이크 도중 끊김.
    Io(std::io::Error),
    /// 핸드셰이크 미성립 — 데스크톱 키 미핀닝/불일치(DH/MAC) 또는 서버가 채널 없이 종료.
    /// **fail-closed 의 정상 신호** — 틀린 데스크톱에 ClientSession 이 생기지 않는다.
    Handshake(NoiseError),
    /// 응답 frame 이 길이 캡 초과/잘림/형식 불량 — 변조/garbage 회신의 clean 거부(패닉 0).
    BadResponse,
    /// 응답 복호 실패(서버 채널 ciphertext 변조/순서뒤바뀜) — clean error(패닉 0).
    Decrypt,
    /// iroh 다이얼/연결 실패(transport 도달 실패 — auth 와 무관).
    Dial(String),
    /// 터널 거부(open_tunnel) — 서버가 NAK 회신. 미페어링/scope 부족/allowlist 밖 포트/로컬 미기동.
    /// **폰은 사유 코드를 못 받는다**(서버 zero-knowledge — ACK/NAK 1바이트만) — 거부 사실만 안다.
    TunnelDenied,
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientError::Io(e) => write!(f, "client io: {e}"),
            ClientError::Handshake(e) => write!(f, "handshake not established: {e}"),
            ClientError::BadResponse => f.write_str("malformed response frame"),
            ClientError::Decrypt => f.write_str("response decrypt failed (AEAD)"),
            ClientError::Dial(e) => write!(f, "dial failed: {e}"),
            ClientError::TunnelDenied => f.write_str("tunnel denied (unpaired/scope/allowlist/local)"),
        }
    }
}

impl std::error::Error for ClientError {}

impl From<std::io::Error> for ClientError {
    fn from(e: std::io::Error) -> Self {
        ClientError::Io(e)
    }
}

// ===========================================================================
// 1. DeviceIdentity — 폰의 두 신원키(X25519 Noise + Ed25519 assertion). 개인키 zeroize.
// ===========================================================================

/// 폰 1대의 영속 신원 — **두 종류의 키**(noise.rs 의 floor 주석 §6 그대로):
///   - X25519 static(Noise): KK INITIATOR 핸드셰이크. 데스크톱이 페어링 시 핀닝.
///   - Ed25519(assertion):    매 호출 CapabilityAssertion 서명. 데스크톱이 페어링 시 핀닝.
///
/// 데스크톱은 페어링 때 이 **두 공개키를 모두** 핀닝한다(noise.PinnedPeerRegistry.pin +
/// auth.DeviceRegistry.pair). 둘 다 같은 device_id 에 묶이므로 채널-peer 와 assertion 이 한
/// 기기로 교차검증된다(session.rs 의 기기-신원 결속).
///
/// 개인키 소거: X25519 개인키는 StaticKeypair 의 Drop 이, Ed25519 개인키는 이 타입의 Drop 이
/// zeroize 한다(메모리 잔상 0). 공개키는 비밀 아님.
pub struct DeviceIdentity {
    /// 이 기기의 식별자(announce + assertion.device_id). 데스크톱이 페어링 시 두 키에 묶는다.
    device_id: String,
    /// X25519 static 키쌍(Noise KK). 개인키는 StaticKeypair Drop 이 zeroize.
    x25519: StaticKeypair,
    /// Ed25519 신원키(assertion 서명). 개인키는 이 타입 Drop 이 zeroize(아래 impl Drop).
    ed25519: SigningKey,
}

impl DeviceIdentity {
    /// 새 폰 신원을 생성한다 — 두 키쌍을 무작위로 만든다(X25519 = snow DH resolver,
    /// Ed25519 = OsRng). 첫 실행 시 1회 호출하고 영속 저장한다(저장은 P3 의 책임).
    pub fn generate(device_id: &str) -> Result<Self, ClientError> {
        let x25519 = StaticKeypair::generate().map_err(ClientError::Handshake)?;
        let ed25519 = SigningKey::generate(&mut rand::rngs::OsRng);
        Ok(DeviceIdentity {
            device_id: device_id.to_string(),
            x25519,
            ed25519,
        })
    }

    /// 영속 저장에서 복원한다 — 두 개인키 바이트로(둘 다 32B). 저장/로드는 P3 의 책임.
    /// X25519 는 (private, public) 쌍이 필요하므로 둘 다 받는다(noise.from_parts 계약).
    pub fn from_parts(
        device_id: &str,
        x25519_private: [u8; X25519_KEY_LEN],
        x25519_public: [u8; X25519_KEY_LEN],
        ed25519_private: [u8; 32],
    ) -> Result<Self, ClientError> {
        let x25519 =
            StaticKeypair::from_parts(x25519_private, x25519_public).map_err(ClientError::Handshake)?;
        let ed25519 = SigningKey::from_bytes(&ed25519_private);
        Ok(DeviceIdentity {
            device_id: device_id.to_string(),
            x25519,
            ed25519,
        })
    }

    /// 이 기기의 식별자.
    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// X25519 static **공개**키 — 데스크톱이 페어링 시 핀닝하는 32B(Noise 채널 신원).
    pub fn x25519_public(&self) -> [u8; X25519_KEY_LEN] {
        self.x25519.public_key()
    }

    /// Ed25519 **공개**키 — 데스크톱이 페어링 시 핀닝하는 32B(assertion 검증키).
    pub fn ed25519_public(&self) -> [u8; 32] {
        self.ed25519.verifying_key().to_bytes()
    }

    /// QR 페어링이 데스크톱에 넘길 이 기기의 페어링 번들(두 공개키 + device_id).
    /// 데스크톱은 이걸 받아 noise.pin + auth.pair 로 핀닝한다(페어링 = 신뢰 확립).
    pub fn pairing_bundle(&self) -> PhonePairingBundle {
        PhonePairingBundle {
            device_id: self.device_id.clone(),
            x25519_public: self.x25519_public(),
            ed25519_public: self.ed25519_public(),
        }
    }
}

impl Drop for DeviceIdentity {
    fn drop(&mut self) {
        // Ed25519 개인키 소거 — SigningKey 를 0 키로 덮어쓴다(잔상 0). X25519 는 StaticKeypair
        // 의 Drop 이 자체 소거한다. 공개키는 비밀 아님.
        let mut zero = [0u8; 32];
        self.ed25519 = SigningKey::from_bytes(&zero);
        zero.zeroize();
    }
}

impl std::fmt::Debug for DeviceIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 개인키는 절대 Debug 로 새지 않는다.
        f.debug_struct("DeviceIdentity")
            .field("device_id", &self.device_id)
            .field("x25519_public", &"<32B>")
            .field("ed25519_public", &"<32B>")
            .field("ed25519_private", &"<redacted>")
            .finish()
    }
}

// ===========================================================================
// 2. 페어링 번들 — QR 교환 데이터(전송 0, 타입/헬퍼만).
// ===========================================================================

/// 폰이 페어링 시 데스크톱에 넘기는 번들(QR 의 내용) — 폰의 두 공개키 + device_id.
/// 데스크톱은 이걸 받아 noise.PinnedPeerRegistry.pin(x25519) + auth.DeviceRegistry.pair(ed25519)
/// 한다. (QR 전송 자체는 P3 — 여기선 번들 타입 + 직렬화 헬퍼만, RULE 8 무강결합.)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhonePairingBundle {
    pub device_id: String,
    pub x25519_public: [u8; X25519_KEY_LEN],
    pub ed25519_public: [u8; 32],
}

/// 데스크톱이 페어링 시 폰에 넘기는 번들(QR 의 내용) — 데스크톱의 다이얼 주소 + Noise static
/// 공개키. 폰은 desktop_static 을 핀닝(PinnedPeerRegistry.pin)해 KK INITIATOR 핸드셰이크를 건다.
///
/// node_id = iroh 전송 주소(다이얼 타겟)일 뿐 **auth 아님**(iroh.rs 의 node-id≠auth). 인증은
/// desktop_static(Noise X25519)이 한다. tcp_addr = 로컬/LAN fast-path 의 직결 주소(선택).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopPairingBundle {
    /// 데스크톱 식별자(폰의 PinnedPeerRegistry 키 — 핸드셰이크 시 이 id 로 핀닝 키 조회).
    pub desktop_id: String,
    /// 데스크톱의 X25519 static **공개**키 — 폰이 핀닝(KK 의 상대 static, 채널 인증).
    pub desktop_static: [u8; X25519_KEY_LEN],
    /// iroh node-id 문자열(z-base-32) — P2P 다이얼 타겟(선택). 없으면 LAN/TCP 만.
    pub node_id: Option<String>,
    /// 로컬/LAN 직결 주소(선택) — loopback/같은 WiFi fast-path.
    pub tcp_addr: Option<std::net::SocketAddr>,
}

// ===========================================================================
// 3. ClientResponse — 서버 응답의 클라이언트 측 매핑(session.rs 의 거울).
// ===========================================================================

/// 서버가 한 호출에 돌려준 결과의 클라이언트 측 모양. session.rs 의 SessionResponse 와 응답
/// 와이어 코드를 **정확히 미러**한다(서버 encrypt_response 의 역).
///
/// destructive 경로의 ConfirmRequired 는 이 enum 이 아니라 별도 PendingCall 로 표현한다 —
/// 클라이언트는 destructive 를 보낼 때 "데스크톱 승인 대기"를 즉시 surface 하고, 같은 채널에서
/// 이벤트-우선으로 최종 결과를 받는다(아래 ClientSession::call 참고).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientResponse {
    /// 서버가 dispatch 한 결과 바이트(복호된 평문 응답). read-only/write 즉시 경로 또는
    /// destructive 승인 후 경로.
    Ok(Vec<u8>),
    /// 게이트 거부 — dispatch 미발생. 사유코드(서버 denied_code 와 동일 매핑).
    Denied(DeniedReason),
}

impl ClientResponse {
    /// Ok 면 결과 바이트.
    pub fn ok_bytes(&self) -> Option<&[u8]> {
        match self {
            ClientResponse::Ok(b) => Some(b),
            ClientResponse::Denied(_) => None,
        }
    }

    /// 거부면 사유.
    pub fn denied(&self) -> Option<DeniedReason> {
        match self {
            ClientResponse::Denied(r) => Some(*r),
            ClientResponse::Ok(_) => None,
        }
    }

    pub fn is_ok(&self) -> bool {
        matches!(self, ClientResponse::Ok(_))
    }
}

/// 서버가 거부한 사유 — session.rs 의 denied_code(1바이트) 와 정확히 같은 매핑.
/// 서버는 평문 사유 문자열을 절대 흘리지 않으므로(zero-knowledge), 클라이언트도 코드만 받는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeniedReason {
    /// 채널 복호 실패(변조/재생/순서뒤바뀜) — 코드 1.
    Decrypt,
    /// frame 형식 불량 — 코드 2.
    MalformedFrame,
    /// assertion.device_id 가 채널 peer 와 불일치 — 코드 3(올바른 클라이언트는 안 트립).
    DeviceMismatch,
    /// auth floor 거부(미페어링/위조/만료/재생/scope 상승/revoked) — 코드 4.
    Unauthorized,
    /// destructive confirm 토큰 미제공/불일치 또는 데스크톱 거부/timeout — 코드 5.
    DesktopConfirm,
    /// 미지 코드(형식 진화 — 거부 표면).
    Unknown(u8),
}

impl DeniedReason {
    fn from_code(code: u8) -> DeniedReason {
        match code {
            1 => DeniedReason::Decrypt,
            2 => DeniedReason::MalformedFrame,
            3 => DeniedReason::DeviceMismatch,
            4 => DeniedReason::Unauthorized,
            5 => DeniedReason::DesktopConfirm,
            other => DeniedReason::Unknown(other),
        }
    }
}

// ===========================================================================
// 4. ClientSession — 성립된 채널 위의 호출 표면(KK INITIATOR 성공의 산물).
// ===========================================================================

/// 데스크톱과 성립된 보안 세션의 폰 측 절반 — 한 NoiseChannel(KK INITIATOR 성공 산물) + 그
/// 채널을 만든 폰 신원 + per-call 신선도 상태(nonce/issued_at).
///
/// **유일 생성 경로 = connect_stream / connect_tcp / connect_iroh**(완료된 INITIATOR 핸드셰이크
/// 에서). 미핀닝/틀린 데스크톱 키면 핸드셰이크가 미성립해 이 타입이 안 생긴다(fail-closed) —
/// 즉 ClientSession 이 존재한다는 사실 자체가 핀닝된 데스크톱과의 상호 인증 성립의 증거다
/// (서버의 SecureSession 불변식과 대칭).
///
/// `S` = 임의의 바이트 스트림(TcpStream · iroh JoinedStream · 테스트 duplex). transport-agnostic.
pub struct ClientSession<S> {
    stream: S,
    channel: NoiseChannel,
    /// 이 세션을 만든 폰 신원(assertion 서명 + device_id). 채널 peer 와 한 기기로 결속됨.
    device_id: String,
    ed25519: SigningKey,
    /// per-call 신선 nonce 발급기(절대 재사용 0 — 서버 NonceReplay 게이트를 안 트립).
    /// 호출마다 단조 증가하는 카운터를 nonce 바이트에 박아 매 호출 distinct nonce 를 보장한다.
    nonce_counter: u64,
    /// per-call 단조 비감소 issued_at 워터마크(서버 ClockRollback 게이트를 안 트립).
    /// 호출자가 준 issued_at 이 직전보다 작으면 직전값으로 끌어올린다(클라이언트는 자기
    /// 시계를 되돌리지 않는다 — 올바른 클라이언트의 단조성).
    last_issued_at: u64,
}

impl<S> ClientSession<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    /// 매 호출 신선한 nonce 를 만든다 — counter 를 nonce 바이트에 박아 distinct 보장(재사용 0).
    /// 32B 중 앞 8B 에 LE counter, 나머지에 고정 마커. 서버 NonceLedger 는 본 적 없는 nonce 만
    /// 소비하므로, distinct counter ⇒ 매 호출 소비 성공(NonceReplay 0).
    fn fresh_nonce(&mut self) -> [u8; 32] {
        self.nonce_counter += 1;
        let mut n = [0u8; 32];
        n[..8].copy_from_slice(&self.nonce_counter.to_le_bytes());
        // 세션 식별 마커(같은 기기의 두 세션이 우연히 같은 counter 를 써도, 각 세션 채널이
        // 분리돼 nonce 원장은 전역 1개 — 그래서 device_id 해시 일부를 섞어 충돌 여지를 더 줄인다).
        let id = self.device_id.as_bytes();
        for (i, b) in id.iter().take(16).enumerate() {
            n[16 + i] ^= *b;
        }
        n[15] = 0xAB; // 고정 마커(테스트 가독 + nonce 가 전부 0 이 되는 것 방지).
        n
    }

    /// 단조 비감소 issued_at 을 산출한다 — 호출자 제안값이 직전보다 작으면 직전값을 쓴다.
    /// 올바른 클라이언트는 시계를 되돌리지 않으므로 서버 ClockRollback(strict <) 을 안 트립한다.
    fn monotonic_issued_at(&mut self, proposed: u64) -> u64 {
        let v = proposed.max(self.last_issued_at);
        self.last_issued_at = v;
        v
    }

    /// 채널이 인증한 데스크톱 peer id(핀닝된 desktop_id). 감사/표시용.
    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// 서명된 RequestFrame 1개를 만들어 암호화→길이-프리픽스 송신한다(공통 송신 경로).
    /// 반환: 이 호출에 쓴 (scope) — destructive 분기 판단용. 신선 nonce + 단조 issued_at 강제.
    async fn send_call(
        &mut self,
        command: &[u8],
        params: &[u8],
        scope: Scope,
        exp: u64,
        proposed_issued_at: u64,
    ) -> Result<(), ClientError> {
        let nonce = self.fresh_nonce();
        let issued_at = self.monotonic_issued_at(proposed_issued_at);
        // 명령 페이로드 — command 와 params 를 합쳐 불투명 request 바이트로(서버는 불투명 취급).
        // P3/CLI 는 보통 JSON `{"method":command,"params":params}` 를 만들지만, 라이브러리는
        // request 바이트를 그대로 받아 frame 에 싣는다(RULE 8 무강결합 — 의미는 상위 layer).
        let request = build_request(command, params);
        let assertion = CapabilityAssertion {
            device_id: self.device_id.clone(),
            scope,
            nonce,
            issued_at,
            exp,
        };
        // **폰 자기 Ed25519 키로 SIGN** — 데스크톱이 핀닝한 공개키로 verify_strict 된다(페어링
        // 라운드트립: 폰 pubkeys 가 데스크톱에 핀닝됨). 서명은 canonical_bytes 위에(서버와 동일).
        let signature = self.ed25519.sign(&assertion.canonical_bytes()).to_bytes().to_vec();
        let frame = RequestFrame {
            assertion,
            signature,
            request,
        }
        .encode();
        // 채널로 암호화(클라이언트 자기 framing/encryption — AEAD). 평문은 와이어에 안 나간다.
        let ct = self.channel.encrypt(&frame).map_err(|_| ClientError::BadResponse)?;
        write_framed(&mut self.stream, &ct).await?;
        Ok(())
    }

    /// 서버의 암호화 응답 1개를 길이-프리픽스로 받아 복호→ClientResponse 로 환원(공통 수신 경로).
    /// **이벤트-우선**: read_framed 가 채널 바이트가 올 때까지 await 한다(폴링 0). 변조/잘림 ⇒
    /// clean error(패닉 0 — 클라이언트 자기 복호 정확성).
    async fn recv_response(&mut self) -> Result<ClientResponse, ClientError> {
        let ct = match read_framed(&mut self.stream).await? {
            Some(b) => b,
            // 서버가 응답 없이 끊김 — clean error(핸드셰이크 후 비정상 종료).
            None => return Err(ClientError::BadResponse),
        };
        let plaintext = self.channel.decrypt(&ct).map_err(|_| ClientError::Decrypt)?;
        decode_response(&plaintext)
    }

    /// **read-only/write 호출** — 동기 즉시 경로. frame 송신 → 응답 1개 수신(이벤트-우선) →
    /// Ok(result) / Denied(reason). 서버는 비파괴를 즉시 dispatch 하므로 응답이 곧 온다.
    ///
    /// scope 는 호출자가 준다(폰 기본 read-only — 명시 opt-in 으로만 상승). destructive scope 를
    /// 이 메서드에 주면 서버가 confirm 권위로 보내 응답이 지연되거나 Denied(DesktopConfirm) 가
    /// 올 수 있다 — destructive 는 call_destructive 를 쓰는 게 옳다(아래).
    pub async fn call(
        &mut self,
        command: &[u8],
        params: &[u8],
        scope: Scope,
        exp: u64,
        proposed_issued_at: u64,
    ) -> Result<ClientResponse, ClientError> {
        self.send_call(command, params, scope, exp, proposed_issued_at).await?;
        self.recv_response().await
    }

    /// **destructive 호출(명시 opt-in)** — frame 을 destructive scope 로 보내고, 즉시
    /// PendingCall("데스크톱 승인 대기")을 돌려준다. dispatch 는 아직 0(데스크톱 사람 결정 전).
    ///
    /// 클라이언트는 여기서 "awaiting desktop approval" 을 surface 한다(반환 = PendingCall). 그
    /// 다음 PendingCall::await_outcome 이 **같은 채널에서 이벤트-우선**으로 데스크톱의 단일 최종
    /// 응답을 받는다 — APPROVE ⇒ 승인-결과(Ok), DENY/TIMEOUT ⇒ Denied(DesktopConfirm). 폴링 0
    /// (read_framed 가 서버의 finish_confirmed/finish_denied 회신을 await — serve_connection_
    /// confirmed 가 사람 결정 후 정확히 한 번 회신한다).
    ///
    /// scope 가 read-only/write 인데도 이 경로를 쓰면(즉 destructive 아님), 서버는 즉시 dispatch
    /// 해 await_outcome 이 곧바로 Ok 를 받는다 — 그래도 정확하다(서버 단일 응답을 await 할 뿐).
    /// 다만 의도를 분명히 하려면 destructive 일 때만 이 경로를 쓴다.
    pub async fn call_destructive(
        &mut self,
        command: &[u8],
        params: &[u8],
        exp: u64,
        proposed_issued_at: u64,
    ) -> Result<PendingCall<'_, S>, ClientError> {
        self.send_call(command, params, Scope::Destructive, exp, proposed_issued_at)
            .await?;
        // 송신 직후 — 클라이언트는 destructive 를 보냈음을 안다. "데스크톱 승인 대기" surface.
        // 응답(승인-결과/거부)은 await_outcome 이 같은 채널에서 이벤트-우선으로 받는다.
        Ok(PendingCall { session: self })
    }

    /// **터널 열기(폰 측)** — 데스크톱의 로컬 dev-server(`127.0.0.1:port`)로의 reverse-proxy
    /// 바이트 스트림을 연다. 서버 serve_tunnel 의 대칭쌍이다.
    ///
    /// 흐름(서버 serve_tunnel 의 거울):
    ///   1. 터널-인가 frame 송신 — assertion(scope=Write, 신선 nonce + 단조 issued_at) +
    ///      request=`tunnel:port`(encode_tunnel_request) 를 폰 Ed25519 키로 서명·암호화·송신.
    ///      이건 명령 dispatch frame 과 **별개 모드**(request 형식이 다름) — 서버가 authorize_tunnel 로 처리.
    ///   2. ack 수신 — 서버가 채널로 암호화한 1바이트(ACK=인가+프록시 시작 / NAK=거부/에러).
    ///      NAK ⇒ 터널 거부(미페어링/scope/allowlist 밖/로컬 미기동) ⇒ TunnelDenied 에러(스트림 0).
    ///   3. ACK ⇒ ClientSession 을 **TunnelStream 으로 소비** — 이후 채널은 raw 바이트 파이프
    ///      (send=암호화·프레임·송신, recv=수신·복호). 평문은 와이어에 안 나간다(릴레이 zero-knowledge).
    ///
    /// scope=Write(TUNNEL_SCOPE 거울) — read-only 폰은 서버 auth 게이트에서 거부된다(scope ⊆ granted).
    /// 데스크톱이 그 포트를 allowlist 에 넣지 않았으면 NAK(폰은 allowlist 를 못 바꾼다 — anti-escalation).
    pub async fn open_tunnel(
        mut self,
        port: u16,
        exp: u64,
        proposed_issued_at: u64,
    ) -> Result<TunnelStream<S>, ClientError> {
        // 1. 터널-인가 frame — request 바이트는 정확히 `tunnel:port`(서버 decode_tunnel_request 의 역).
        let request = crate::remote::tunnel::encode_tunnel_request(port);
        let nonce = self.fresh_nonce();
        let issued_at = self.monotonic_issued_at(proposed_issued_at);
        let assertion = CapabilityAssertion {
            device_id: self.device_id.clone(),
            scope: crate::remote::tunnel::TUNNEL_SCOPE,
            nonce,
            issued_at,
            exp,
        };
        let signature = self.ed25519.sign(&assertion.canonical_bytes()).to_bytes().to_vec();
        let frame = RequestFrame {
            assertion,
            signature,
            request,
        }
        .encode();
        let ct = self.channel.encrypt(&frame).map_err(|_| ClientError::BadResponse)?;
        write_framed(&mut self.stream, &ct).await?;

        // 2. ack 수신 — 서버가 채널로 암호화한 1바이트(ACK/NAK).
        let ack_ct = match read_framed(&mut self.stream).await? {
            Some(b) => b,
            None => return Err(ClientError::Handshake(NoiseError::HandshakeFailed)),
        };
        let ack_pt = self.channel.decrypt(&ack_ct).map_err(|_| ClientError::Decrypt)?;
        match ack_pt.first() {
            Some(0x01) => {} // ACK — 프록시 시작.
            // NAK(0x00) 또는 빈/미지 — 터널 거부(미페어링/scope/allowlist 밖/로컬 미기동).
            _ => return Err(ClientError::TunnelDenied),
        }

        // 3. ACK ⇒ TunnelStream 으로 소비. 채널 + 스트림을 raw 파이프로 넘긴다.
        Ok(TunnelStream {
            stream: self.stream,
            channel: self.channel,
        })
    }
}

impl<S> std::fmt::Debug for ClientSession<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 채널 대칭키/ed25519 개인키는 절대 Debug 로 새지 않는다.
        f.debug_struct("ClientSession")
            .field("device_id", &self.device_id)
            .field("nonce_counter", &self.nonce_counter)
            .field("last_issued_at", &self.last_issued_at)
            .field("channel", &"<noise channel>")
            .field("ed25519", &"<redacted>")
            .finish()
    }
}

/// destructive 호출의 "데스크톱 승인 대기" 핸들. 존재 자체가 "awaiting desktop approval" 의
/// surface 다. await_outcome 이 같은 채널에서 데스크톱의 단일 최종 응답을 **이벤트-우선**(폴링 0)
/// 으로 받는다 — 서버 serve_connection_confirmed 가 사람 결정 후 정확히 한 번 회신한다.
///
/// 빌림(`&mut session`)으로 모델링 — pending 인 동안 같은 세션으로 다른 호출을 끼워넣지 못하게
/// 한다(한 채널의 응답 순서 보존). P3 UI 는 이 핸들이 살아있는 동안 "승인 대기 중" 을 보여준다.
pub struct PendingCall<'a, S> {
    session: &'a mut ClientSession<S>,
}

impl<'a, S> PendingCall<'a, S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    /// 이 호출이 데스크톱 confirm 을 기다리는 중임(항상 true — 이 핸들의 존재가 곧 대기 상태).
    /// P3 UI 가 "awaiting desktop approval" 배지를 띄우는 데 쓴다.
    pub fn is_awaiting_desktop_approval(&self) -> bool {
        true
    }

    /// 데스크톱 사람 결정의 **최종 결과**를 받는다(이벤트-우선, 폴링 0). 같은 채널에서 서버의
    /// 단일 회신을 await:
    ///   - APPROVE ⇒ 서버가 finish_confirmed 로 dispatch 한 승인-결과 ⇒ ClientResponse::Ok.
    ///   - DENY/TIMEOUT ⇒ 서버가 finish_denied 로 회신 ⇒ ClientResponse::Denied(DesktopConfirm).
    ///
    /// read_framed 가 결정이 날 때까지 await 한다(sleep-poll 아님 — 서버가 oneshot 으로 깨어
    /// 회신하면 그 바이트가 도착해 read 가 풀린다). 변조 ⇒ clean error(패닉 0).
    pub async fn await_outcome(self) -> Result<ClientResponse, ClientError> {
        self.session.recv_response().await
    }
}

// ===========================================================================
// 4b. TunnelStream — 인가된 터널의 폰 측 raw 바이트 파이프(서버 tunnel::proxy 의 거울).
// ===========================================================================

/// open_tunnel 성공(ACK)의 산물 — 데스크톱의 `127.0.0.1:port` dev-server 로 프록시되는 폰 측
/// 바이트 스트림. ClientSession 을 소비해 만들어진다(명령 dispatch 모드를 떠나 바이트-파이프 모드).
///
/// 와이어는 서버 tunnel::proxy 와 **정확히 같다**: 각 방향의 청크가 채널로 암호화되어 길이-프리픽스
/// frame 1개로 흐른다. send=평문→암호화→frame→송신, recv=수신→복호→평문. **평문은 와이어에 안
/// 나간다**(릴레이 zero-knowledge — NoiseChannel encrypt/decrypt 재사용). 빈 평문 = EOF 신호.
///
/// 명시 send/recv API(AsyncRead/AsyncWrite poll 버퍼링 대신) — 프레임 경계가 곧 청크 경계라
/// HTTP 요청/응답 단위 round-trip 과 멀티-청크 스트리밍을 직접 표현한다(테스트가 행위로 강제).
pub struct TunnelStream<S> {
    stream: S,
    channel: NoiseChannel,
}

impl<S> TunnelStream<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    /// 평문 바이트 1청크를 데스크톱 dev-server 로 보낸다(암호화→frame→송신). HTTP 요청 바이트를
    /// 그대로 넣으면 서버 proxy 가 복호해 127.0.0.1:port 에 write 한다. 평문은 와이어에 안 나간다.
    pub async fn send(&mut self, plaintext: &[u8]) -> Result<(), ClientError> {
        let ct = self.channel.encrypt(plaintext).map_err(|_| ClientError::BadResponse)?;
        write_framed(&mut self.stream, &ct).await
    }

    /// dev-server 응답 1청크를 받는다(수신→복호). None = EOF(서버가 빈 평문/채널 종료로 신호).
    /// 변조/잘림 ⇒ clean error(패닉 0). 멀티-청크 응답은 recv 를 반복 호출해 스트리밍으로 받는다.
    pub async fn recv(&mut self) -> Result<Option<Vec<u8>>, ClientError> {
        let ct = match read_framed(&mut self.stream).await? {
            Some(b) => b,
            None => return Ok(None), // 채널 EOF — 서버가 끊음.
        };
        let plaintext = self.channel.decrypt(&ct).map_err(|_| ClientError::Decrypt)?;
        if plaintext.is_empty() {
            // 빈 평문 = 서버 측 EOF 신호(dev-server 응답 끝). 더 받을 게 없다.
            return Ok(None);
        }
        Ok(Some(plaintext))
    }

    /// 보낼 게 끝났음을 신호한다(빈 평문 = write-half EOF). 서버 proxy 가 로컬 write-half 를 닫는다.
    pub async fn finish_sending(&mut self) -> Result<(), ClientError> {
        let ct = self.channel.encrypt(&[]).map_err(|_| ClientError::BadResponse)?;
        write_framed(&mut self.stream, &ct).await
    }
}

impl<S> std::fmt::Debug for TunnelStream<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TunnelStream")
            .field("channel", &"<noise channel>")
            .finish()
    }
}

// ===========================================================================
// 5. connect — KK INITIATOR 핸드셰이크(fail-closed on wrong key)로 ClientSession 봉인.
// ===========================================================================

/// **아무 바이트 스트림** 위에서 KK INITIATOR 핸드셰이크를 돌려 ClientSession 을 봉인한다
/// (transport-agnostic 코어 — connect_tcp/connect_iroh 가 이걸 호출한다).
///
/// 흐름(서버 serve_connection 의 정확한 거울 — 미페어링/틀린 키 ⇒ 채널 0):
///   1. announce: 폰이 자기 device_id 를 길이-프리픽스 한 줄로 보낸다(핸드셰이크 전). 서버는
///      이 id 로 어느 핀닝 키로 KK 를 세울지 안다.
///   2. 폰이 **핀닝된 데스크톱 static 키**로 KK initiate(noise.Handshake::initiate). 데스크톱 키가
///      미핀닝이면 여기서 Err(UnpinnedPeer) — 핸드셰이크 객체조차 안 생긴다(fail-closed).
///   3. KK 2-메시지: -> m1 쓰기, <- m2 읽기. 데스크톱이 채널 미성립으로 닫으면 m2 가 없어(EOF)
///      Err. **틀린 데스크톱 키**를 핀닝했으면 m2 read 에서 DH/MAC 불일치 ⇒ HandshakeFailed
///      (정적-정적 바인딩이 깨짐) ⇒ ClientSession 미생성(서버 fail-closed 의 거울).
///   4. into_channel 봉인 → ClientSession. 채널 존재 = 핀닝된 데스크톱과 상호 인증 성립의 증거.
///
/// `desktop_static` = 페어링 때 받은 데스크톱의 X25519 static 공개키(폰이 핀닝). 이게 틀리면
/// 핸드셰이크가 미성립한다 — 즉 "잘못된 데스크톱에는 세션이 안 생긴다".
pub async fn connect_stream<S>(
    mut stream: S,
    identity: &DeviceIdentity,
    desktop_id: &str,
    desktop_static: &[u8; X25519_KEY_LEN],
) -> Result<ClientSession<S>, ClientError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    // 1. announce — 폰이 자기 device_id 를 보낸다(핸드셰이크 전, 길이-프리픽스).
    write_framed(&mut stream, identity.device_id.as_bytes()).await?;

    // 2. 폰이 데스크톱 static 을 핀닝 + KK INITIATOR initiate. 미핀닝/틀린 키 처리는 noise floor 가.
    //    PinnedPeerRegistry 는 이 한 연결 전용(핀닝 단일 권위는 데스크톱이 폰을 핀닝하는 쪽; 폰은
    //    페어링 때 받은 데스크톱 키를 여기 핀닝해 KK 의 "상대 static" 으로 쓴다).
    let mut peers = PinnedPeerRegistry::new();
    peers
        .pin(desktop_id, desktop_static)
        .map_err(|_| ClientError::Handshake(NoiseError::InvalidKey))?;
    let mut handshake = Handshake::initiate(&identity.x25519, &peers, desktop_id)
        .map_err(ClientError::Handshake)?;

    // 3. KK 2-메시지: -> m1, <- m2. 틀린 데스크톱 키면 m2 read 에서 DH/MAC 불일치(채널 0).
    let m1 = handshake.write_message().map_err(ClientError::Handshake)?;
    write_framed(&mut stream, &m1).await?;
    let m2 = match read_framed(&mut stream).await? {
        Some(b) => b,
        // 서버가 채널 미성립으로 m2 없이 닫음 — fail-closed 의 정상 신호(미페어링/revoked/틀린 키).
        None => return Err(ClientError::Handshake(NoiseError::HandshakeFailed)),
    };
    handshake.read_message(&m2).map_err(ClientError::Handshake)?; // 틀린 키 ⇒ HandshakeFailed.

    // 4. 봉인 — 미완이면 into_channel 이 Err(채널 0). 채널 = 상호 인증 성립의 증거.
    let channel = handshake.into_channel().map_err(ClientError::Handshake)?;
    Ok(ClientSession {
        stream,
        channel,
        device_id: identity.device_id.clone(),
        ed25519: identity.ed25519.clone(),
        nonce_counter: 0,
        last_issued_at: 0,
    })
}

/// **loopback/LAN TCP** 다이얼 → KK INITIATOR 핸드셰이크 → ClientSession(TcpStream 위).
/// 로컬 개발/같은 WiFi fast-path. 틀린 데스크톱 키 ⇒ fail-closed(세션 0).
pub async fn connect_tcp(
    addr: std::net::SocketAddr,
    identity: &DeviceIdentity,
    desktop_id: &str,
    desktop_static: &[u8; X25519_KEY_LEN],
) -> Result<ClientSession<tokio::net::TcpStream>, ClientError> {
    let stream = tokio::net::TcpStream::connect(addr).await?;
    connect_stream(stream, identity, desktop_id, desktop_static).await
}

/// **iroh P2P/relay** 다이얼 → bi-stream → KK INITIATOR 핸드셰이크 → ClientSession(iroh
/// JoinedStream 위). CGNAT/원격 — node-id 다이얼 후 같은 serve_connection 거울이 QUIC bi-stream
/// 위로 흐른다. 서버 iroh.rs 의 accept_bi 와 대칭으로, 폰은 open_bi 로 스트림을 연다.
///
/// **node-id ≠ auth(iroh.rs 와 대칭)**: node_addr 는 transport 다이얼 타겟일 뿐이다. 정확한
/// node-id 로 닿아도 핀닝된 desktop_static(Noise) 없이는 KK 가 미성립 ⇒ ClientSession 0. 즉
/// "올바른 주소"가 "올바른 데스크톱"을 보장하지 않는다 — Noise device-key 인증이 그걸 증명한다.
///
/// JoinedStream(iroh.rs 재사용 — split (Send,Recv)→단일 스트림)으로 connect_stream 을 **무수정**
/// 호출한다. open_bi 는 우리가 먼저 announce 를 쓰므로 서버 accept_bi 가 깬다(iroh open_bi 계약).
pub async fn connect_iroh(
    endpoint: &iroh::Endpoint,
    node_addr: iroh::NodeAddr,
    identity: &DeviceIdentity,
    desktop_id: &str,
    desktop_static: &[u8; X25519_KEY_LEN],
) -> Result<ClientSession<crate::remote::iroh::JoinedStream>, ClientError> {
    use crate::remote::iroh::{JoinedStream, IROH_ALPN};
    // node-id 다이얼(transport 도달) — 실패는 auth 와 무관한 Dial 에러.
    let conn = endpoint
        .connect(node_addr, IROH_ALPN)
        .await
        .map_err(|e| ClientError::Dial(e.to_string()))?;
    // 폰이 stream 을 연다(open_bi). 우리가 announce 를 먼저 쓰므로 서버 accept_bi 가 깬다.
    let (send, recv) = conn
        .open_bi()
        .await
        .map_err(|e| ClientError::Dial(e.to_string()))?;
    let stream = JoinedStream::new(send, recv);
    connect_stream(stream, identity, desktop_id, desktop_static).await
}

// ===========================================================================
// 6. 와이어 헬퍼 — 서버 transport.rs 코덱과 정확히 같은 길이-프리픽스(u32 BE) + 응답 디코딩.
// ===========================================================================

/// 길이-프리픽스 1개를 읽는다(서버 transport::read_framed 와 동일): u32(BE) → 그만큼 바이트.
/// 캡 초과 ⇒ BadResponse(증폭 0), EOF(첫 바이트 부재) ⇒ None(정상 종료), 잘림 ⇒ Io 에러.
async fn read_framed<R>(r: &mut R) -> Result<Option<Vec<u8>>, ClientError>
where
    R: AsyncRead + Unpin,
{
    let mut len_buf = [0u8; 4];
    match r.read_exact(&mut len_buf).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(ClientError::Io(e)),
    }
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > MAX_NOISE_MESSAGE {
        return Err(ClientError::BadResponse); // 캡 초과 = malformed/증폭 — clean 거부(패닉 0).
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).await?; // 잘림 ⇒ UnexpectedEof ⇒ Io 에러(graceful).
    Ok(Some(body))
}

/// 길이-프리픽스 1개를 쓴다(서버 transport::write_framed 와 동일): u32(BE) → 바이트.
async fn write_framed<W>(w: &mut W, bytes: &[u8]) -> Result<(), ClientError>
where
    W: AsyncWrite + Unpin,
{
    if bytes.len() > MAX_NOISE_MESSAGE {
        return Err(ClientError::BadResponse);
    }
    let len = (bytes.len() as u32).to_be_bytes();
    w.write_all(&len).await?;
    w.write_all(bytes).await?;
    w.flush().await?;
    Ok(())
}

/// 복호된 응답 평문 → ClientResponse(서버 session::encrypt_response 의 정확한 역).
/// 와이어: tag(1) | 페이로드. Ok=0x01 + 결과바이트, Denied=0x00 + 사유코드(1). 형식 불량 ⇒
/// BadResponse(패닉 0 — 빈/짧은 응답도 clean 거부).
fn decode_response(plaintext: &[u8]) -> Result<ClientResponse, ClientError> {
    match plaintext.first() {
        Some(0x01) => Ok(ClientResponse::Ok(plaintext[1..].to_vec())),
        Some(0x00) => {
            // Denied — 사유코드 1바이트가 따라야 한다.
            let code = *plaintext.get(1).ok_or(ClientError::BadResponse)?;
            Ok(ClientResponse::Denied(DeniedReason::from_code(code)))
        }
        // 미지 tag/빈 응답 ⇒ clean 거부(다운그레이드/형식불량 표면).
        _ => Err(ClientError::BadResponse),
    }
}

/// command + params 를 불투명 request 바이트로 합친다. 둘 다 비면 빈 바이트, params 가 비면
/// command 만(서버는 불투명 취급 — bridge.rs 가 JSON `{"method","params"}` 로 해석하는 게 보통).
///
/// 라이브러리는 의미를 강제하지 않는다(RULE 8): command/params 가 이미 JSON 모양이면 그대로
/// 쓰고, 아니면 JSON 봉투로 감싼다. 단순/예측가능을 위해 params 가 있으면 JSON 봉투를 만든다.
fn build_request(command: &[u8], params: &[u8]) -> Vec<u8> {
    if params.is_empty() {
        // params 없음 — command 바이트를 그대로(예: "ui.tree" 또는 이미 완성된 JSON).
        command.to_vec()
    } else {
        // JSON 봉투 — bridge.rs 의 dispatch 가 기대하는 {"method","params"} 모양.
        let method = String::from_utf8_lossy(command);
        let params_str = String::from_utf8_lossy(params);
        format!("{{\"method\":\"{method}\",\"params\":{params_str}}}").into_bytes()
    }
}

#[cfg(test)]
mod tests;
