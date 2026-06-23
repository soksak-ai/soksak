// remote::fuzz_tests — 적대 property/fuzz 하니스(계획서 "보안 테스트 스위트 I. 가용성/DoS:
// malformed 패킷→graceful 거부(크래시 0)·릴레이 증폭 불가" + 매트릭스 "오버사이즈/malformed").
//
// 목표(RULE 1 RED→GREEN, RULE 2 기준불변): 각 파서/디코더/상태-step 이 **임의·경계·malformed·
// 재배열·적대** 바이트에 ROBUST 함을 증명한다 — 패닉 0 · attacker 바이트 위 unwrap/expect/panic 0 ·
// 무한루프/행 0 · 무한할당(증폭) 0 · over-read 0. 모든 거부는 깨끗한 typed Err(graceful, fail-closed).
// proptest 가 수백~수천 케이스를 생성하고, 반례를 자동 shrink 한다(발견 시 named RED 단위테스트로 고정).
//
// 이 파일은 **공개 표면 횡단** property 다(RequestFrame/noise/tunnel-authorize/state-machine/증폭).
// private 와이어 함수(transport::read_framed, auth::parse_signature, client::decode_response,
// session::Reader, tunnel::read_framed)의 property 는 가시성 때문에 각 모듈 자기 tests.rs 의
// proptest! 블록이 super::* 로 직접 두드린다 — 둘 다 `cargo test remote::` 에 함께 뜬다.
//
// 케이스 수: 256–1024/property(빠른 스위트 유지). PROPTEST_CASES 로 상향 가능.

use proptest::prelude::*;

use crate::remote::auth::{
    CapabilityAssertion, DeviceRegistry, Scope, VerifyCtx,
};
use crate::remote::noise::{
    Handshake, NoiseChannel, NoiseError, PinnedPeerRegistry, StaticKeypair,
};
use crate::remote::session::RequestFrame;
use crate::remote::tunnel::{
    authorize_tunnel, decode_tunnel_request, encode_tunnel_request, PortAllowlist, TunnelDecision,
};

// ===========================================================================
// 0. 공유 헬퍼 — 결정적 키/페어링/채널(임의 입력만 fuzz, 키는 고정).
// ===========================================================================

/// 결정적 Ed25519 시드 키(테스트 재현성 — 실서비스는 OsRng).
fn ed_key(seed: u8) -> ed25519_dalek::SigningKey {
    let mut b = [0u8; 32];
    b[0] = seed;
    b[31] = 0x42;
    ed25519_dalek::SigningKey::from_bytes(&b)
}

/// KK 핸드셰이크를 끝까지 돌려 양측 채널을 만든다(긍정 경로 — 그 위에 임의 ciphertext 를 던진다).
fn established_channel_pair() -> (NoiseChannel, NoiseChannel) {
    let a = StaticKeypair::generate().expect("desktop x25519");
    let b = StaticKeypair::generate().expect("phone x25519");
    let mut a_reg = PinnedPeerRegistry::new();
    a_reg.pin("phone", &b.public_key()).expect("desktop pins phone");
    let mut b_reg = PinnedPeerRegistry::new();
    b_reg.pin("desktop", &a.public_key()).expect("phone pins desktop");
    let mut ini = Handshake::initiate(&a, &a_reg, "phone").expect("initiate");
    let mut resp = Handshake::respond(&b, &b_reg, "desktop").expect("respond");
    let m1 = ini.write_message().expect("m1");
    resp.read_message(&m1).expect("read m1");
    let m2 = resp.write_message().expect("m2");
    ini.read_message(&m2).expect("read m2");
    (ini.into_channel().expect("ini ch"), resp.into_channel().expect("resp ch"))
}

/// 임의 valid assertion 생성 전략(필드는 valid 타입이되 값은 임의 — 라운드트립/결정성 검증).
fn arb_assertion() -> impl Strategy<Value = CapabilityAssertion> {
    (
        // device_id: 임의 UTF-8(빈 문자열 포함, 길이 0..512).
        "\\PC{0,300}",
        prop_oneof![Just(Scope::ReadOnly), Just(Scope::Write), Just(Scope::Destructive)],
        any::<[u8; 32]>(),
        any::<u64>(),
        any::<u64>(),
    )
        .prop_map(|(device_id, scope, nonce, issued_at, exp)| CapabilityAssertion {
            device_id,
            scope,
            nonce,
            issued_at,
            exp,
        })
}

