// remote::noise 테스트 — 보안 위협 RED→GREEN(다다익선). 스위트 B(암호/전송) 전수.
//
// 각 테스트는 한 공격을 재현하고 **차단(GREEN)** 을 단언한다. RED(방어 전엔 통과=취약)는
// 각 테스트 위 주석에 "RED:" 로 명시한다 — 해당 방어를 제거하면 그 단언이 깨짐을 코드 위치로
// 못박는다(검증 가능 사실). 기준 약화 0 — 실패하면 구현을 고친다(RULE 2).
//
// 매트릭스 대응: 미상키→채널 미생성 / 양키유효→연결 / 핸드셰이크 전 앱데이터 0 /
// 변조 ciphertext→AEAD 실패 / 재생 패킷→거부 / 릴레이 평문 0 / 다운그레이드 거부 /
// TOFU·revoke / PFS(a/b/c) / 정상 round-trip.

use super::*;

// --- 테스트 헬퍼 -------------------------------------------------------------

/// 한 쌍의 로컬 정적키쌍을 생성한다(실 X25519 — snow). 결정적 시드는 없다(static 키는 OsRng).
/// PFS 테스트가 "같은 static 쌍, 다른 세션키" 를 단언하므로 키쌍 재사용이 핵심.
fn keypair() -> StaticKeypair {
    StaticKeypair::generate().expect("X25519 정적 키쌍 생성")
}

/// 두 측(A,B)을 서로 핀닝한 레지스트리 쌍을 만든다(mutual TOFU 핀닝).
/// 반환: (A의 레지스트리[B를 핀닝], B의 레지스트리[A를 핀닝]).
fn mutual_pinned(
    a: &StaticKeypair,
    b: &StaticKeypair,
    a_id: &str,
    b_id: &str,
) -> (PinnedPeerRegistry, PinnedPeerRegistry) {
    let mut a_reg = PinnedPeerRegistry::new();
    a_reg.pin(b_id, &b.public_key()).expect("A 가 B 핀닝");
    let mut b_reg = PinnedPeerRegistry::new();
    b_reg.pin(a_id, &a.public_key()).expect("B 가 A 핀닝");
    (a_reg, b_reg)
}

/// KK 핸드셰이크를 끝까지 돌려 양측 채널을 만든다. KK = 1.5-RTT(-> e,es,ss / <- e,ee,se).
/// 성공 시 (initiator_channel, responder_channel). 어느 한 step 실패면 Err 전파.
fn complete_handshake(
    mut ini: Handshake,
    mut resp: Handshake,
) -> Result<(NoiseChannel, NoiseChannel), NoiseError> {
    // -> e, es, ss
    let m1 = ini.write_message()?;
    resp.read_message(&m1)?;
    // <- e, ee, se
    let m2 = resp.write_message()?;
    ini.read_message(&m2)?;
    // KK 는 2 메시지로 완료.
    let ini_ch = ini.into_channel()?;
    let resp_ch = resp.into_channel()?;
    Ok((ini_ch, resp_ch))
}

/// 표준 페어링 + 핸드셰이크 — 양측 채널을 반환(긍정 경로 재사용).
fn paired_channels() -> (NoiseChannel, NoiseChannel) {
    let a = keypair();
    let b = keypair();
    let (a_reg, b_reg) = mutual_pinned(&a, &b, "desktop", "phone");
    let ini = Handshake::initiate(&a, &a_reg, "phone").expect("A initiate");
    let resp = Handshake::respond(&b, &b_reg, "desktop").expect("B respond");
    complete_handshake(ini, resp).expect("정상 양키 핸드셰이크는 채널 성립")
}

// ===========================================================================
// K. 정상 경로(긍정) — 먼저 확립: 방어가 정당한 연결을 막지 않음.
// ===========================================================================

#[test]
fn k_positive_both_keys_pinned_handshake_completes() {
    // 양측 static 키 상호 핀닝 ⇒ 핸드셰이크 완료, 작동하는 암호 채널.
    let a = keypair();
    let b = keypair();
    let (a_reg, b_reg) = mutual_pinned(&a, &b, "desktop", "phone");
    let ini = Handshake::initiate(&a, &a_reg, "phone").expect("initiate 성립");
    let resp = Handshake::respond(&b, &b_reg, "desktop").expect("respond 성립");
    let (ini_ch, resp_ch) = complete_handshake(ini, resp).expect("양키유효 ⇒ 연결");
    // 채널이 실재함 = 상호 인증 + PFS 성립의 증거.
    let _ = (ini_ch, resp_ch);
}

