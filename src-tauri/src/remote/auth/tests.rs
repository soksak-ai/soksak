// remote::auth 테스트 — 보안 위협 RED→GREEN(다다익선). 매트릭스 + 스위트 A/C/F/G.
//
// 각 테스트는 한 공격을 재현하고 **차단(GREEN)** 을 단언한다. RED(방어 전엔 통과=취약)는
// 각 테스트 위 주석에 "RED:" 로 명시한다 — 해당 방어 라인을 제거하면 그 단언이 깨짐을
// 코드 위치로 못박는다(검증 가능 사실). 기준 약화 0 — 실패하면 구현을 고친다.

use super::*;
use ed25519_dalek::{Signer, SigningKey};

// --- 테스트 키/assertion 헬퍼 -------------------------------------------------

/// 결정적 시드로 SigningKey 생성(테스트 재현성). 실서비스는 OsRng — 여기선 시드 고정.
fn signing_key(seed: u8) -> SigningKey {
    let mut bytes = [0u8; 32];
    bytes[0] = seed;
    bytes[31] = 0x42; // 0 시드 회피.
    SigningKey::from_bytes(&bytes)
}

fn pub_bytes(sk: &SigningKey) -> [u8; 32] {
    sk.verifying_key().to_bytes()
}

fn nonce(tag: u8) -> [u8; 32] {
    let mut n = [0u8; 32];
    n[0] = tag;
    n[15] = 0xAB;
    n
}

/// 주어진 키로 서명된 assertion + 분리 서명(64B) 생성.
fn signed(
    sk: &SigningKey,
    device_id: &str,
    scope: Scope,
    nonce_bytes: [u8; 32],
    issued_at: u64,
    exp: u64,
) -> (CapabilityAssertion, Vec<u8>) {
    let a = CapabilityAssertion {
        device_id: device_id.to_string(),
        scope,
        nonce: nonce_bytes,
        issued_at,
        exp,
    };
    let sig = sk.sign(&a.canonical_bytes());
    (a, sig.to_bytes().to_vec())
}

fn ctx(now: u64) -> VerifyCtx {
    VerifyCtx { now }
}

/// 표준 페어링된 레지스트리: device "phone-1", read-only, key=seed1. 헬퍼.
fn paired_readonly() -> (DeviceRegistry, SigningKey) {
    let sk = signing_key(1);
    let mut reg = DeviceRegistry::new(2);
    reg.pair("phone-1", &pub_bytes(&sk), Scope::ReadOnly).unwrap();
    (reg, sk)
}

// ===========================================================================
// K. 정상 경로(긍정) — 먼저 확립: 방어가 정당한 접근을 막지 않음.
// ===========================================================================

#[test]
fn k_positive_paired_readonly_in_scope_granted() {
    // 페어링 read-only 기기 + 신선 nonce + in-scope ⇒ Granted{read-only}, confirm 불요.
    let (mut reg, sk) = paired_readonly();
    let (a, sig) = signed(&sk, "phone-1", Scope::ReadOnly, nonce(1), 100, 1000);
    let d = reg.verify(&a, &sig, ctx(200));
    let g = d.granted().expect("정상 read-only 는 Granted 여야 함");
    assert_eq!(g.scope(), Scope::ReadOnly);
    assert!(!g.requires_desktop_confirm(), "read-only 는 confirm 불요");
    assert_eq!(g.consumed_nonce(), nonce(1), "nonce 가 봉인에 실제 소비됨");
}

#[test]
fn k_positive_destructive_grant_requires_desktop_confirm() {
    // 명시적 destructive-grant 기기 ⇒ Granted 이되 RequiresDesktopConfirm(자동 X).
    let sk = signing_key(2);
    let mut reg = DeviceRegistry::new(2);
    reg.pair("phone-d", &pub_bytes(&sk), Scope::Destructive).unwrap();
    let (a, sig) = signed(&sk, "phone-d", Scope::Destructive, nonce(2), 100, 1000);
    let d = reg.verify(&a, &sig, ctx(200));
    let g = d.granted().expect("destructive-grant 기기는 Granted");
    assert_eq!(g.scope(), Scope::Destructive);
    assert!(
        g.requires_desktop_confirm(),
        "destructive 는 절대 자동 grant 아님 — confirm 요구 필수"
    );
    let req = g.desktop_confirm().unwrap();
    assert_eq!(req.device_id(), "phone-d");
    assert_eq!(req.bound_nonce(), nonce(2));
}

#[test]
fn k_positive_write_device_in_scope_granted_no_confirm() {
    // write 기기가 read-only 요청(하위 scope) ⇒ Granted{read-only}, confirm 불요.
    let sk = signing_key(3);
    let mut reg = DeviceRegistry::new(2);
    reg.pair("phone-w", &pub_bytes(&sk), Scope::Write).unwrap();
    let (a, sig) = signed(&sk, "phone-w", Scope::ReadOnly, nonce(3), 100, 1000);
    let d = reg.verify(&a, &sig, ctx(200));
    let g = d.granted().expect("write 기기의 read-only 요청은 Granted");
    assert_eq!(g.scope(), Scope::ReadOnly);
    assert!(!g.requires_desktop_confirm());
}

