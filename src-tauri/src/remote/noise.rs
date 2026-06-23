// remote::noise — 전송 E2E 기밀성 하한선(RULE 0 암호 불변식: "봐도 절대 못 푼다").
//
// 이 모듈은 "상호 인증된 암호 채널"이라는 generic capability 다(폰 전용 아님 — RULE 8 무강결합).
// auth.rs(Ed25519 capability assertion = 액션별 인가)와 **별개이며 그 아래** 층이다: 이건
// 채널 인증 + 기밀성(transport-agnostic Noise), auth.rs 는 그 위에서 액션별 권한을 증명한다.
// 기기마다 두 종류의 키: 이 모듈의 X25519 static 키(Noise 핸드셰이크)와 auth.rs 의 Ed25519
// 신원 키(assertion). 페어링은 둘 다 핀닝하고, 이 모듈은 X25519 쪽을 소유한다.
//
// 어떤 TcpListener·ipc·route() 변경도 하지 않는다 — Noise floor 모듈 + 테스트만. transport
// 배선(iroh/Go-relay/cloudflared 위에 얹기)은 다음 단계다. 공개 표면은 아직 transport 가
// 호출하지 않으므로 일부 미사용 — dead_code 허용. 테스트(`mod tests`)가 전 표면을 행위로 강제.
//
// Noise 패턴 = Noise_KK_25519_ChaChaPoly_BLAKE2s.
//   - KK: 양측 static 키를 **사전에 서로 안다**(페어링으로 핀닝) ⇒ MUTUAL authentication.
//         (Noise spec: K = "known to recipient", 양 K ⇒ 상호 정적키 바인딩.)
//   - 25519: X25519 ECDHE — 핸드셰이크마다 임시(ephemeral) 키교환(ee DH) ⇒ forward secrecy(PFS).
//   - ChaChaPoly: ChaCha20-Poly1305 AEAD — per-message nonce/counter 를 Noise 가 관리.
//   - BLAKE2s: 핸드셰이크 해시.
//
// 절대 불변식(RULE 0 — 뚫리면 끝):
//   - 인증-우선-연결(fail-closed): 상대 static 키가 미핀닝/불일치면 핸드셰이크가 **미성립**한다
//     — 채널(TransportState)이 아예 안 생긴다. 거부가 아니라 비-생성. KK 의 정적-정적 바인딩이
//     틀린 키의 DH/MAC 을 깨므로 핸드셰이크가 완료 불가.
//   - 미인증 fallback·디버그 백도어·로컬-신뢰 예외 0. 평문 경로 0. 다운그레이드 협상 0
//     (패턴 문자열이 한 곳 상수로 고정 — 약 cipher 로 내려갈 표면이 없다).
//   - 핸드셰이크 전 앱데이터 0: encrypt/decrypt 는 완성된 NoiseChannel 에만 존재한다.
//   - 릴레이 zero-knowledge: 릴레이/포워더는 불투명 ciphertext 만 본다(평문 미포함).
//   - 변조 ciphertext ⇒ AEAD auth 실패 ⇒ Err(절대 garbage plaintext 반환 0).
//   - 재생/순서뒤바뀜(재사용 counter) ⇒ Noise nonce sequencing 이 거부.
//   - PFS(정직·검증가능): 세션키는 ephemeral DH 파생 → (a) 같은 static 쌍의 두 핸드셰이크가
//     서로 다른 transport 키, (b) ephemeral 비밀은 핸드셰이크 후 zeroize(채널이 보관 0),
//     (c) static 개인키만으로 과거 세션키 재구성 불가(채널에 ephemeral private 미보유).

#![allow(dead_code)]

use snow::{Builder, HandshakeState, TransportState};
use zeroize::Zeroize;