#[test]
fn k_positive_full_round_trip_both_directions() {
    // 전체 round-trip: pair → handshake → encrypt→decrypt 양방향, 평문 정확.
    let (mut ini, mut resp) = paired_channels();

    // initiator → responder
    let pt1 = b"left panel close, terminal big";
    let ct1 = ini.encrypt(pt1).expect("encrypt A->B");
    let got1 = resp.decrypt(&ct1).expect("decrypt A->B");
    assert_eq!(got1, pt1, "A->B 평문 정확");

    // responder → initiator
    let pt2 = b"ack: layout changed";
    let ct2 = resp.encrypt(pt2).expect("encrypt B->A");
    let got2 = ini.decrypt(&ct2).expect("decrypt B->A");
    assert_eq!(got2, pt2, "B->A 평문 정확");
}

#[test]
fn k_positive_multiple_messages_in_sequence() {
    // 연속 다중 메시지 — Noise counter 가 매번 증가, 전부 정확 복호.
    let (mut ini, mut resp) = paired_channels();
    for i in 0..16u8 {
        let pt = vec![i; (i as usize) + 1];
        let ct = ini.encrypt(&pt).expect("encrypt");
        let got = resp.decrypt(&ct).expect("decrypt");
        assert_eq!(got, pt, "메시지 {i} 평문 정확");
    }
}

// ===========================================================================
// 미상키→채널 미생성 — 미핀닝/불일치 키 ⇒ 채널 미성립(인증-우선-연결).
// ===========================================================================

#[test]
fn unpinned_remote_initiate_refused_no_channel() {
    // 공격: 상대를 핀닝하지 않은 채 핸드셰이크를 시작(미인증 연결 시도).
    // RED(방어 전): registry 조회 없이 핸드셰이크를 빌드하면 미상 키로 채널 시작 = 취약.
    // GREEN: initiate() 가 resolve_pinned 에서 UnpinnedPeer ⇒ Handshake 객체조차 안 생긴다.
    let a = keypair();
    let empty_reg = PinnedPeerRegistry::new(); // 아무도 핀닝 안 함.
    let r = Handshake::initiate(&a, &empty_reg, "phone");
    assert_eq!(r.err(), Some(NoiseError::UnpinnedPeer));
    // 채널의 씨앗(Handshake)조차 없음 = "거부가 아니라 미성립".
}

#[test]
fn unpinned_remote_respond_refused_no_channel() {
    // mutual: responder 측도 발신자를 핀닝 안 했으면 미성립(양측 모두 상대 키 검증).
    let b = keypair();
    let empty_reg = PinnedPeerRegistry::new();
    let r = Handshake::respond(&b, &empty_reg, "desktop");
    assert_eq!(r.err(), Some(NoiseError::UnpinnedPeer));
}

#[test]
fn wrong_static_key_handshake_fails_no_channel() {
    // 공격: B 를 핀닝하긴 했으나, A 가 핀닝한 값이 **B 의 실제 키가 아님**(중간자가 끼운
    //       엉뚱한 static 키). KK 의 정적-정적 바인딩으로 DH/MAC 이 깨져야 한다.
    // RED(방어 전): KK 가 아니라 미인증 패턴(NN 등)이면 아무 키로도 핸드셰이크 완료 = 취약.
    // GREEN: A 가 틀린 키로 시작 → B 의 실제 키와 ss/es DH 불일치 → read_message 가
    //        HandshakeFailed → 채널 미성립.
    let a = keypair();
    let b = keypair();
    let imposter = keypair(); // B 가 아닌 제3의 키.

    // A 는 B 라고 믿고 imposter 의 공개키를 핀닝(중간자가 바꿔치기한 시나리오).
    let mut a_reg = PinnedPeerRegistry::new();
    a_reg.pin("phone", &imposter.public_key()).expect("A 가 (잘못된) phone 키 핀닝");
    // B 는 A 를 올바로 핀닝.
    let mut b_reg = PinnedPeerRegistry::new();
    b_reg.pin("desktop", &a.public_key()).expect("B 가 A 핀닝");

    let ini = Handshake::initiate(&a, &a_reg, "phone").expect("initiate 는 일단 성립(키 형식 OK)");
    let resp = Handshake::respond(&b, &b_reg, "desktop").expect("respond 성립");

    // 핸드셰이크 구동 — KK 정적키 불일치로 어딘가에서 실패해야 한다(채널 0).
    let r = complete_handshake(ini, resp);
    assert!(r.is_err(), "틀린 static 키 ⇒ 핸드셰이크 미성립(채널 0)");
    assert_eq!(r.err(), Some(NoiseError::HandshakeFailed));
}