// ===========================================================================
// A. 미페어링 접근 — 미등록 기기 ⇒ Denied.
// ===========================================================================

#[test]
fn a_unpaired_device_denied() {
    // 공격: 등록된 적 없는 기기가 (자기 키로 올바르게 서명된) assertion 전송.
    // RED(방어 전): 기기 조회 없이 서명만 보면 통과 ⇒ 미상 기기 grant. 취약.
    // GREEN: verify() (1) 페어링 검사가 UnknownDevice 로 거부.
    let mut reg = DeviceRegistry::new(2);
    let sk = signing_key(9);
    let (a, sig) = signed(&sk, "ghost", Scope::ReadOnly, nonce(1), 100, 1000);
    let d = reg.verify(&a, &sig, ctx(200));
    assert_eq!(d.denied(), Some(&DenyReason::UnknownDevice));
    assert!(!d.is_granted(), "미페어링은 0 접근");
}

#[test]
fn a_unpaired_does_not_consume_nonce() {
    // 미페어링 거부는 nonce 를 소비하지 않는다(DoS/오염 0) — 같은 nonce 가
    // 나중 정상 페어링 후 여전히 신선해야 한다.
    let mut reg = DeviceRegistry::new(2);
    let sk = signing_key(9);
    let (a, sig) = signed(&sk, "ghost", Scope::ReadOnly, nonce(7), 100, 1000);
    assert!(reg.verify(&a, &sig, ctx(200)).denied().is_some());
    // 이제 같은 nonce 로 페어링 기기가 — 신선해야 통과.
    reg.pair("ghost", &pub_bytes(&sk), Scope::ReadOnly).unwrap();
    let d = reg.verify(&a, &sig, ctx(200));
    assert!(d.is_granted(), "거부된 시도가 nonce 를 태우면 안 됨");
}

// ===========================================================================
// A/C. 위조 assertion — 타키 서명 ⇒ verify_strict 거부.
// ===========================================================================

#[test]
fn a_forged_assertion_wrong_key_denied() {
    // 공격: 핀닝 키(seed1)와 다른 키(seed2)로 서명한, 형식상 유효한 assertion.
    // RED(방어 전): 서명을 검증 안 하거나 verify() 가 아무 키나 받으면 통과. 취약.
    // GREEN: verify_strict(핀닝 공개키, …) 가 BadSignature 로 거부.
    let (mut reg, _pinned) = paired_readonly(); // 핀 = seed1
    let attacker = signing_key(2); // 다른 키
    let (a, sig) = signed(&attacker, "phone-1", Scope::ReadOnly, nonce(1), 100, 1000);
    let d = reg.verify(&a, &sig, ctx(200));
    assert_eq!(d.denied(), Some(&DenyReason::BadSignature));
}

#[test]
fn a_tampered_payload_denied() {
    // 공격: 올바르게 서명한 뒤 payload(scope) 를 사후 변조 → 서명 불일치.
    // RED(방어 전): canonical_bytes 를 재계산 안 하거나 verify 생략 시 통과. 취약.
    // GREEN: 변조된 canonical_bytes 에 대해 서명이 깨져 BadSignature.
    let (mut reg, sk) = paired_readonly();
    let (mut a, sig) = signed(&sk, "phone-1", Scope::ReadOnly, nonce(1), 100, 1000);
    a.scope = Scope::Destructive; // 서명 후 변조(권한 상승 시도).
    let d = reg.verify(&a, &sig, ctx(200));
    assert_eq!(d.denied(), Some(&DenyReason::BadSignature));
}

#[test]
fn a_malformed_signature_length_denied() {
    // 공격: 64B 가 아닌 서명 바이트(형식 불량/잘림).
    // GREEN: parse_signature 가 None ⇒ BadSignature(형식불량=위조 취급).
    let (mut reg, sk) = paired_readonly();
    let (a, _sig) = signed(&sk, "phone-1", Scope::ReadOnly, nonce(1), 100, 1000);
    let d = reg.verify(&a, &[0u8; 10], ctx(200));
    assert_eq!(d.denied(), Some(&DenyReason::BadSignature));
}