/// 이 floor 가 고정한 단 하나의 Noise 패턴. **다운그레이드 0** — 협상 표면이 없다.
/// 약 cipher/약 패턴으로 내려가려면 이 상수를 바꿔야 하는데, 모든 핸드셰이크가 이 한 상수만
/// 참조하므로 런타임 협상으로 약화할 경로가 존재하지 않는다(RULE 0 다운그레이드 거부).
///
/// KK = 양측 static 키 사전공지(mutual auth) · 25519 = X25519 ephemeral DH(PFS) ·
/// ChaChaPoly = ChaCha20-Poly1305 AEAD · BLAKE2s = 핸드셰이크 해시.
pub const NOISE_PATTERN: &str = "Noise_KK_25519_ChaChaPoly_BLAKE2s";

/// X25519 정적키의 바이트 길이(공개·개인 동일 32B).
pub const X25519_KEY_LEN: usize = 32;

// ===========================================================================
// 0. NoiseError — fail-closed 의 명시적 분류(감사/디버그). 어떤 사유든 채널 미생성.
// ===========================================================================

/// Noise floor 의 실패 사유. 핸드셰이크 단계의 어떤 실패도 ⇒ 채널 미생성(거부가 아니라 미성립).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoiseError {
    /// 상대 peer 가 핀닝된 적 없음 — 미상 static 키로는 핸드셰이크 시작 불가(인증-우선-연결).
    UnpinnedPeer,
    /// 핀닝된 peer 가 revoke(deactivate)됨 — kill-switch. 핸드셰이크 거부.
    PeerRevoked,
    /// 핀닝/로컬 키 바이트가 유효한 X25519 점이 아님(snow 키 검증 실패).
    InvalidKey,
    /// snow 빌더가 핸드셰이크 상태 구성 실패(키 누락/패턴 불일치 등).
    HandshakeSetup,
    /// 핸드셰이크 메시지 처리 실패 — **틀린 static 키 ⇒ DH/MAC 불일치가 여기로**. 채널 미성립.
    HandshakeFailed,
    /// 핸드셰이크가 완료되지 않은 상태에서 transport 전환 시도(미완 채널 0).
    HandshakeIncomplete,
    /// AEAD 인증 실패 — 변조/재생/순서뒤바뀜 ciphertext. **plaintext 절대 미반환**.
    Decrypt,
    /// 출력 버퍼 부족/길이 형식 불량.
    Buffer,
}

impl std::fmt::Display for NoiseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            NoiseError::UnpinnedPeer => "remote static key not pinned",
            NoiseError::PeerRevoked => "peer revoked",
            NoiseError::InvalidKey => "invalid X25519 key",
            NoiseError::HandshakeSetup => "handshake setup failed",
            NoiseError::HandshakeFailed => "handshake failed (wrong static key / DH mismatch)",
            NoiseError::HandshakeIncomplete => "handshake not complete",
            NoiseError::Decrypt => "AEAD authentication failed",
            NoiseError::Buffer => "buffer error",
        };
        f.write_str(s)
    }
}

impl std::error::Error for NoiseError {}

// ===========================================================================
// 1. StaticKeypair — 로컬 측 X25519 정적 신원키(개인키 drop 시 zeroize)
// ===========================================================================

/// 로컬 기기의 X25519 **정적** 키쌍. 페어링 시 상대에게 핀닝되는 공개키 + 핸드셰이크에 쓰는
/// 개인키. 개인키는 Drop 시 zeroize 된다(메모리 잔상 0).
///
/// 이건 **static** 키다(장기 신원, ee 임시키와 별개). PFS 는 핸드셰이크마다 새로 만드는
/// ephemeral DH(ee)에서 나오며, 이 static 개인키만으로는 과거 세션을 못 푼다(PFS-c).
pub struct StaticKeypair {
    /// 핀닝 대상 — 상대가 이 32B 를 핀닝한다. 공개라 zeroize 불요.
    public: [u8; X25519_KEY_LEN],
    /// 핸드셰이크용 개인키. Drop 시 zeroize(아래 impl Drop).
    private: [u8; X25519_KEY_LEN],
}