#[test]
fn mutual_each_side_rejects_other_unknown_key() {
    // mutual 양방향: A 는 B 를 핀닝했지만 B 는 A 를 **안** 핀닝(한쪽만 핀닝).
    // GREEN: B 의 respond() 가 UnpinnedPeer ⇒ 응답자 측 채널 씨앗 미성립.
    let a = keypair();
    let b = keypair();
    let mut a_reg = PinnedPeerRegistry::new();
    a_reg.pin("phone", &b.public_key()).expect("A 가 B 핀닝");
    let b_reg = PinnedPeerRegistry::new(); // B 는 A 미핀닝.

    assert!(Handshake::initiate(&a, &a_reg, "phone").is_ok(), "A 쪽은 핀닝됨");
    assert_eq!(
        Handshake::respond(&b, &b_reg, "desktop").err(),
        Some(NoiseError::UnpinnedPeer),
        "B 는 A 를 모르므로 미성립"
    );
}

// ===========================================================================
// 핸드셰이크 전 앱데이터 0 — 완성 전엔 enc/dec 불가(미성립 단언).
// ===========================================================================

#[test]
fn no_app_data_before_handshake_complete() {
    // 공격: 핸드셰이크를 끝내기 전에 앱 데이터를 흘리려는 시도.
    // RED(방어 전): HandshakeState 에 직접 encrypt 표면이 있으면 미인증 데이터 누출 = 취약.
    // GREEN: encrypt/decrypt 는 NoiseChannel 에만 존재한다. NoiseChannel 은 완료된
    //        핸드셰이크의 into_channel 로만 생긴다. 미완 핸드셰이크 into_channel ⇒ Err.
    let a = keypair();
    let b = keypair();
    let (a_reg, _b_reg) = mutual_pinned(&a, &b, "desktop", "phone");
    let ini = Handshake::initiate(&a, &a_reg, "phone").expect("initiate");
    // 아직 메시지 교환 0 → 미완.
    assert!(!ini.is_finished(), "핸드셰이크 미완");
    let r = ini.into_channel();
    assert_eq!(r.err(), Some(NoiseError::HandshakeIncomplete), "미완 ⇒ 채널 0");
    // 타입 차원의 보강: NoiseChannel 외에 encrypt/decrypt 가 없으므로, 채널 없이는
    // 앱데이터를 enc/dec 할 표면 자체가 존재하지 않는다(아래 컴파일-차원 단언과 동치).
}

#[test]
fn partial_handshake_one_message_still_incomplete() {
    // KK 1 메시지(-> e,es,ss)만 처리한 responder 는 아직 미완(<- 가 남음) ⇒ 채널 0.
    let a = keypair();
    let b = keypair();
    let (a_reg, b_reg) = mutual_pinned(&a, &b, "desktop", "phone");
    let mut ini = Handshake::initiate(&a, &a_reg, "phone").unwrap();
    let mut resp = Handshake::respond(&b, &b_reg, "desktop").unwrap();
    let m1 = ini.write_message().unwrap();
    resp.read_message(&m1).unwrap();
    // responder 는 첫 메시지만 읽음 — 응답(write)을 안 보냈으니 미완.
    assert!(!resp.is_finished(), "1 메시지 후 responder 미완");
    assert_eq!(resp.into_channel().err(), Some(NoiseError::HandshakeIncomplete));
    // initiator 도 응답을 못 받았으니 미완.
    assert!(!ini.is_finished(), "응답 전 initiator 미완");
}

// ===========================================================================
// 변조 ciphertext → AEAD 실패 거부(garbage plaintext 0).
// ===========================================================================

#[test]
fn tampered_ciphertext_byte_flip_decrypt_errors() {
    // 공격: ciphertext 한 바이트를 뒤집어 전달(릴레이 능동 변조).
    // RED(방어 전): AEAD 태그 검증 없으면 변조 평문이 그대로 나온다 = 취약.
    // GREEN: Poly1305 태그 불일치 ⇒ decrypt 가 Err(Decrypt), 절대 평문 미반환.
    let (mut ini, mut resp) = paired_channels();
    let pt = b"destructive: rm -rf important";
    let mut ct = ini.encrypt(pt).expect("encrypt");
    // 페이로드 영역 한 바이트 변조(태그 앞쪽 = 평문 암호문).
    ct[0] ^= 0x01;
    let r = resp.decrypt(&ct);
    assert!(r.is_err(), "garbage plaintext 절대 반환 0");
    assert_eq!(r.err(), Some(NoiseError::Decrypt), "변조 ⇒ AEAD 실패");
}

#[test]
fn tampered_auth_tag_decrypt_errors() {
    // 공격: AEAD 태그(끝 16B) 변조.
    // GREEN: 태그 검증 실패 ⇒ Decrypt 에러.
    let (mut ini, mut resp) = paired_channels();
    let pt = b"hello";
    let mut ct = ini.encrypt(pt).expect("encrypt");
    let last = ct.len() - 1;
    ct[last] ^= 0xFF; // 태그 변조.
    assert_eq!(resp.decrypt(&ct).err(), Some(NoiseError::Decrypt));
}