#[test]
fn a_signature_for_different_assertion_denied() {
    // 공격: A assertion 서명을 떼어 B assertion(다른 nonce)에 붙임(서명 재사용).
    // GREEN: B 의 canonical_bytes 에 대해 서명 불일치 ⇒ BadSignature.
    let (mut reg, sk) = paired_readonly();
    let (_a1, sig1) = signed(&sk, "phone-1", Scope::ReadOnly, nonce(1), 100, 1000);
    let (a2, _sig2) = signed(&sk, "phone-1", Scope::ReadOnly, nonce(2), 100, 1000);
    let d = reg.verify(&a2, &sig1, ctx(200)); // a2 + sig1(불일치).
    assert_eq!(d.denied(), Some(&DenyReason::BadSignature));
}

// ===========================================================================
// C. weak/small-order key — from_bytes / verify_strict 거부.
// ===========================================================================

#[test]
fn c_weak_small_order_key_rejected_at_pairing() {
    // 공격: 소위수(small-order) 공개키를 핀닝 시도(약키 forgery 토대).
    // RED(방어 전): from_bytes 만 통과시키고 is_weak 검사를 안 하면 핀닝됨. 취약.
    // GREEN: pair() 가 from_bytes Result + is_weak 로 InvalidKey 거부.
    // small-order point: 모두 0(identity) 은 대표적 소위수 점.
    let mut reg = DeviceRegistry::new(2);
    let zero = [0u8; 32];
    let r = reg.pair("evil", &zero, Scope::ReadOnly);
    assert_eq!(r, Err(PairError::InvalidKey), "소위수/약키는 핀닝 거부");
    assert!(!reg.is_paired("evil"));
}

#[test]
fn c_malformed_key_bytes_rejected_at_pairing() {
    // 공격: Edwards 점으로 **복호 불가능한** 32B 로 핀닝 시도(곡선 밖 좌표).
    // RED(방어 전): from_bytes 의 Result 를 unwrap/무시하면 패닉 또는 garbage 키. 취약.
    // GREEN: VerifyingKey::from_bytes 가 Err("Cannot decompress Edwards point") ⇒ InvalidKey.
    // 검증된 입력: 첫 바이트 0x02 + 마지막 바이트 hi-bit(0x80) → 복호 실패(상단 probe 로 확인).
    let mut reg = DeviceRegistry::new(2);
    let mut bad = [0u8; 32];
    bad[0] = 0x02;
    bad[31] = 0x80;
    let r = reg.pair("evil2", &bad, Scope::ReadOnly);
    assert_eq!(r, Err(PairError::InvalidKey));
}

// ===========================================================================
// replay — nonce 단일사용 + 통째 재사용.
// ===========================================================================

#[test]
fn replay_reused_nonce_denied() {
    // 공격: 한 번 성공한 nonce 로 두 번째 assertion(같은 nonce, 다른 issued_at) 제출.
    // RED(방어 전): nonce 원장 없으면 두 번째도 통과 ⇒ 재생. 취약.
    // GREEN: 첫 verify 가 nonce 소비 → 두 번째는 NonceReplay 거부.
    let (mut reg, sk) = paired_readonly();
    let (a1, sig1) = signed(&sk, "phone-1", Scope::ReadOnly, nonce(5), 100, 1000);
    assert!(reg.verify(&a1, &sig1, ctx(200)).is_granted());
    // 같은 nonce 재사용(issued_at 만 증가 — 단조는 통과하지만 nonce 가 막아야).
    let (a2, sig2) = signed(&sk, "phone-1", Scope::ReadOnly, nonce(5), 101, 1000);
    let d = reg.verify(&a2, &sig2, ctx(200));
    assert_eq!(d.denied(), Some(&DenyReason::NonceReplay));
}

#[test]
fn replay_whole_prior_assertion_denied() {
    // 공격: 이전에 성공한 assertion **전체**(같은 서명·nonce·issued_at)를 그대로 재전송.
    // RED(방어 전): nonce 소비 안 하면 무한 재생. 취약.
    // GREEN: 두 번째는 NonceReplay(같은 nonce). (issued_at 동률이라 단조로도 막히지만,
    //        nonce 검사가 먼저 변이 경로에서 작동함을 단언.)
    let (mut reg, sk) = paired_readonly();
    let (a, sig) = signed(&sk, "phone-1", Scope::ReadOnly, nonce(6), 100, 1000);
    assert!(reg.verify(&a, &sig, ctx(200)).is_granted());
    let d = reg.verify(&a, &sig, ctx(200)); // 동일 assertion 통째 재생.
    assert_eq!(d.denied(), Some(&DenyReason::NonceReplay));
}

// ===========================================================================
// clock-rollback — issued_at 단조.
// ===========================================================================

#[test]
fn clock_rollback_older_issued_at_denied() {
    // 공격: issued_at 을 과거로(또는 동률) 되돌린 assertion(시계 되돌리기/옛것 재생).
    // RED(방어 전): 단조 워터마크 없으면 통과. 취약.
    // GREEN: issued_at <= last ⇒ ClockRollback.
    let (mut reg, sk) = paired_readonly();
    let (a1, sig1) = signed(&sk, "phone-1", Scope::ReadOnly, nonce(1), 500, 2000);
    assert!(reg.verify(&a1, &sig1, ctx(600)).is_granted()); // 워터마크 = 500.
    let (a2, sig2) = signed(&sk, "phone-1", Scope::ReadOnly, nonce(2), 400, 2000); // 과거.
    let d = reg.verify(&a2, &sig2, ctx(600));
    assert_eq!(d.denied(), Some(&DenyReason::ClockRollback));
}