impl StaticKeypair {
    /// 새 X25519 정적 키쌍을 생성한다(snow 의 DH resolver 사용 — 자체 crypto 0).
    pub fn generate() -> Result<Self, NoiseError> {
        let builder = Builder::new(
            NOISE_PATTERN
                .parse()
                .map_err(|_| NoiseError::HandshakeSetup)?,
        );
        let kp = builder
            .generate_keypair()
            .map_err(|_| NoiseError::HandshakeSetup)?;
        if kp.public.len() != X25519_KEY_LEN || kp.private.len() != X25519_KEY_LEN {
            return Err(NoiseError::InvalidKey);
        }
        let mut public = [0u8; X25519_KEY_LEN];
        let mut private = [0u8; X25519_KEY_LEN];
        public.copy_from_slice(&kp.public);
        private.copy_from_slice(&kp.private);
        // snow 가 반환한 Vec 의 개인키 잔상도 지운다(생성기 보유분 소거 — 모범).
        let mut kp_private = kp.private;
        kp_private.zeroize();
        Ok(StaticKeypair { public, private })
    }

    /// (private, public) 쌍을 영속 저장에서 복원한다. 둘 다 핀닝/검증된 값이어야 한다.
    pub fn from_parts(
        private: [u8; X25519_KEY_LEN],
        public: [u8; X25519_KEY_LEN],
    ) -> Result<Self, NoiseError> {
        if private == [0u8; X25519_KEY_LEN] || public == [0u8; X25519_KEY_LEN] {
            return Err(NoiseError::InvalidKey);
        }
        Ok(StaticKeypair { public, private })
    }

    /// 핀닝 대상 공개키(상대에게 전달). 32B.
    pub fn public_key(&self) -> [u8; X25519_KEY_LEN] {
        self.public
    }

    /// 내부 전용 — 핸드셰이크 빌더에 개인키를 넘긴다. 공개 API 아님.
    fn private_bytes(&self) -> &[u8] {
        &self.private
    }
}

impl Drop for StaticKeypair {
    fn drop(&mut self) {
        // 개인키 메모리 소거 — drop 후 잔상 0(RustCrypto zeroize). 공개키는 비밀 아님.
        self.private.zeroize();
    }
}

impl std::fmt::Debug for StaticKeypair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 개인키는 절대 Debug 로 새지 않는다.
        f.debug_struct("StaticKeypair")
            .field("public", &"<32B x25519 public>")
            .field("private", &"<redacted>")
            .finish()
    }
}

// ===========================================================================
// 2. PinnedPeerRegistry — 핀닝된 상대 static 공개키(TOFU + revoke)
// ===========================================================================

/// 핀닝된 상대 1대의 레코드.
#[derive(Debug, Clone)]
struct PinnedPeer {
    /// TOFU 로 핀닝된 상대의 X25519 정적 **공개**키. 조용히 교체 0.
    pinned_public: [u8; X25519_KEY_LEN],
    /// active/revoked.
    revoked: bool,
}

/// 핀닝 위반/revoke 사유 — 페어링 단계 에러(핸드셰이크와 분리).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PinError {
    /// 동일 peer_id 가 **다른** 키로 재핀닝 시도 — TOFU 위반(조용한 키 교체 차단).
    KeyMismatch,
    /// 공개키 바이트가 유효한 X25519 점이 아님(전부 0 = identity 류).
    InvalidKey,
}

/// 핀닝된 상대 static 공개키의 단일 권위. 핸드셰이크는 이 레지스트리를 통해서만 시작/응답된다.
///
/// fail-closed: 미핀닝/revoked ⇒ 핸드셰이크 미성립(채널 비-생성). 키 핀닝은 TOFU —
/// 같은 id 를 다른 키로 재핀닝하면 KeyMismatch(조용한 교체 0). revoke 는 즉시 차단.
#[derive(Debug, Default)]
pub struct PinnedPeerRegistry {
    peers: std::collections::HashMap<String, PinnedPeer>,
}