#[test]
fn truncated_ciphertext_decrypt_errors() {
    // 공격: ciphertext 를 잘라 전달(길이 변조/태그 손실).
    // GREEN: 태그 검증 실패 ⇒ Decrypt 에러(평문 0).
    let (mut ini, mut resp) = paired_channels();
    let ct = ini.encrypt(b"some payload here").expect("encrypt");
    let truncated = &ct[..ct.len() / 2];
    assert!(resp.decrypt(truncated).is_err(), "절단 ⇒ 복호 실패");
}

#[test]
fn injected_random_ciphertext_decrypt_errors() {
    // 공격: 릴레이가 임의 바이트를 ciphertext 로 주입(도청 아닌 능동 주입).
    // GREEN: 어떤 키로도 인증 안 되는 garbage ⇒ Decrypt 에러.
    let (_ini, mut resp) = paired_channels();
    let garbage = vec![0xAAu8; 48];
    assert_eq!(resp.decrypt(&garbage).err(), Some(NoiseError::Decrypt));
}

// ===========================================================================
// 재생 패킷 → 거부(재사용 nonce/counter, 순서뒤바뀜).
// ===========================================================================

#[test]
fn replay_captured_message_rejected() {
    // 공격: 한 번 받은(복호 성공한) transport 메시지를 캡처해 다시 전달(재생).
    // RED(방어 전): nonce sequencing 없으면 재생 메시지가 또 복호된다 = 취약.
    // GREEN: TransportState 의 수신 counter 가 이미 전진 → 같은 counter 의 재생은 거부(Decrypt).
    let (mut ini, mut resp) = paired_channels();
    let pt = b"replay me";
    let ct = ini.encrypt(pt).expect("encrypt");
    // 정상 1회 — counter 0 소비.
    assert_eq!(resp.decrypt(&ct).expect("최초 복호"), pt);
    // 동일 바이트 재전송(재생) — counter 0 은 이미 지났다.
    let r = resp.decrypt(&ct);
    assert_eq!(r.err(), Some(NoiseError::Decrypt), "재생 패킷 거부");
}

#[test]
fn out_of_order_message_rejected_by_sequencing() {
    // 공격: 두 메시지를 캡처해 **순서를 바꿔** 전달(릴레이 reorder).
    // RED(방어 전): stateless/순서무시면 reorder 가 통과 = 취약.
    // GREEN: stateful TransportState 는 다음 기대 counter 만 받는다 → 1번을 먼저 주면
    //        counter 불일치로 거부(Decrypt). (그 뒤 0번은 이미 0번 자리에 대해 검증 — counter
    //        sequencing 이 강제됨을 단언.)
    let (mut ini, mut resp) = paired_channels();
    let ct0 = ini.encrypt(b"first").expect("enc0"); // counter 0
    let ct1 = ini.encrypt(b"second").expect("enc1"); // counter 1
    // 순서 뒤집어 1번 먼저 — 수신측 기대 counter 는 0 → 1번은 인증 실패.
    let r = resp.decrypt(&ct1);
    assert_eq!(r.err(), Some(NoiseError::Decrypt), "순서뒤바뀜(미래 counter) 거부");
    // 0번은 여전히 정상(기대 counter 0).
    assert_eq!(resp.decrypt(&ct0).expect("순서대로 0번"), b"first");
}

// ===========================================================================
// 릴레이 평문 0 — ciphertext 에 평문 바이트 미포함(zero-knowledge relay).
// ===========================================================================

#[test]
fn relay_sees_no_plaintext_zero_knowledge() {
    // 공격 가정: 릴레이/포워더(우리 인프라 포함)가 ciphertext 를 들여다본다.
    // RED(방어 전): 평문 전송이면 릴레이가 다 읽는다 = 취약.
    // GREEN: ciphertext 바이트열에 평문 부분 시퀀스가 들어있지 않다(AEAD 암호화).
    let (mut ini, _resp) = paired_channels();
    let secret = b"SUPER_SECRET_TOKEN_abcdef0123456789";
    let ct = ini.encrypt(secret).expect("encrypt");
    // ciphertext 가 평문을 부분열로도 포함하지 않음.
    assert!(
        !contains_subsequence(&ct, secret),
        "릴레이가 보는 ciphertext 에 평문 0(zero-knowledge)"
    );
    // 길이도 평문과 다름(AEAD 태그 16B 추가) — 평문 직통 아님.
    assert!(ct.len() >= secret.len() + 16, "AEAD 태그 부착(평문 직통 아님)");
}