#[test]
fn clock_equal_issued_at_fresh_nonce_allowed() {
    // 단조와 nonce 의 책임 분리: 동률(issued_at == last)이라도 **fresh nonce** 면 통과한다
    // — 같은 초의 distinct 액션은 정당(license doc Worker 순서 가드가 `>` 를 쓰는 이유와 동형).
    // 재생 차단은 nonce 의 몫(아래 테스트). 단조를 `<=` 로 만들면 정당한 동시각 액션이 깨진다.
    let (mut reg, sk) = paired_readonly();
    let (a1, sig1) = signed(&sk, "phone-1", Scope::ReadOnly, nonce(1), 500, 2000);
    assert!(reg.verify(&a1, &sig1, ctx(600)).is_granted());
    let (a2, sig2) = signed(&sk, "phone-1", Scope::ReadOnly, nonce(2), 500, 2000); // 동률, fresh nonce.
    assert!(reg.verify(&a2, &sig2, ctx(600)).is_granted(), "동시각 + fresh nonce 는 허용");
}

#[test]
fn clock_equal_issued_at_reused_nonce_denied_by_nonce_gate() {
    // 동률 + **reused nonce** = 통째 재생 → nonce 게이트가 NonceReplay 로 거부.
    // (단조가 아니라 nonce 가 재생을 잡는다 — 두 방어의 분리를 못박는다.)
    let (mut reg, sk) = paired_readonly();
    let (a, sig) = signed(&sk, "phone-1", Scope::ReadOnly, nonce(1), 500, 2000);
    assert!(reg.verify(&a, &sig, ctx(600)).is_granted());
    let d = reg.verify(&a, &sig, ctx(600)); // 동일 issued_at + 동일 nonce.
    assert_eq!(d.denied(), Some(&DenyReason::NonceReplay));
}

// ===========================================================================
// expiry — now >= exp.
// ===========================================================================

#[test]
fn expiry_expired_assertion_denied() {
    // 공격: exp 가 지난 assertion(만료 토큰).
    // RED(방어 전): freshness 검사 없으면 영구 유효. 취약.
    // GREEN: now >= exp ⇒ Expired.
    let (mut reg, sk) = paired_readonly();
    let (a, sig) = signed(&sk, "phone-1", Scope::ReadOnly, nonce(1), 100, 500);
    let d = reg.verify(&a, &sig, ctx(500)); // now == exp.
    assert_eq!(d.denied(), Some(&DenyReason::Expired));
    let d2 = reg.verify(&a, &sig, ctx(999)); // now > exp.
    assert_eq!(d2.denied(), Some(&DenyReason::Expired));
}

#[test]
fn expiry_boundary_now_just_below_exp_granted() {
    // 경계: now == exp-1 < exp ⇒ 아직 신선 ⇒ Granted(off-by-one 검증).
    let (mut reg, sk) = paired_readonly();
    let (a, sig) = signed(&sk, "phone-1", Scope::ReadOnly, nonce(1), 100, 500);
    let d = reg.verify(&a, &sig, ctx(499));
    assert!(d.is_granted());
}

// ===========================================================================
// max_devices — N+1 거부.
// ===========================================================================

#[test]
fn max_devices_n_plus_one_rejected() {
    // 공격: 한도(2)를 넘는 3번째 기기 바인딩(키 탈취 확산).
    // RED(방어 전): 한도 검사 없으면 무제한 바인딩. 취약.
    // GREEN: 3번째 pair() 가 CapacityExceeded.
    let mut reg = DeviceRegistry::new(2);
    reg.pair("d1", &pub_bytes(&signing_key(1)), Scope::ReadOnly).unwrap();
    reg.pair("d2", &pub_bytes(&signing_key(2)), Scope::ReadOnly).unwrap();
    let r = reg.pair("d3", &pub_bytes(&signing_key(3)), Scope::ReadOnly);
    assert_eq!(r, Err(PairError::CapacityExceeded));
    assert_eq!(reg.device_count(), 2);
    assert!(!reg.is_paired("d3"));
}

#[test]
fn max_devices_repair_existing_not_counted_as_new() {
    // 한도 도달 후 기존 기기 재페어링(같은 키)은 멱등 — 새 슬롯 아님(거부 안 됨).
    let mut reg = DeviceRegistry::new(2);
    let sk1 = signing_key(1);
    reg.pair("d1", &pub_bytes(&sk1), Scope::ReadOnly).unwrap();
    reg.pair("d2", &pub_bytes(&signing_key(2)), Scope::ReadOnly).unwrap();
    // d1 재페어링 — 한도 초과 아님.
    let r = reg.pair("d1", &pub_bytes(&sk1), Scope::Write);
    assert!(r.is_ok());
    assert_eq!(reg.device_count(), 2);
}