impl PinnedPeerRegistry {
    pub fn new() -> Self {
        PinnedPeerRegistry {
            peers: std::collections::HashMap::new(),
        }
    }

    /// 상대 static 공개키 핀닝(TOFU). 페어링 시 1회.
    ///
    /// - 전부 0 인 공개키(identity/약키 류)는 InvalidKey.
    /// - 동일 peer_id 재핀닝: **같은 키면** 멱등(재활성 포함), **다른 키면** KeyMismatch(TOFU).
    pub fn pin(
        &mut self,
        peer_id: &str,
        public_key: &[u8; X25519_KEY_LEN],
    ) -> Result<(), PinError> {
        if *public_key == [0u8; X25519_KEY_LEN] {
            return Err(PinError::InvalidKey);
        }
        if let Some(existing) = self.peers.get_mut(peer_id) {
            if &existing.pinned_public != public_key {
                return Err(PinError::KeyMismatch); // 조용한 키 교체 0.
            }
            // 같은 키 — 멱등(재활성).
            existing.revoked = false;
            return Ok(());
        }
        self.peers.insert(
            peer_id.to_string(),
            PinnedPeer {
                pinned_public: *public_key,
                revoked: false,
            },
        );
        Ok(())
    }

    /// revoke(deactivate) — kill-switch. 이후 그 peer 의 핸드셰이크는 미성립. 미상이면 false.
    pub fn revoke(&mut self, peer_id: &str) -> bool {
        match self.peers.get_mut(peer_id) {
            Some(p) => {
                p.revoked = true;
                true
            }
            None => false,
        }
    }

    /// 활성 핀닝 여부 — 등록 + not revoked.
    pub fn is_pinned(&self, peer_id: &str) -> bool {
        matches!(self.peers.get(peer_id), Some(p) if !p.revoked)
    }

    /// 핸드셰이크에 쓸 핀닝 공개키를 돌려준다 — 미핀닝/revoked 면 Err(채널 미성립의 1차 게이트).
    fn resolve_pinned(&self, peer_id: &str) -> Result<[u8; X25519_KEY_LEN], NoiseError> {
        match self.peers.get(peer_id) {
            None => Err(NoiseError::UnpinnedPeer),
            Some(p) if p.revoked => Err(NoiseError::PeerRevoked),
            Some(p) => Ok(p.pinned_public),
        }
    }
}

// ===========================================================================
// 3. Handshake — KK, 인증-우선-연결(fail-closed). 핀닝된 상대와만 성립.
// ===========================================================================

/// 진행 중인 KK 핸드셰이크의 절반(initiator 또는 responder). snow 의 HandshakeState 를 감싸
/// 메시지 펌프(write/read) 를 노출하고, 완료 시에만 NoiseChannel 로 봉인한다.
///
/// **인증-우선-연결**: 생성자(initiate/respond)가 핀닝된 상대 static 공개키를 **요구**한다.
/// 미핀닝/revoked 면 생성 자체가 Err(채널의 씨앗조차 안 생긴다). 틀린 키를 핀닝값처럼 넘겨도
/// KK 의 정적-정적 바인딩이 상대의 실제 키와 안 맞아 DH/MAC 이 깨지고 핸드셰이크가 완료 불가.
pub struct Handshake {
    state: HandshakeState,
    is_initiator: bool,
}

impl Handshake {
    /// initiator 측 핸드셰이크를 시작한다. `local` 의 개인키로 서명하고, **핀닝된** 상대
    /// static 공개키(`remote_peer_id` 로 레지스트리 조회)에 바인딩한다.
    ///
    /// fail-closed: `remote_peer_id` 가 미핀닝/revoked 면 Err(UnpinnedPeer/PeerRevoked) —
    /// 핸드셰이크 객체가 생성되지 않는다(연결의 시작점 미성립).
    pub fn initiate(
        local: &StaticKeypair,
        registry: &PinnedPeerRegistry,
        remote_peer_id: &str,
    ) -> Result<Handshake, NoiseError> {
        let remote_static = registry.resolve_pinned(remote_peer_id)?;
        let state = build_kk(local, &remote_static, true)?;
        Ok(Handshake {
            state,
            is_initiator: true,
        })
    }