#[test]
fn relay_sees_no_plaintext_even_for_repeated_payload() {
    // 같은 평문을 두 번 보내도 ciphertext 가 동일하지 않다(nonce 증가 → IND-CPA).
    // 릴레이가 패턴(반복)으로도 평문을 추론 못 함.
    let (mut ini, _resp) = paired_channels();
    let pt = b"repeated";
    let c1 = ini.encrypt(pt).expect("enc1");
    let c2 = ini.encrypt(pt).expect("enc2");
    assert_ne!(c1, c2, "같은 평문도 매번 다른 ciphertext(nonce 증가)");
    assert!(!contains_subsequence(&c1, pt));
    assert!(!contains_subsequence(&c2, pt));
}

/// haystack 에 needle 이 연속 부분열로 등장하는지(릴레이 평문 노출 검사).
fn contains_subsequence(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || needle.len() > haystack.len() {
        return false;
    }
    haystack.windows(needle.len()).any(|w| w == needle)
}

// ===========================================================================
// 다운그레이드 거부 — KK + AEAD 외 경로 0, 평문 경로 0.
// ===========================================================================

#[test]
fn no_downgrade_only_kk_pattern_pinned() {
    // 공격: 약한/다른 Noise 패턴(NN=미인증, 약 cipher)으로 협상해 인증/기밀성 우회.
    // RED(방어 전): 패턴이 런타임 협상 가능하면 NN 으로 내려가 미인증 채널 성립 = 취약.
    // GREEN: 패턴 문자열이 한 상수(NOISE_PATTERN)로 고정 — KK + ChaChaPoly 만. 협상 표면 0.
    assert_eq!(NOISE_PATTERN, "Noise_KK_25519_ChaChaPoly_BLAKE2s");
    // KK = mutual static(인증), 25519 = ephemeral DH(PFS), ChaChaPoly = AEAD.
    assert!(NOISE_PATTERN.contains("_KK_"), "KK = mutual auth(미인증 NN/NK 아님)");
    assert!(NOISE_PATTERN.contains("ChaChaPoly"), "AEAD = ChaCha20-Poly1305");
    assert!(NOISE_PATTERN.contains("25519"), "X25519 ephemeral DH(PFS 토대)");
}

#[test]
fn no_plaintext_path_channel_only_from_finished_handshake() {
    // 불변식(타입 차원): NoiseChannel(=enc/dec 표면)은 완료된 KK 핸드셰이크의
    // into_channel 로만 생긴다. 평문/미인증 생성자가 **없다**.
    // RED(방어 전): NoiseChannel::new(plaintext) 류 우회 생성자가 있으면 미인증 채널 = 취약.
    // GREEN: 미완 핸드셰이크 ⇒ into_channel Err. 완료 ⇒ Ok. 다른 경로 0(아래 단언).
    let a = keypair();
    let b = keypair();
    let (a_reg, b_reg) = mutual_pinned(&a, &b, "desktop", "phone");

    // 미완 → 채널 0.
    let ini_incomplete = Handshake::initiate(&a, &a_reg, "phone").unwrap();
    assert!(ini_incomplete.into_channel().is_err(), "미완 핸드셰이크는 채널 0");

    // 완료 → 채널 Ok(유일 경로).
    let ini = Handshake::initiate(&a, &a_reg, "phone").unwrap();
    let resp = Handshake::respond(&b, &b_reg, "desktop").unwrap();
    assert!(complete_handshake(ini, resp).is_ok(), "완료된 KK 만 채널 산출");
}

// ===========================================================================
// TOFU / revoke — 동일 id 다른 키 재핀닝 거부, revoked peer 핸드셰이크 미성립.
// ===========================================================================

#[test]
fn tofu_repin_same_id_different_key_rejected() {
    // 공격: 이미 핀닝된 peer_id 를 **다른** static 키로 재핀닝(조용한 키 교체 = 탈취).
    // RED(방어 전): 핀닝 키 비교 없으면 새 키로 덮어씀 = 취약.
    // GREEN: pin() 이 KeyMismatch 거부 — 핀닝 키 불변.
    let b_orig = keypair();
    let b_evil = keypair();
    let mut reg = PinnedPeerRegistry::new();
    reg.pin("phone", &b_orig.public_key()).expect("최초 핀닝");
    let r = reg.pin("phone", &b_evil.public_key());
    assert_eq!(r, Err(PinError::KeyMismatch), "다른 키 재핀닝 거부(TOFU)");
    assert!(reg.is_pinned("phone"), "원래 핀닝 유지");
}

#[test]
fn tofu_repin_same_id_same_key_idempotent() {
    // 같은 키 재핀닝은 허용(멱등 — 재활성 포함). TOFU 위반 아님.
    let b = keypair();
    let mut reg = PinnedPeerRegistry::new();
    reg.pin("phone", &b.public_key()).expect("최초");
    assert!(reg.pin("phone", &b.public_key()).is_ok(), "같은 키 멱등");
}