// ===========================================================================
// F. revoke — 도난폰/유출키 kill-switch.
// ===========================================================================

#[test]
fn f_revoked_device_denied_even_with_valid_sig_and_fresh_nonce() {
    // 공격: 도난폰. 유효 서명 + 신선 nonce + 미래 exp + 단조 OK 인 assertion 을
    //       revoke 이후 제출(refund/유출 후에도 동작 시도).
    // RED(방어 전): revoke 가 상태만 두고 verify 가 안 보면 여전히 통과. 취약.
    // GREEN: verify() 가 매 호출 state 재검사 ⇒ DeviceRevoked.
    let (mut reg, sk) = paired_readonly();
    assert!(reg.revoke("phone-1"), "revoke 처리됨");
    let (a, sig) = signed(&sk, "phone-1", Scope::ReadOnly, nonce(1), 100, 99999);
    let d = reg.verify(&a, &sig, ctx(200));
    assert_eq!(d.denied(), Some(&DenyReason::DeviceRevoked));
    assert!(!reg.is_paired("phone-1"), "revoked 는 is_paired=false");
}

#[test]
fn f_revoke_unknown_device_is_noop_false() {
    // 미상 기기 revoke 는 false(noop) — 패닉/오접근 0.
    let mut reg = DeviceRegistry::new(2);
    assert!(!reg.revoke("nope"));
}

#[test]
fn f_revoke_rechecked_every_call_not_just_connect() {
    // 매 호출 재검사: 첫 호출 성공 → revoke → 다음 호출(신선 nonce)도 거부.
    let (mut reg, sk) = paired_readonly();
    let (a1, sig1) = signed(&sk, "phone-1", Scope::ReadOnly, nonce(1), 100, 99999);
    assert!(reg.verify(&a1, &sig1, ctx(200)).is_granted());
    reg.revoke("phone-1");
    let (a2, sig2) = signed(&sk, "phone-1", Scope::ReadOnly, nonce(2), 101, 99999);
    let d = reg.verify(&a2, &sig2, ctx(200));
    assert_eq!(d.denied(), Some(&DenyReason::DeviceRevoked));
}

// ===========================================================================
// TOFU — 동일 id 다른 키 재페어링 거부.
// ===========================================================================

#[test]
fn tofu_repair_same_id_different_key_rejected() {
    // 공격: 이미 핀닝된 device_id 를 **다른 키**로 재페어링(조용한 키 교체 = 탈취).
    // RED(방어 전): 핀닝 키 비교 없으면 새 키로 덮어씀. 취약.
    // GREEN: pair() 가 KeyMismatch 거부 — 핀닝 키 불변.
    let sk_orig = signing_key(1);
    let sk_evil = signing_key(2);
    let mut reg = DeviceRegistry::new(2);
    reg.pair("phone-1", &pub_bytes(&sk_orig), Scope::ReadOnly).unwrap();
    let r = reg.pair("phone-1", &pub_bytes(&sk_evil), Scope::ReadOnly);
    assert_eq!(r, Err(PairError::KeyMismatch));
    // 원래 키는 여전히 유효, 교체 안 됨.
    let (a, sig) = signed(&sk_orig, "phone-1", Scope::ReadOnly, nonce(1), 100, 1000);
    assert!(reg.verify(&a, &sig, ctx(200)).is_granted());
    // evil 키는 여전히 위조로 거부.
    let (a2, sig2) = signed(&sk_evil, "phone-1", Scope::ReadOnly, nonce(2), 100, 1000);
    assert_eq!(reg.verify(&a2, &sig2, ctx(200)).denied(), Some(&DenyReason::BadSignature));
}

#[test]
fn tofu_repair_same_id_same_key_allowed_idempotent() {
    // 같은 키 재페어링은 허용(멱등 scope 갱신/재활성) — TOFU 위반 아님.
    let sk = signing_key(1);
    let mut reg = DeviceRegistry::new(2);
    reg.pair("phone-1", &pub_bytes(&sk), Scope::ReadOnly).unwrap();
    let r = reg.pair("phone-1", &pub_bytes(&sk), Scope::Write);
    assert!(r.is_ok(), "같은 키 재페어링 허용");
}