    /// responder 측 핸드셰이크를 준비한다. 동일하게 핀닝된 상대 static 공개키를 요구한다
    /// (mutual: 응답자도 발신자의 키를 핀닝해야 한다 — KK 양측 정적키 사전공지).
    pub fn respond(
        local: &StaticKeypair,
        registry: &PinnedPeerRegistry,
        remote_peer_id: &str,
    ) -> Result<Handshake, NoiseError> {
        let remote_static = registry.resolve_pinned(remote_peer_id)?;
        let state = build_kk(local, &remote_static, false)?;
        Ok(Handshake {
            state,
            is_initiator: false,
        })
    }

    /// 다음 핸드셰이크 메시지를 생성한다(payload 없음). 반환 = 전송할 바이트.
    pub fn write_message(&mut self) -> Result<Vec<u8>, NoiseError> {
        let mut buf = vec![0u8; 65535];
        let n = self
            .state
            .write_message(&[], &mut buf)
            .map_err(|_| NoiseError::HandshakeFailed)?;
        buf.truncate(n);
        Ok(buf)
    }

    /// 들어온 핸드셰이크 메시지를 처리한다. **틀린 static 키 ⇒ 여기서 HandshakeFailed**
    /// (KK 의 DH/MAC 불일치). 즉 미상/불일치 키는 채널로 못 간다.
    pub fn read_message(&mut self, msg: &[u8]) -> Result<(), NoiseError> {
        let mut buf = vec![0u8; 65535];
        self.state
            .read_message(msg, &mut buf)
            .map_err(|_| NoiseError::HandshakeFailed)?;
        Ok(())
    }

    /// 핸드셰이크가 완료됐는가(양측 메시지 교환 끝).
    pub fn is_finished(&self) -> bool {
        self.state.is_handshake_finished()
    }

    /// 완료된 핸드셰이크를 암호 채널로 봉인한다. **미완이면 Err**(미완 채널 0).
    ///
    /// 전환 시 snow 가 HandshakeState(임시키 보유)를 소비하고 TransportState(임시 비밀
    /// 미보유, 파생 대칭키만)를 낸다 → ephemeral private 잔상 0(PFS-b). 이 봉인 외에
    /// NoiseChannel 을 만들 경로가 없다(평문/미인증 생성자 0 — 다운그레이드/우회 0).
    pub fn into_channel(self) -> Result<NoiseChannel, NoiseError> {
        if !self.state.is_handshake_finished() {
            return Err(NoiseError::HandshakeIncomplete);
        }
        let transport = self
            .state
            .into_transport_mode()
            .map_err(|_| NoiseError::HandshakeIncomplete)?;
        Ok(NoiseChannel { transport })
    }

    /// 상대가 핸드셰이크에서 제시한 static 공개키(KK 라 핀닝값과 같아야 정상). 감사/단언용.
    pub fn remote_static(&self) -> Option<[u8; X25519_KEY_LEN]> {
        self.state.get_remote_static().and_then(|s| {
            if s.len() == X25519_KEY_LEN {
                let mut out = [0u8; X25519_KEY_LEN];
                out.copy_from_slice(s);
                Some(out)
            } else {
                None
            }
        })
    }
}