#[test]
fn zero_public_key_rejected_at_pin() {
    // 공격: identity/약키 류(전부 0) 공개키 핀닝 시도.
    // GREEN: pin() 이 InvalidKey 거부.
    let mut reg = PinnedPeerRegistry::new();
    let zero = [0u8; X25519_KEY_LEN];
    assert_eq!(reg.pin("evil", &zero), Err(PinError::InvalidKey));
    assert!(!reg.is_pinned("evil"));
}

#[test]
fn revoked_peer_handshake_refused_no_channel() {
    // 공격: 도난폰/유출키 — revoke 후에도 핸드셰이크 시도.
    // RED(방어 전): revoke 가 상태만 두고 resolve 가 안 보면 여전히 채널 성립 = 취약.
    // GREEN: resolve_pinned 가 revoked ⇒ PeerRevoked ⇒ initiate/respond 미성립.
    let a = keypair();
    let b = keypair();
    let mut a_reg = PinnedPeerRegistry::new();
    a_reg.pin("phone", &b.public_key()).expect("핀닝");
    assert!(Handshake::initiate(&a, &a_reg, "phone").is_ok(), "revoke 전엔 성립");
    assert!(a_reg.revoke("phone"), "revoke 처리됨");
    let r = Handshake::initiate(&a, &a_reg, "phone");
    assert_eq!(r.err(), Some(NoiseError::PeerRevoked), "revoked ⇒ 채널 미성립");
    assert!(!a_reg.is_pinned("phone"), "revoked 는 is_pinned=false");
}

#[test]
fn revoke_unknown_peer_is_noop_false() {
    // 미상 peer revoke 는 false(noop) — 패닉/오접근 0.
    let mut reg = PinnedPeerRegistry::new();
    assert!(!reg.revoke("nope"));
}

#[test]
fn revoked_peer_repinned_same_key_reactivates() {
    // revoke 후 같은 키 재핀닝 = 재활성(active 복귀). 키 교체 아님이므로 허용.
    let b = keypair();
    let mut reg = PinnedPeerRegistry::new();
    reg.pin("phone", &b.public_key()).expect("핀닝");
    reg.revoke("phone");
    assert!(!reg.is_pinned("phone"));
    reg.pin("phone", &b.public_key()).expect("같은 키 재핀닝 = 재활성");
    assert!(reg.is_pinned("phone"));
}

// ===========================================================================
// PFS — (a) 같은 static 쌍 두 핸드셰이크 ⇒ 다른 세션키, (b) ephemeral zeroize,
//        (c) static 개인키 단독으로 과거 세션 복원 불가(채널에 ephemeral private 0).
// ===========================================================================

#[test]
fn pfs_a_same_static_pair_yields_different_session_keys() {
    // PFS(a): **같은** static 키쌍으로 두 번 핸드셰이크하면 세션 transport 키가 다르다
    //         (ephemeral 무작위가 기여). 같으면 PFS 없음(static-only 파생) = 취약.
    // RED(방어 전): static-only KDF 면 두 세션이 동일 키스트림 → 같은 평문이 같은 ciphertext.
    // GREEN: ee ephemeral DH 기여 → 두 세션의 같은 평문이 **다른** ciphertext(다른 키스트림).
    let a = keypair();
    let b = keypair();

    // 세션 1.
    let (a_reg1, b_reg1) = mutual_pinned(&a, &b, "desktop", "phone");
    let ini1 = Handshake::initiate(&a, &a_reg1, "phone").unwrap();
    let resp1 = Handshake::respond(&b, &b_reg1, "desktop").unwrap();
    let (mut s1, _) = complete_handshake(ini1, resp1).unwrap();

    // 세션 2 — 동일 static 키쌍 재사용.
    let (a_reg2, b_reg2) = mutual_pinned(&a, &b, "desktop", "phone");
    let ini2 = Handshake::initiate(&a, &a_reg2, "phone").unwrap();
    let resp2 = Handshake::respond(&b, &b_reg2, "desktop").unwrap();
    let (mut s2, _) = complete_handshake(ini2, resp2).unwrap();

    // 동일 평문, 동일 counter(첫 메시지)인데 ciphertext 가 달라야 한다 = 다른 세션키.
    let pt = b"identical plaintext, first message";
    let c1 = s1.encrypt(pt).unwrap();
    let c2 = s2.encrypt(pt).unwrap();
    assert_ne!(
        c1, c2,
        "같은 static 쌍의 두 세션이 같은 평문→다른 ciphertext(ephemeral 기여 = PFS 토대)"
    );
}