#[test]
fn tofu_revoked_device_reactivated_by_same_key_pair() {
    // revoke 후 같은 키 재페어링 = 재활성(active 복귀). 키 교체 아님이므로 허용.
    let sk = signing_key(1);
    let mut reg = DeviceRegistry::new(2);
    reg.pair("phone-1", &pub_bytes(&sk), Scope::ReadOnly).unwrap();
    reg.revoke("phone-1");
    assert!(!reg.is_paired("phone-1"));
    reg.pair("phone-1", &pub_bytes(&sk), Scope::ReadOnly).unwrap(); // 재활성.
    assert!(reg.is_paired("phone-1"));
}

// ===========================================================================
// C. scope escalation — read-only 가 destructive 요청 ⇒ 거부.
// ===========================================================================

#[test]
fn c_readonly_requesting_destructive_denied() {
    // 공격: read-only 부여 기기가 destructive scope 의 assertion(자기 키로 올바르게 서명).
    // RED(방어 전): scope 검사 없으면 destructive 통과 ⇒ 상승. 취약.
    // GREEN: scope ⊄ granted ⇒ ScopeEscalation.
    let (mut reg, sk) = paired_readonly(); // granted = read-only
    let (a, sig) = signed(&sk, "phone-1", Scope::Destructive, nonce(1), 100, 1000);
    let d = reg.verify(&a, &sig, ctx(200));
    assert_eq!(d.denied(), Some(&DenyReason::ScopeEscalation));
}

#[test]
fn c_readonly_requesting_write_denied() {
    // read-only 가 write 요청도 거부(격자 순위).
    let (mut reg, sk) = paired_readonly();
    let (a, sig) = signed(&sk, "phone-1", Scope::Write, nonce(1), 100, 1000);
    assert_eq!(reg.verify(&a, &sig, ctx(200)).denied(), Some(&DenyReason::ScopeEscalation));
}

#[test]
fn c_scope_rechecked_per_call_not_just_entry() {
    // 체인 시뮬레이션: 첫 step read-only(허용) → 같은 기기가 다음 step destructive 시도.
    // scope 는 매 호출 강제 → 두 번째(상승) step 만 거부, 진입 in-scope 였어도 무관.
    let (mut reg, sk) = paired_readonly();
    let (a1, sig1) = signed(&sk, "phone-1", Scope::ReadOnly, nonce(1), 100, 1000);
    assert!(reg.verify(&a1, &sig1, ctx(200)).is_granted(), "step1 in-scope 허용");
    let (a2, sig2) = signed(&sk, "phone-1", Scope::Destructive, nonce(2), 101, 1000);
    let d = reg.verify(&a2, &sig2, ctx(200));
    assert_eq!(d.denied(), Some(&DenyReason::ScopeEscalation), "step2 상승 거부");
}

#[test]
fn c_scope_escalation_does_not_consume_nonce() {
    // scope 거부는 변이 전에 일어남 → nonce 미소비. 같은 nonce 가 in-scope 요청엔 신선.
    let (mut reg, sk) = paired_readonly();
    let (a_bad, sig_bad) = signed(&sk, "phone-1", Scope::Destructive, nonce(8), 100, 1000);
    assert!(reg.verify(&a_bad, &sig_bad, ctx(200)).denied().is_some());
    // 같은 nonce, in-scope(read-only) — 신선해야.
    let (a_ok, sig_ok) = signed(&sk, "phone-1", Scope::ReadOnly, nonce(8), 100, 1000);
    assert!(reg.verify(&a_ok, &sig_ok, ctx(200)).is_granted(), "거부가 nonce 를 태우면 안 됨");
}

// ===========================================================================
// C. destructive ⇒ RequiresDesktopConfirm, 자동 Granted 아님.
// ===========================================================================

#[test]
fn c_destructive_never_auto_granted_carries_confirm() {
    // 공격: destructive 권한을 데스크톱 confirm 없이 자동 실행(폰이 데스크톱 권위 우회).
    // RED(방어 전): destructive 가 그냥 Granted{destructive} 로 끝나면 폰 직행. 취약.
    // GREEN: Granted 이되 requires_desktop_confirm() == true, 별도 토큰 없이는 실행 불가.
    let sk = signing_key(2);
    let mut reg = DeviceRegistry::new(2);
    reg.pair("phone-d", &pub_bytes(&sk), Scope::Destructive).unwrap();
    let (a, sig) = signed(&sk, "phone-d", Scope::Destructive, nonce(2), 100, 1000);
    let g = reg.verify(&a, &sig, ctx(200)).granted().map(|g| g.requires_desktop_confirm());
    // unwrap 으로 Granted 임을 확인하되, 핵심은 confirm 요구.
    assert_eq!(g, Some(true), "destructive 는 자동 grant 0, confirm 요구 필수");
}