/// KK HandshakeState 를 빌드한다 — 패턴 상수는 NOISE_PATTERN 한 곳만(다운그레이드 표면 0).
/// 로컬 개인키 + 상대 static 공개키(둘 다 KK 필수)를 주입한다.
fn build_kk(
    local: &StaticKeypair,
    remote_static: &[u8; X25519_KEY_LEN],
    initiator: bool,
) -> Result<HandshakeState, NoiseError> {
    let params = NOISE_PATTERN
        .parse()
        .map_err(|_| NoiseError::HandshakeSetup)?;
    // snow 0.9: local_private_key / remote_public_key 는 Builder 를 직접 반환(Result 아님).
    // 키 유효성은 build_* 단계에서 검증된다(잘못된 키 ⇒ build 실패).
    let builder = Builder::new(params)
        .local_private_key(local.private_bytes())
        .remote_public_key(remote_static);
    let state = if initiator {
        builder.build_initiator()
    } else {
        builder.build_responder()
    };
    // build 실패 = 키 형식 불량 또는 패턴 불일치 ⇒ 채널 미성립.
    state.map_err(|_| NoiseError::HandshakeSetup)
}

// ===========================================================================
// 4. NoiseChannel — 성립된 AEAD 채널(encrypt/decrypt). 미인증 생성자 0.
// ===========================================================================

/// 핸드셰이크 성공 후의 암호 채널. ChaCha20-Poly1305 AEAD 로 encrypt/decrypt 하며 nonce/
/// counter 는 Noise(TransportState)가 메시지마다 관리한다.
///
/// **유일 생성 경로 = Handshake::into_channel**(완료된 KK 핸드셰이크). 평문/미인증 생성자가
/// 없으므로(다운그레이드/백도어 0), 채널이 존재한다는 사실 자체가 상호 인증 + PFS 성립의 증거다.
///
/// PFS(구조적·정직): TransportState 는 핸드셰이크에서 파생한 **대칭** 키만 보유한다 —
/// ephemeral private(x/y)은 핸드셰이크 종료 시 snow 가 폐기. 이 채널에서 static 개인키를
/// 꺼내 과거 세션키를 재구성할 길이 없다(채널에 ephemeral private 미보유 — PFS-c).
pub struct NoiseChannel {
    transport: TransportState,
}

impl NoiseChannel {
    /// 평문 → ciphertext(ChaCha20-Poly1305 AEAD). nonce/counter 는 Noise 가 자동 증가.
    /// 릴레이/포워더는 이 출력만 보며, 평문 바이트는 들어있지 않다(zero-knowledge — 테스트 단언).
    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, NoiseError> {
        let mut buf = vec![0u8; plaintext.len() + 16 + 64]; // +16 AEAD tag, 여유.
        let n = self
            .transport
            .write_message(plaintext, &mut buf)
            .map_err(|_| NoiseError::Buffer)?;
        buf.truncate(n);
        Ok(buf)
    }

    /// ciphertext → 평문. **변조/재생/순서뒤바뀜(재사용 counter) ⇒ Err(Decrypt)**,
    /// 절대 garbage plaintext 를 반환하지 않는다(AEAD auth 실패 = fail-closed).
    pub fn decrypt(&mut self, ciphertext: &[u8]) -> Result<Vec<u8>, NoiseError> {
        let mut buf = vec![0u8; ciphertext.len() + 64];
        let n = self
            .transport
            .read_message(ciphertext, &mut buf)
            .map_err(|_| NoiseError::Decrypt)?;
        buf.truncate(n);
        Ok(buf)
    }

    /// 현재 송신 nonce(counter) — 감사/단언용. 메시지마다 단조 증가.
    pub fn sending_nonce(&self) -> u64 {
        self.transport.sending_nonce()
    }

    /// 현재 수신 nonce(counter).
    pub fn receiving_nonce(&self) -> u64 {
        self.transport.receiving_nonce()
    }
}

impl std::fmt::Debug for NoiseChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 대칭키 잔상이 Debug 로 새지 않게 한다.
        f.debug_struct("NoiseChannel")
            .field("transport", &"<noise transport state>")
            .finish()
    }
}

#[cfg(test)]
mod tests;