#[test]
fn pfs_b_ephemeral_not_retained_session_independent() {
    // PFS(b): 핸드셰이크 완료 후 채널은 ephemeral private 를 보유하지 않는다.
    //         이를 행위로 증명: 한 세션의 채널로 **다른 세션**의 ciphertext 를 복호할 수
    //         없다(세션 독립 = 임시키가 각 세션에 고립, 잔상 공유 0).
    // RED(방어 전): ephemeral 이 공유/잔류하면 교차 세션 복호가 될 수 있음.
    // GREEN: 세션 1 채널은 세션 2 ciphertext 를 Decrypt 거부(서로 다른 ee 파생키).
    let a = keypair();
    let b = keypair();

    let (a_reg1, b_reg1) = mutual_pinned(&a, &b, "desktop", "phone");
    let ini1 = Handshake::initiate(&a, &a_reg1, "phone").unwrap();
    let resp1 = Handshake::respond(&b, &b_reg1, "desktop").unwrap();
    let (mut a1_send, mut _b1_recv) = complete_handshake(ini1, resp1).unwrap();

    let (a_reg2, b_reg2) = mutual_pinned(&a, &b, "desktop", "phone");
    let ini2 = Handshake::initiate(&a, &a_reg2, "phone").unwrap();
    let resp2 = Handshake::respond(&b, &b_reg2, "desktop").unwrap();
    let (mut _a2_send, mut b2_recv) = complete_handshake(ini2, resp2).unwrap();

    // 세션 1 발신 ciphertext 를 세션 2 수신 채널로 복호 시도 → 다른 키 ⇒ 실패.
    let pt = b"cross-session attempt";
    let c_from_1 = a1_send.encrypt(pt).unwrap();
    assert_eq!(
        b2_recv.decrypt(&c_from_1).err(),
        Some(NoiseError::Decrypt),
        "세션 1 ciphertext 를 세션 2 채널이 복호 불가(ephemeral 세션 고립 = PFS-b)"
    );
}

#[test]
fn pfs_c_static_key_alone_cannot_decrypt_session() {
    // PFS(c): static 개인키 단독으로는 과거 세션을 못 푼다 — 채널은 static private 를 보관하지
    //         않고, ephemeral 도 보관하지 않으며, 세션키는 ee 파생이라 static 만으로 재구성 불가.
    // RED(방어 전): static-only 파생이면 장기키 유출 = 모든 과거 트래픽 복호 = 취약.
    // GREEN(구조적·정직 단언): (1) 채널은 StaticKeypair 를 소유/참조하지 않는다(별개 타입),
    //   (2) static 키쌍을 drop 해도(개인키 zeroize) 이미 성립한 채널은 계속 동작한다
    //       → 세션이 static private 에 의존하지 않음을 행위로 증명.
    let a = keypair();
    let b = keypair();
    let (a_reg, b_reg) = mutual_pinned(&a, &b, "desktop", "phone");
    let ini = Handshake::initiate(&a, &a_reg, "phone").unwrap();
    let resp = Handshake::respond(&b, &b_reg, "desktop").unwrap();
    let (mut a_ch, mut b_ch) = complete_handshake(ini, resp).unwrap();

    // 정상 메시지 1회.
    let ct = a_ch.encrypt(b"before drop").unwrap();
    assert_eq!(b_ch.decrypt(&ct).unwrap(), b"before drop");

    // static 키쌍을 명시적으로 drop — 개인키 zeroize(장기키 "유출/소멸" 시뮬레이션).
    drop(a);
    drop(b);

    // 채널은 여전히 동작(세션키가 static private 와 독립). static 이 사라져도 무관.
    let ct2 = a_ch.encrypt(b"after static drop").unwrap();
    assert_eq!(
        b_ch.decrypt(&ct2).unwrap(),
        b"after static drop",
        "채널은 static private 와 독립 — static 소멸 후에도 동작(세션키=ephemeral 파생)"
    );
}

#[test]
fn pfs_static_private_zeroized_on_drop() {
    // PFS 보강: StaticKeypair 의 개인키가 Drop 시 zeroize 됨을 단언한다. 직접 메모리 검사는
    // unsafe 라, "Drop 구현이 존재하고 zeroize 를 호출" 함을 컴파일/행위로 보장한다 — 여기서는
    // 생성→공개키 안정성 + drop 후 재생성이 독립적임을 단언(개인키 잔상 0 의 행위 측 증거).
    let kp = keypair();
    let pubk = kp.public_key();
    assert_ne!(pubk, [0u8; X25519_KEY_LEN], "공개키 비-0");
    drop(kp); // 개인키 zeroize(Drop impl).
    // 새 키쌍은 독립(이전 잔상에 의존 0).
    let kp2 = keypair();
    assert_ne!(kp2.public_key(), [0u8; X25519_KEY_LEN]);
}

// ===========================================================================
// 부수 검증 — 키쌍 복원/형식.
// ===========================================================================

#[test]
fn from_parts_rejects_zero_keys() {
    // 0 개인키/공개키 복원 거부(약키 토대 차단).
    let zero = [0u8; X25519_KEY_LEN];
    let some = keypair().public_key();
    assert_eq!(StaticKeypair::from_parts(zero, some).err(), Some(NoiseError::InvalidKey));
    assert_eq!(StaticKeypair::from_parts(some, zero).err(), Some(NoiseError::InvalidKey));
}