#[test]
fn c_destructive_action_blocked_without_desktop_token() {
    // destructive Grant 를 실행 가능 액션으로 승격하려면 데스크톱 confirm 토큰 필수.
    // 토큰 없이 authorize ⇒ Err(DesktopConfirmRequired). 폰은 토큰 못 만든다.
    let sk = signing_key(2);
    let mut reg = DeviceRegistry::new(2);
    reg.pair("phone-d", &pub_bytes(&sk), Scope::Destructive).unwrap();
    let (a, sig) = signed(&sk, "phone-d", Scope::Destructive, nonce(2), 100, 1000);
    let decision = reg.verify(&a, &sig, ctx(200));
    let grant = decision.granted().unwrap();
    // 토큰 없음 ⇒ 거부.
    let r = AuthorizedAction::authorize(grant, None);
    assert_eq!(r.err(), Some(AuthorizeError::DesktopConfirmRequired));
}

#[test]
fn c_destructive_action_allowed_with_matching_desktop_token() {
    // 데스크톱 권위가 confirm 후 발급한 매칭 토큰(같은 device+nonce)이면 실행 승격 Ok.
    let sk = signing_key(2);
    let mut reg = DeviceRegistry::new(2);
    reg.pair("phone-d", &pub_bytes(&sk), Scope::Destructive).unwrap();
    let (a, sig) = signed(&sk, "phone-d", Scope::Destructive, nonce(2), 100, 1000);
    let decision = reg.verify(&a, &sig, ctx(200));
    let grant = decision.granted().unwrap();
    let token = DesktopConfirmToken::issue_after_desktop_confirm("phone-d", nonce(2));
    let action = AuthorizedAction::authorize(grant, Some(&token)).expect("매칭 토큰이면 Ok");
    assert_eq!(action.scope(), Scope::Destructive);
    assert_eq!(action.device_id(), "phone-d");
}

#[test]
fn c_destructive_token_for_wrong_nonce_rejected() {
    // 공격: 다른 액션(nonce)의 confirm 토큰을 destructive 에 재사용(confirm 결속 우회).
    // GREEN: bound_nonce 불일치 ⇒ ConfirmMismatch.
    let sk = signing_key(2);
    let mut reg = DeviceRegistry::new(2);
    reg.pair("phone-d", &pub_bytes(&sk), Scope::Destructive).unwrap();
    let (a, sig) = signed(&sk, "phone-d", Scope::Destructive, nonce(2), 100, 1000);
    let decision = reg.verify(&a, &sig, ctx(200));
    let grant = decision.granted().unwrap();
    // 토큰이 엉뚱한 nonce 에 결속.
    let token = DesktopConfirmToken::issue_after_desktop_confirm("phone-d", nonce(99));
    let r = AuthorizedAction::authorize(grant, Some(&token));
    assert_eq!(r.err(), Some(AuthorizeError::ConfirmMismatch));
}

#[test]
fn c_nondestructive_action_needs_no_confirm() {
    // read-only Grant 는 confirm 토큰 없이 바로 실행 승격(불필요한 마찰 0).
    let (mut reg, sk) = paired_readonly();
    let (a, sig) = signed(&sk, "phone-1", Scope::ReadOnly, nonce(1), 100, 1000);
    let decision = reg.verify(&a, &sig, ctx(200));
    let grant = decision.granted().unwrap();
    let action = AuthorizedAction::authorize(grant, None).expect("read-only 는 토큰 불요");
    assert_eq!(action.scope(), Scope::ReadOnly);
}

// ===========================================================================
// G. NOP-patch / no-bypass — 게이트를 실행에 엮기(단일 if 우회 불가).
// ===========================================================================

#[test]
fn g_nop_patch_decision_unconstructable_outside_module() {
    // 불변식 1(타입 차원): 외부(이 모듈 밖)에서는 Grant 를 만들 수 없다 — 필드 private,
    // 생성자(seal) private, NonceProof private. 따라서 verify() 의 모든 검사를 통과하는
    // 봉인 경로 외에 Granted 를 위조할 방법이 없다(컴파일 차원의 no-bypass).
    //
    // 이 테스트는 "유일한 Granted 산출 경로 = verify()" 를 행위로 단언한다: 동일 모듈
    // 내에서조차 Grant::seal 은 NonceProof 를 요구하고, NonceProof 는 consume 만 만든다.
    // 한 검사를 NOP-패치해 조기 거부를 막아도 변이 단계 이전이면 seal 도달 불가 →
    // 조용한 grant 0. (아래 g_* 들이 각 검사의 fail-closed 를 구체 단언.)
    let (mut reg, sk) = paired_readonly();
    let (a, sig) = signed(&sk, "phone-1", Scope::ReadOnly, nonce(1), 100, 1000);
    // 정상 경로만이 Granted 를 만든다.
    assert!(reg.verify(&a, &sig, ctx(200)).is_granted());
}