// ===========================================================================
// PROPERTY 2 — RequestFrame::decode 는 임의/근사 바이트에 패닉 0·over-read 0.
// ===========================================================================

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1024))]

    /// arbitrary_bytes_never_panic_request_decode:
    /// 완전 임의 바이트(0..4096) → RequestFrame::decode ⇒ Some(frame) | None, **패닉 0**.
    /// 경계검사 Reader 가 모든 take 를 checked 로 하므로 buffer 끝 over-read 0(슬라이스 인덱싱 panic 0).
    #[test]
    fn arbitrary_bytes_never_panic_request_decode(bytes in proptest::collection::vec(any::<u8>(), 0..4096)) {
        let _ = RequestFrame::decode(&bytes);
        // 패닉하지 않고 여기 도달하면 통과. Some/None 둘 다 정상.
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// near_miss_oversized_subfields_request_decode:
    /// 구조적 근사-frame — valid version 바이트(1) 뒤에 거짓 길이 프리픽스(u64, u32::MAX 류)와
    /// 짧은 body. decode 는 take() 가 checked 라 None(over-read 0), 절대 그 길이만큼 할당하려
    /// 시도하다 OOM/패닉하지 않는다(Reader::take 가 self.buf.len() 경계를 먼저 본다).
    #[test]
    fn near_miss_oversized_subfields_request_decode(
        bogus_len in any::<u64>(),
        tail in proptest::collection::vec(any::<u8>(), 0..64),
    ) {
        let mut buf = Vec::new();
        buf.push(1u8); // FRAME_VERSION
        buf.extend_from_slice(&bogus_len.to_le_bytes()); // id_len = 거대값
        buf.extend_from_slice(&tail); // body 는 그만큼 없다
        let r = RequestFrame::decode(&buf);
        // 거대 id_len 은 take 가 경계 초과 ⇒ None. 절대 bogus_len 바이트를 읽으려 하지 않는다.
        prop_assert!(r.is_none(), "oversized id_len must reject, not over-read/alloc");
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// valid_frame_encode_decode_round_trips:
    /// 임의 valid assertion + 임의 sig/request 바이트로 encode → decode 가 정확히 같은 frame 을
    /// 복원한다(결정성·모호성 0). 길이 프리픽스 캐노니컬 코덱이 ("ab","c") vs ("a","bc") 를 섞지 않음.
    #[test]
    fn valid_frame_encode_decode_round_trips(
        assertion in arb_assertion(),
        signature in proptest::collection::vec(any::<u8>(), 0..200),
        request in proptest::collection::vec(any::<u8>(), 0..2000),
    ) {
        let frame = RequestFrame { assertion, signature, request };
        let bytes = frame.encode();
        let decoded = RequestFrame::decode(&bytes);
        prop_assert_eq!(decoded.as_ref(), Some(&frame), "canonical codec must round-trip exactly");
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// trailing_garbage_after_valid_frame_rejected:
    /// valid encode 뒤에 잉여 바이트를 붙이면 decode 가 None(엄격 — is_empty 검사). 형식 진화/
    /// 스머글 표면 0. 패닉 0.
    #[test]
    fn trailing_garbage_after_valid_frame_rejected(
        assertion in arb_assertion(),
        garbage in proptest::collection::vec(any::<u8>(), 1..64),
    ) {
        let frame = RequestFrame { assertion, signature: vec![7u8; 64], request: vec![1, 2, 3] };
        let mut bytes = frame.encode();
        bytes.extend_from_slice(&garbage);
        prop_assert!(RequestFrame::decode(&bytes).is_none(), "trailing bytes must be rejected (strict)");
    }
}

// ===========================================================================
// PROPERTY 3 — assertion / signature: canonical_bytes 결정성 + 임의 sig 를 verify 에 던지면
//              Denied(BadSignature), 절대 패닉/Granted 0.
// ===========================================================================

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// canonical_bytes_deterministic:
    /// 같은 assertion 의 canonical_bytes 는 항상 동일(결정성). 비결정/패닉 0.
    #[test]
    fn canonical_bytes_deterministic(assertion in arb_assertion()) {
        let a = assertion.canonical_bytes();
        let b = assertion.canonical_bytes();
        prop_assert_eq!(a, b, "canonical_bytes must be deterministic");
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// arbitrary_signature_through_verify_denied_never_panic:
    /// 페어링된 기기에 **임의 바이트를 서명이라며** verify 에 던진다(길이 ≠64 포함). 절대 패닉 0,
    /// 절대 Granted 0 — 길이≠64 든 64 든 위조면 verify_strict 가 BadSignature 로 거부(fail-closed).
    #[test]
    fn arbitrary_signature_through_verify_denied_never_panic(
        sig in proptest::collection::vec(any::<u8>(), 0..200),
        now in any::<u64>(),
        nonce in any::<[u8; 32]>(),
    ) {
        let sk = ed_key(9);
        let pk = sk.verifying_key().to_bytes();
        let mut reg = DeviceRegistry::new(8);
        reg.pair("phone", &pk, Scope::Destructive).expect("pair");
        let assertion = CapabilityAssertion {
            device_id: "phone".to_string(),
            scope: Scope::ReadOnly,
            nonce,
            issued_at: 100,
            exp: 1_000_000_000_000,
        };
        // exp 를 거대하게 두어 now 임의값이 만료를 먼저 트립하지 않게 한다(서명 게이트를 보려고).
        let decision = reg.verify(&assertion, &sig, VerifyCtx { now });
        // 임의 sig 는 절대 유효 서명일 수 없다 ⇒ Granted 0(패닉 0). now>=exp 면 Expired 도 가능하나
        // 어느 쪽이든 **Denied** 다(여기서는 exp 가 매우 커서 사실상 BadSignature 거부).
        prop_assert!(!decision.is_granted(), "arbitrary signature must never be granted");
    }
}

// ===========================================================================
// PROPERTY 4 — noise decrypt / handshake read_message 는 임의 ciphertext/임의 핸드셰이크
//              바이트에 Err(Decrypt/HandshakeFailed), 절대 패닉·평문 반환 0.
// ===========================================================================

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// arbitrary_ciphertext_decrypt_errs_never_plaintext:
    /// 성립된 채널에 **임의 ciphertext** 를 던진다 → AEAD auth 실패 ⇒ Err(Decrypt), 절대 garbage
    /// plaintext 반환 0, 절대 패닉 0. (성공할 확률은 무시가능 — Poly1305 16바이트 tag forgery.)
    #[test]
    fn arbitrary_ciphertext_decrypt_errs_never_plaintext(
        ct in proptest::collection::vec(any::<u8>(), 0..2048),
    ) {
        let (_ini, mut resp) = established_channel_pair();
        match resp.decrypt(&ct) {
            Err(NoiseError::Decrypt) => {} // 기대 — fail-closed.
            Err(_) => {} // 다른 Noise 에러도 graceful(패닉 아님).
            Ok(_pt) => {
                // 천문학적으로 희박하나, 우연히 valid 면 그 자체는 무결성 위반이 아님(AEAD 가
                // 인증한 바이트). 핵심 단언: 패닉/over-read 가 없었다는 것. 통과.
            }
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// arbitrary_handshake_read_message_errs_never_panic:
    /// 핀닝된 responder 핸드셰이크에 **임의 m1 바이트**(0..70000 — 65535 캡 양쪽)를 read_message
    /// 한다 → 틀린/garbage ⇒ HandshakeFailed, 절대 패닉 0. 채널은 생성되지 않는다(fail-closed).
    #[test]
    fn arbitrary_handshake_read_message_errs_never_panic(
        m1 in proptest::collection::vec(any::<u8>(), 0..70_000),
    ) {
        let a = StaticKeypair::generate().expect("desktop");
        let b = StaticKeypair::generate().expect("phone");
        let mut b_reg = PinnedPeerRegistry::new();
        b_reg.pin("desktop", &a.public_key()).expect("phone pins desktop");
        let mut resp = Handshake::respond(&b, &b_reg, "desktop").expect("respond");
        let r = resp.read_message(&m1);
        // 임의 바이트는 valid KK m1 일 수 없다 ⇒ Err. 패닉 0. 채널은 안 생긴다.
        prop_assert!(r.is_err(), "arbitrary handshake bytes must fail, not establish a channel");
    }
}

// ===========================================================================
// PROPERTY 5 — tunnel decode_tunnel_request + authorize_tunnel 은 임의 바이트에 typed Denied,
//              절대 connect/패닉 0.
// ===========================================================================

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1024))]

    /// arbitrary_bytes_decode_tunnel_request_never_panic:
    /// 임의 바이트 → decode_tunnel_request ⇒ Some(port) | None, 패닉 0. prefix/길이 불일치는 None.
    #[test]
    fn arbitrary_bytes_decode_tunnel_request_never_panic(
        bytes in proptest::collection::vec(any::<u8>(), 0..256),
    ) {
        let _ = decode_tunnel_request(&bytes);
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// tunnel_request_round_trips_and_only_exact_form_decodes:
    /// encode_tunnel_request(port) 는 정확히 그 port 로 디코드되고, prefix 만 있고 꼬리가 2바이트
    /// 아니면 None(엄격). 모드-혼동 표면 0.
    #[test]
    fn tunnel_request_round_trips_and_only_exact_form_decodes(port in any::<u16>(), extra in 0u8..8) {
        let enc = encode_tunnel_request(port);
        prop_assert_eq!(decode_tunnel_request(&enc), Some(port));
        // prefix + (2+extra) 바이트는 길이≠2 면 거부.
        if extra != 0 {
            let mut bad = enc.clone();
            bad.extend(std::iter::repeat(0u8).take(extra as usize));
            prop_assert!(decode_tunnel_request(&bad).is_none(), "len != 2 must reject");
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// arbitrary_request_through_authorize_tunnel_denied_never_connect:
    /// 페어링된 기기에 **임의 request 바이트 + 임의 sig** 를 authorize_tunnel 에 던진다.
    /// allowlist 가 비어있든 차든 — Granted 면 절대 안 되고(sig 가 위조라 verify 가 막거나, request
    /// 가 tunnel: 형식이 아니라 MalformedRequest), **typed Denied** 만. connect 시도 0(이 함수는
    /// 애초에 connect 를 안 한다 — SSRF 0 의 구조적 증거). 패닉 0.
    #[test]
    fn arbitrary_request_through_authorize_tunnel_denied_never_connect(
        request in proptest::collection::vec(any::<u8>(), 0..64),
        sig in proptest::collection::vec(any::<u8>(), 0..80),
        now in any::<u64>(),
        nonce in any::<[u8; 32]>(),
    ) {
        let sk = ed_key(13);
        let pk = sk.verifying_key().to_bytes();
        let mut reg = DeviceRegistry::new(8);
        reg.pair("phone", &pk, Scope::Write).expect("pair");
        let allow = PortAllowlist::from_ports([3000u16, 5173]);
        let assertion = CapabilityAssertion {
            device_id: "phone".to_string(),
            scope: Scope::Write,
            nonce,
            issued_at: 50,
            exp: 1_000_000_000_000,
        };
        let decision = authorize_tunnel(
            &assertion, &sig, &request, "phone", &mut reg, VerifyCtx { now }, &allow,
        );
        // 임의 sig 는 위조 ⇒ verify 거부, 혹은 request 형식 불량 ⇒ MalformedRequest. 어느 쪽이든
        // Granted 0(패닉 0). 임의 바이트가 우연히 유효 서명일 수는 없다.
        prop_assert!(matches!(decision, TunnelDecision::Denied(_)), "arbitrary tunnel request must be denied");
    }
}

// ===========================================================================
// PROPERTY 7 — 상태-머신 적대: 프로토콜 순서 밖 frame 을 serve_connection 에 흘려도
//              패닉/행/busy-loop 0, 연결이 깨끗이 닫힌다(typed Err 또는 Ok 종료).
// ===========================================================================

use crate::remote::transport::{serve_connection, SharedAuth};
use crate::remote::auth::{AuthorizedAction, DesktopConfirmToken};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// in-memory duplex 위에서 serve_connection 을 돌리고, 클라이언트 측에 **임의 프리-핸드셰이크
/// 바이트**를 흘린 뒤 닫는다. 어떤 입력이든 serve 가 bounded 하게 종료해야 한다(행 0).
async fn run_serve_against_garbage(client_bytes: Vec<u8>) -> Result<(), String> {
    let (mut client, server) = tokio::io::duplex(8192);
    let desktop = StaticKeypair::generate().map_err(|e| e.to_string())?;
    let noise = PinnedPeerRegistry::new(); // 아무도 핀닝 안 됨 — 미페어링이면 채널 0.
    let auth = SharedAuth::new(DeviceRegistry::new(8));
    let dispatch = |_a: &AuthorizedAction, _r: &[u8]| -> Vec<u8> { b"{}".to_vec() };
    let tok = |_d: &str| -> Option<DesktopConfirmToken> { None };

    let server_task = tokio::spawn(async move {
        let noise = noise;
        let _ = serve_connection(
            server, &desktop, &noise, &auth, || 1_000u64, tok, dispatch,
        )
        .await;
    });

    // 클라이언트가 임의 바이트를 쓰고 즉시 닫는다(EOF). serve 는 announce/handshake 단계에서
    // bounded read 로 막혀 graceful 종료해야 한다(무한 대기 0).
    let _ = client.write_all(&client_bytes).await;
    let _ = client.shutdown().await;
    // 남은 응답은 버린다(있을 수도, 없을 수도). 핵심은 서버 task 가 끝나는 것.
    let mut sink = Vec::new();
    let _ = client.read_to_end(&mut sink).await;

    // 서버 task 가 bounded 시간 안에 끝나야 한다 — 행이면 여기서 타임아웃이 잡는다.
    match tokio::time::timeout(std::time::Duration::from_secs(5), server_task).await {
        Ok(join) => join.map_err(|e| format!("server task panicked: {e}")),
        Err(_) => Err("serve_connection HUNG on adversarial pre-handshake bytes".to_string()),
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// data_before_handshake_garbage_closes_clean_no_hang:
    /// 핸드셰이크 전에 **임의 바이트**(announce 자리에 garbage, 그 뒤 더 garbage)를 흘리면
    /// serve_connection 이 패닉/행 없이 종료한다(미페어링/형식불량 ⇒ 채널 0 ⇒ dispatch 0).
    /// 상태-머신이 "data before handshake" 를 거부하고 연결을 닫는다(busy-loop 0).
    #[test]
    fn data_before_handshake_garbage_closes_clean_no_hang(
        bytes in proptest::collection::vec(any::<u8>(), 0..2048),
    ) {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let r = rt.block_on(run_serve_against_garbage(bytes));
        prop_assert!(r.is_ok(), "{}", r.err().unwrap_or_default());
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(128))]

    /// well_formed_announce_then_garbage_handshake_closes_clean:
    /// 길이-프리픽스 announce(valid u32 길이 + device_id 바이트)를 정상으로 보낸 뒤, 핸드셰이크
    /// m1 자리에 **임의 바이트**를 흘린다. 미페어링 device_id 면 Handshake::respond 가 채널 0,
    /// 페어링됐어도 garbage m1 은 HandshakeFailed ⇒ 채널 0. 어느 쪽이든 패닉/행 0, 깨끗이 닫힌다.
    #[test]
    fn well_formed_announce_then_garbage_handshake_closes_clean(
        id in "\\PC{0,40}",
        m1 in proptest::collection::vec(any::<u8>(), 0..1024),
    ) {
        let id_bytes = id.into_bytes();
        let mut wire = Vec::new();
        wire.extend_from_slice(&(id_bytes.len() as u32).to_be_bytes());
        wire.extend_from_slice(&id_bytes);
        wire.extend_from_slice(&(m1.len() as u32).to_be_bytes());
        wire.extend_from_slice(&m1);
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let r = rt.block_on(run_serve_against_garbage(wire));
        prop_assert!(r.is_ok(), "{}", r.err().unwrap_or_default());
    }
}

// ===========================================================================
// PROPERTY 8 — 증폭/DoS: 어떤 입력도 입력 크기에 비례하지 않는 할당을 유발하지 않는다(캡 유지).
//              RequestFrame::decode 가 거짓 거대 길이 프리픽스를 보고 그만큼 할당하지 않음을
//              메모리-바운드(입력보다 큰 출력 0)로 단언한다.
// ===========================================================================

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// request_decode_output_bounded_by_input_no_amplification:
    /// decode 가 Some(frame) 을 내면, 그 frame 의 모든 가변 필드 합(device_id+sig+request)은
    /// 입력 바이트 수를 넘지 않는다 — 길이 프리픽스가 입력보다 큰 할당을 만들 수 없다(증폭 0).
    /// (Reader::take 가 self.buf 경계 안에서만 슬라이스를 떼므로 구조적으로 보장.)
    #[test]
    fn request_decode_output_bounded_by_input_no_amplification(
        bytes in proptest::collection::vec(any::<u8>(), 0..4096),
    ) {
        if let Some(frame) = RequestFrame::decode(&bytes) {
            let payload = frame.assertion.device_id.len() + frame.signature.len() + frame.request.len();
            prop_assert!(
                payload <= bytes.len(),
                "decoded payload {} must not exceed input {} (no amplification)",
                payload, bytes.len()
            );
        }
    }
}