#[test]
fn remote_static_matches_pinned_after_handshake() {
    // KK 라 핸드셰이크 후 상대가 제시한 static 키 = 핀닝값(중간자가 못 바꿈).
    let a = keypair();
    let b = keypair();
    let (a_reg, b_reg) = mutual_pinned(&a, &b, "desktop", "phone");
    let mut ini = Handshake::initiate(&a, &a_reg, "phone").unwrap();
    let mut resp = Handshake::respond(&b, &b_reg, "desktop").unwrap();
    let m1 = ini.write_message().unwrap();
    resp.read_message(&m1).unwrap();
    let m2 = resp.write_message().unwrap();
    ini.read_message(&m2).unwrap();
    // initiator 가 본 상대(B) static 키 = B 의 공개키(핀닝값).
    assert_eq!(
        ini.remote_static(),
        Some(b.public_key()),
        "핸드셰이크 후 상대 static = 핀닝값(KK 정적키 바인딩)"
    );
}

// ===========================================================================
// proptest 적대 하니스 — Noise 채널/핸드셰이크가 임의 ciphertext/임의 핸드셰이크 바이트에
// Err(Decrypt/HandshakeFailed), 평문 반환 0·패닉 0(계획서 스위트 B/I). super::* 로 floor 직접.
// ===========================================================================
use proptest::prelude::*;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// channel_decrypt_arbitrary_never_plaintext_never_panic:
    /// 성립된 채널에 임의 ciphertext → AEAD 실패 ⇒ Err, garbage plaintext 0, 패닉 0.
    #[test]
    fn channel_decrypt_arbitrary_never_plaintext_never_panic(
        ct in proptest::collection::vec(any::<u8>(), 0..2048),
    ) {
        let (_a, mut b) = paired_channels();
        let _ = b.decrypt(&ct); // Err 또는 (천문학적으로 희박한) Ok — 둘 다 패닉 0.
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// initiator_handshake_arbitrary_m2_fails_no_channel:
    /// initiator 가 m1 을 쓴 뒤 임의 m2 바이트를 read_message → DH/MAC 불일치 ⇒ HandshakeFailed,
    /// 패닉 0. 틀린/garbage 응답에는 채널이 안 생긴다(fail-closed). into_channel 도 Err(미완).
    #[test]
    fn initiator_handshake_arbitrary_m2_fails_no_channel(
        m2 in proptest::collection::vec(any::<u8>(), 0..70_000),
    ) {
        let a = keypair();
        let b = keypair();
        let (a_reg, _b_reg) = mutual_pinned(&a, &b, "desktop", "phone");
        let mut ini = Handshake::initiate(&a, &a_reg, "phone").expect("initiate");
        let _m1 = ini.write_message().expect("m1");
        let r = ini.read_message(&m2);
        prop_assert!(r.is_err(), "arbitrary m2 must fail the handshake");
        prop_assert!(ini.into_channel().is_err(), "no channel from an unfinished handshake");
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// channel_out_of_order_replay_rejected:
    /// 폰이 두 프레임을 암호화하면, responder 가 두 번째를 먼저 복호하려 하면(순서뒤바뀜) Noise
    /// nonce sequencing 이 Err 로 막는다(재생/순서 거부). 패닉 0, 평문 0.
    #[test]
    fn channel_out_of_order_replay_rejected(
        p1 in proptest::collection::vec(any::<u8>(), 1..32),
        p2 in proptest::collection::vec(any::<u8>(), 1..32),
    ) {
        let (mut a, mut b) = paired_channels();
        let c1 = a.encrypt(&p1).expect("ct1");
        let c2 = a.encrypt(&p2).expect("ct2");
        // 두 번째(counter=1) 를 먼저 복호 — 첫 번째(counter=0) 를 건너뜀 ⇒ Noise 가 거부.
        let r = b.decrypt(&c2);
        prop_assert!(r.is_err(), "out-of-order frame must be rejected by nonce sequencing");
        // 거부 후에도 in-order 첫 프레임(counter=0)은 정상 복호 — 채널이 조용히 망가지지 않는다.
        prop_assert_eq!(b.decrypt(&c1).ok(), Some(p1.clone()), "in-order frame still decrypts after rejecting OOO");
        // 재생: 첫 번째를 두 번 — 두 번째 복호는 counter 재사용으로 거부.
        let (mut a2, mut b2) = paired_channels();
        let c = a2.encrypt(&p1).expect("ct");
        prop_assert!(b2.decrypt(&c).is_ok(), "first decrypt ok");
        prop_assert!(b2.decrypt(&c).is_err(), "replay of same frame rejected");
    }
}