#[test]
fn g_nonce_consume_is_the_only_proof_source() {
    // 불변식 2(부작용 차원): nonce 소비가 봉인의 필수 입력이다. 소비가 일어나지 않으면
    // (재생) NonceProof 가 없어 봉인 불가 → Denied. 즉 "검증 우회해도 정답(proof) 없어
    // 동작 안 함"(license doc §6). 재생 시 grant 가 **구성 불가**임을 단언.
    let (mut reg, sk) = paired_readonly();
    let (a, sig) = signed(&sk, "phone-1", Scope::ReadOnly, nonce(5), 100, 1000);
    let first = reg.verify(&a, &sig, ctx(200));
    assert!(first.is_granted(), "최초 소비 성공 → 봉인됨");
    // 재생: nonce 미소비(이미 소비됨) → proof 없음 → Grant 구성 불가 → Denied.
    let replay = reg.verify(&a, &sig, ctx(200));
    assert!(
        replay.granted().is_none(),
        "nonce 소비 실패 시 grant 구성 불가(조용한 grant 0)"
    );
    assert_eq!(replay.denied(), Some(&DenyReason::NonceReplay));
}

#[test]
fn g_every_failure_fails_closed_no_silent_grant() {
    // 모든 거부 분기가 fail-closed(Granted 가 절대 안 됨)임을 한 자리에서 전수 단언.
    // 한 검사라도 빠지면(NOP-패치) 그 분기 입력이 Granted 로 새어나오는데, 아래는
    // 각 분기 입력이 모두 Denied 임을 못박는다.
    let sk = signing_key(1);
    let other = signing_key(2);

    // 미상 기기.
    {
        let mut reg = DeviceRegistry::new(2);
        let (a, s) = signed(&sk, "x", Scope::ReadOnly, nonce(1), 100, 1000);
        assert!(!reg.verify(&a, &s, ctx(200)).is_granted());
    }
    // 위조 서명.
    {
        let mut reg = DeviceRegistry::new(2);
        reg.pair("x", &pub_bytes(&sk), Scope::ReadOnly).unwrap();
        let (a, s) = signed(&other, "x", Scope::ReadOnly, nonce(1), 100, 1000);
        assert!(!reg.verify(&a, &s, ctx(200)).is_granted());
    }
    // 만료.
    {
        let mut reg = DeviceRegistry::new(2);
        reg.pair("x", &pub_bytes(&sk), Scope::ReadOnly).unwrap();
        let (a, s) = signed(&sk, "x", Scope::ReadOnly, nonce(1), 100, 150);
        assert!(!reg.verify(&a, &s, ctx(200)).is_granted());
    }
    // scope 상승.
    {
        let mut reg = DeviceRegistry::new(2);
        reg.pair("x", &pub_bytes(&sk), Scope::ReadOnly).unwrap();
        let (a, s) = signed(&sk, "x", Scope::Destructive, nonce(1), 100, 1000);
        assert!(!reg.verify(&a, &s, ctx(200)).is_granted());
    }
    // revoked.
    {
        let mut reg = DeviceRegistry::new(2);
        reg.pair("x", &pub_bytes(&sk), Scope::ReadOnly).unwrap();
        reg.revoke("x");
        let (a, s) = signed(&sk, "x", Scope::ReadOnly, nonce(1), 100, 1000);
        assert!(!reg.verify(&a, &s, ctx(200)).is_granted());
    }
}

// ===========================================================================
// 부수 검증: canonical bytes 결정성/모호성.
// ===========================================================================

#[test]
fn canonical_bytes_deterministic() {
    // 같은 assertion 은 같은 바이트(서명/검증 양측 재구성 일치).
    let a = CapabilityAssertion {
        device_id: "phone-1".into(),
        scope: Scope::Write,
        nonce: nonce(1),
        issued_at: 100,
        exp: 1000,
    };
    assert_eq!(a.canonical_bytes(), a.canonical_bytes());
}

#[test]
fn canonical_bytes_length_prefix_prevents_ambiguity() {
    // device_id 길이 프리픽스로 ("ab","") 류 경계 충돌 방지 — 다른 id 는 다른 바이트.
    let mk = |id: &str| CapabilityAssertion {
        device_id: id.into(),
        scope: Scope::ReadOnly,
        nonce: nonce(1),
        issued_at: 100,
        exp: 1000,
    };
    assert_ne!(mk("ab").canonical_bytes(), mk("a").canonical_bytes());
}

#[test]
fn scope_lattice_subset_rules() {
    // 격자 순위 단언 — read-only ⊆ write ⊆ destructive.
    assert!(Scope::ReadOnly.is_subset_of(Scope::ReadOnly));
    assert!(Scope::ReadOnly.is_subset_of(Scope::Write));
    assert!(Scope::ReadOnly.is_subset_of(Scope::Destructive));
    assert!(Scope::Write.is_subset_of(Scope::Destructive));
    assert!(!Scope::Write.is_subset_of(Scope::ReadOnly));
    assert!(!Scope::Destructive.is_subset_of(Scope::Write));
    assert!(!Scope::Destructive.is_subset_of(Scope::ReadOnly));
}
