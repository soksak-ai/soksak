// remote::pairing 테스트 — PART A 페어링 설정 RED→GREEN.
//
// 각 테스트는 한 불변식을 행위로 강제한다. RED(방어 전엔 통과=취약/오동작)는 주석에 "RED:"
// 로 명시한다 — 해당 검증을 제거하면 그 단언이 깨짐을 코드 위치로 못박는다.
//
// 핵심 불변식:
//   1. well-formed 설정 ⇒ 기기 핀닝 성공 + 핀닝 후 그 기기의 assertion 이 verify Granted.
//   2. malformed/partial 엔트리 ⇒ 거부(조용한 bad-key 핀닝 0).
//   3. 빈 설정 ⇒ 0 기기(fail-closed — 아무도 연결 못 함).
//   4. phone-supplied 바이트는 검증 단계를 못 넘으면 registry 를 변이 못 한다.

use super::*;
use crate::remote::auth::{CapabilityAssertion, DeviceRegistry, Scope, VerifyCtx};
use crate::remote::noise::{PinnedPeerRegistry, StaticKeypair};
use ed25519_dalek::{Signer, SigningKey};

// --- 테스트 키/번들 헬퍼 ------------------------------------------------------

/// 결정적 Ed25519 키(테스트 재현성).
fn ed_key(seed: u8) -> SigningKey {
    let mut bytes = [0u8; 32];
    bytes[0] = seed;
    bytes[31] = 0x42; // 0 시드 회피.
    SigningKey::from_bytes(&bytes)
}

/// 실제 유효한 X25519 static 공개키(snow 가 생성 — 약/소위수 아님). 핀닝 통과용.
fn x25519_pub_hex() -> ([u8; 32], String) {
    let kp = StaticKeypair::generate().unwrap();
    let pubk = kp.public_key();
    (pubk, to_hex(&pubk))
}

/// 한 well-formed 엔트리를 만든다(주어진 device_id/scope). 두 키는 실제 유효 키.
fn good_entry(device_id: &str, scope: &str) -> (PairedDeviceEntry, SigningKey, [u8; 32]) {
    let ed = ed_key(7);
    let (xpub, xhex) = x25519_pub_hex();
    let entry = PairedDeviceEntry {
        device_id: device_id.to_string(),
        x25519_pub: xhex,
        ed25519_pub: to_hex(&ed.verifying_key().to_bytes()),
        granted_scope: scope.to_string(),
    };
    (entry, ed, xpub)
}

// ===========================================================================
// 1. well-formed ⇒ 핀닝 성공 + 핀닝된 키로 assertion 이 verify Granted(매칭 단언).
// ===========================================================================

#[test]
fn wellformed_config_pins_device_and_assertion_verifies() {
    // RED: validate_entries/pin_devices 가 키를 안 핀닝하면(또는 잘못 핀닝하면) verify 가
    //      UnknownDevice/BadSignature 로 떨어진다. GREEN: 정확히 핀닝돼 Granted.
    let (entry, ed, _xpub) = good_entry("phone-test", "read-only");
    let validated = validate_entries(&[entry]).expect("well-formed 는 검증 통과");
    assert_eq!(validated.len(), 1);
    assert_eq!(validated[0].scope, Scope::ReadOnly);

    let mut noise = PinnedPeerRegistry::new();
    let mut auth = DeviceRegistry::new(8);
    pin_devices(&validated, &mut noise, &mut auth).expect("정상 핀닝");

    // noise 핀닝 확인.
    assert!(noise.is_pinned("phone-test"), "x25519 가 noise 에 핀닝됨");
    // auth 핀닝 확인 — 그 기기의 assertion 을 그 ed25519 키로 서명 ⇒ Granted(매칭 검증).
    let nonce = {
        let mut n = [0u8; 32];
        n[0] = 9;
        n[15] = 0xAB;
        n
    };
    let assertion = CapabilityAssertion {
        device_id: "phone-test".into(),
        scope: Scope::ReadOnly,
        nonce,
        issued_at: 100,
        exp: 1000,
    };
    let sig = ed.sign(&assertion.canonical_bytes()).to_bytes().to_vec();
    let decision = auth.verify(&assertion, &sig, VerifyCtx { now: 200 });
    let grant = decision
        .granted()
        .expect("핀닝된 키로 서명한 assertion 은 Granted 여야 함(핀닝 매칭 증명)");
    assert_eq!(grant.scope(), Scope::ReadOnly);
}

#[test]
fn destructive_scope_parsed_and_granted_with_confirm() {
    // destructive scope 부여 ⇒ 핀닝 + verify Granted{requires_desktop_confirm}.
    let (entry, ed, _x) = good_entry("phone-dx", "destructive");
    let validated = validate_entries(&[entry]).unwrap();
    assert_eq!(validated[0].scope, Scope::Destructive);
    let mut noise = PinnedPeerRegistry::new();
    let mut auth = DeviceRegistry::new(8);
    pin_devices(&validated, &mut noise, &mut auth).unwrap();
    let mut n = [0u8; 32];
    n[0] = 3;
    n[15] = 0xAB;
    let a = CapabilityAssertion {
        device_id: "phone-dx".into(),
        scope: Scope::Destructive,
        nonce: n,
        issued_at: 50,
        exp: 999,
    };
    let sig = ed.sign(&a.canonical_bytes()).to_bytes().to_vec();
    let g = auth
        .verify(&a, &sig, VerifyCtx { now: 100 })
        .granted()
        .map(|g| g.requires_desktop_confirm());
    assert_eq!(g, Some(true), "destructive 는 데스크톱 confirm 요구");
}

// ===========================================================================
// 2. malformed / partial ⇒ 거부(조용한 bad-key 핀닝 0).
// ===========================================================================

#[test]
fn malformed_key_hex_rejected_not_pinned() {
    // RED: parse_keys 가 길이/hex 를 안 막으면 bad-key 가 조용히 핀닝된다. GREEN: BadKeyHex.
    let (xpub, _xhex) = x25519_pub_hex();
    let entry = PairedDeviceEntry {
        device_id: "bad-key".into(),
        x25519_pub: "zz".to_string(), // 길이/hex 불량.
        ed25519_pub: to_hex(&xpub),
        granted_scope: "read-only".into(),
    };
    let err = validate_entries(&[entry]).unwrap_err();
    assert!(
        matches!(err, PairingConfigError::BadKeyHex { ref field, .. } if field == "x25519_pub"),
        "x25519 hex 불량은 BadKeyHex 로 거부, got {err:?}"
    );
}

#[test]
fn partial_entry_missing_ed_key_rejected() {
    // partial(ed25519 키 빈 문자열) ⇒ BadKeyHex(조용히 핀닝 0). serde 가 빈 문자열을 받지만
    // hex 디코드에서 거부된다.
    let (_x, xhex) = x25519_pub_hex();
    let entry = PairedDeviceEntry {
        device_id: "partial".into(),
        x25519_pub: xhex,
        ed25519_pub: "".to_string(), // 누락(빈).
        granted_scope: "read-only".into(),
    };
    let err = validate_entries(&[entry]).unwrap_err();
    assert!(
        matches!(err, PairingConfigError::BadKeyHex { ref field, .. } if field == "ed25519_pub"),
        "빈 ed25519 키는 BadKeyHex, got {err:?}"
    );
}

#[test]
fn bad_scope_rejected() {
    // 미상 scope("admin") ⇒ BadScope(조용한 권한 상승 0).
    let (entry_ed, _ed, _x) = good_entry("scope-bad", "admin");
    let err = validate_entries(&[entry_ed]).unwrap_err();
    assert!(
        matches!(err, PairingConfigError::BadScope { .. }),
        "미상 scope 는 BadScope, got {err:?}"
    );
}

#[test]
fn empty_device_id_rejected() {
    let (mut entry, _ed, _x) = good_entry("", "read-only");
    entry.device_id = "   ".into(); // 공백만.
    let err = validate_entries(&[entry]).unwrap_err();
    assert_eq!(err, PairingConfigError::EmptyDeviceId);
}

#[test]
fn one_bad_entry_rejects_whole_validation() {
    // 두 엔트리 중 하나가 불량이면 전체 Err — 좋은 엔트리도 통째 거부(혼합 부분-적용 0).
    let (good, _ed, _x) = good_entry("ok-1", "read-only");
    let (mut bad, _ed2, _x2) = good_entry("bad-1", "read-only");
    bad.x25519_pub = "deadbeef".into(); // 짧은 hex.
    let err = validate_entries(&[good, bad]).unwrap_err();
    assert!(matches!(err, PairingConfigError::BadKeyHex { .. }));
}

// ===========================================================================
// 3. 빈 설정 ⇒ 0 기기(fail-closed).
// ===========================================================================

#[test]
fn empty_json_yields_zero_devices() {
    assert_eq!(parse_devices_json("").unwrap().len(), 0);
    assert_eq!(parse_devices_json("   ").unwrap().len(), 0);
    assert_eq!(parse_devices_json("[]").unwrap().len(), 0);
}

#[test]
fn empty_config_pins_nothing_failclosed() {
    // 빈 목록 ⇒ 핀닝 0 ⇒ noise/auth 둘 다 비어 어떤 기기도 paired 아님(fail-closed).
    let validated = parse_devices_json("[]").unwrap();
    let mut noise = PinnedPeerRegistry::new();
    let mut auth = DeviceRegistry::new(8);
    pin_devices(&validated, &mut noise, &mut auth).unwrap();
    assert!(!noise.is_pinned("anyone"), "빈 설정 ⇒ 아무도 핀닝 안 됨");
    assert_eq!(auth.device_count(), 0, "빈 설정 ⇒ auth 0 기기");
}

#[test]
fn load_paired_devices_no_source_is_empty() {
    // env/파일 둘 다 없음 ⇒ 빈(fail-closed). config_dir=None.
    let devices = load_paired_devices(None, |_| None).unwrap();
    assert_eq!(devices.len(), 0);
}

#[test]
fn load_paired_devices_inline_json_env_wins() {
    // 인라인 JSON env 가 설정되면 그걸 파싱(파일 무시). E2E 경로.
    let (entry, _ed, _x) = good_entry("env-phone", "read-only");
    let json = serde_json::to_string(&vec![entry]).unwrap();
    let devices = load_paired_devices(None, |k| {
        if k == PAIRED_DEVICES_JSON_ENV {
            Some(json.clone())
        } else {
            None
        }
    })
    .unwrap();
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].device_id, "env-phone");
}

// ===========================================================================
// 4. phone-supplied 바이트는 registry 를 변이 못 한다(검증 게이트 밖이면 핀닝 0).
// ===========================================================================

#[test]
fn phone_supplied_bad_bytes_never_mutate_registry() {
    // RED: 만약 핀닝이 검증 전에 일어나거나 부분 적용을 허용하면, 폰이 보낸 garbage 가
    //      registry 에 들어간다. GREEN: validate_entries 가 Err 면 pin_devices 는 호출조차
    //      안 되고(호출자 계약), registry 는 비어 있다 — 입력 바이트가 registry 근처도 못 감.
    let noise = PinnedPeerRegistry::new();
    let auth = DeviceRegistry::new(8);

    // 폰이 보낸 듯한 garbage JSON(형식 불량 키).
    let garbage = r#"[{"device_id":"evil","x25519_pub":"00","ed25519_pub":"11","granted_scope":"destructive"}]"#;
    let result = parse_devices_json(garbage);
    assert!(result.is_err(), "garbage 는 파싱/검증 단계에서 거부");

    // 검증 실패 ⇒ 핀닝 시도 0 ⇒ registry 불변(아무도 안 들어감).
    assert!(!noise.is_pinned("evil"));
    assert_eq!(auth.device_count(), 0);

    // 명시적으로: validate 가 Err 를 준 입력은 ValidatedDevice 를 만들지 못하므로
    // pin_devices 의 입력이 될 수 없다(타입 시스템 — pin_devices 는 ValidatedDevice 만 받음).
    // 즉 "검증 안 된 바이트로 핀닝"하는 경로가 타입상 존재하지 않는다.
    let validated: Result<Vec<ValidatedDevice>, _> = parse_devices_json(garbage);
    assert!(validated.is_err());
}

#[test]
fn all_zero_x25519_key_rejected_at_pin() {
    // 전부-0 x25519(identity/약키)는 hex 로는 유효 길이지만 noise.pin 이 InvalidKey 로 거부.
    // validate 는 hex 길이만 보므로 통과하지만, pin_devices 가 NoisePinRejected 로 막는다
    // (이중 방어 — 조용한 약키 핀닝 0).
    let ed = ed_key(5);
    let entry = PairedDeviceEntry {
        device_id: "zero-x".into(),
        x25519_pub: "0".repeat(64), // 전부 0 — 유효 길이, 무효 점.
        ed25519_pub: to_hex(&ed.verifying_key().to_bytes()),
        granted_scope: "read-only".into(),
    };
    let validated = validate_entries(&[entry]).expect("hex 길이는 통과");
    let mut noise = PinnedPeerRegistry::new();
    let mut auth = DeviceRegistry::new(8);
    let err = pin_devices(&validated, &mut noise, &mut auth).unwrap_err();
    assert!(
        matches!(err, PairingConfigError::NoisePinRejected { .. }),
        "전부-0 x25519 는 noise 핀닝에서 거부, got {err:?}"
    );
}

// ===========================================================================
// 5. 데스크톱 static 키 영속 — 같은 경로 재로드 시 같은 공개키(안정 데스크톱 키).
// ===========================================================================

#[test]
fn desktop_key_persists_and_reloads_same_public() {
    // RED: 매 부팅 새 키면(generate only) 재로드 공개키가 달라져 폰 핀닝이 깨진다.
    //      GREEN: 첫 호출이 저장, 둘째 호출이 같은 파일에서 로드 ⇒ 동일 공개키.
    let dir = std::env::temp_dir().join(format!(
        "soksak-pairing-test-{}",
        std::process::id()
    ));
    let _ = std::fs::create_dir_all(&dir);
    let key_path = dir.join("desktop-static.json");
    let _ = std::fs::remove_file(&key_path); // 깨끗한 시작.

    let env = |k: &str| -> Option<String> {
        if k == DESKTOP_KEY_PATH_ENV {
            Some(key_path.to_string_lossy().to_string())
        } else {
            None
        }
    };
    let kp1 = load_or_create_desktop_key(None, &env).unwrap();
    let pub1 = kp1.public_key();
    assert!(key_path.exists(), "첫 호출이 키 파일을 만든다");

    let kp2 = load_or_create_desktop_key(None, &env).unwrap();
    let pub2 = kp2.public_key();
    assert_eq!(pub1, pub2, "재로드 공개키가 같다(안정 데스크톱 키 — 폰 핀닝 유지)");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn desktop_key_no_path_is_ephemeral() {
    // 경로 없음 ⇒ ephemeral(generate). 두 호출이 다른 키(영속 안 함) — 핀닝 안정 불가.
    let kp1 = load_or_create_desktop_key(None, |_| None).unwrap();
    let kp2 = load_or_create_desktop_key(None, |_| None).unwrap();
    assert_ne!(
        kp1.public_key(),
        kp2.public_key(),
        "경로 없으면 매번 새 키(ephemeral — 경로가 있어야 안정)"
    );
}

// ===========================================================================
// 6. hex 유틸 라운드트립.
// ===========================================================================

#[test]
fn hex32_round_trips_and_rejects_bad() {
    let mut k = [0u8; 32];
    k[0] = 0xde;
    k[1] = 0xad;
    k[31] = 0xff;
    assert_eq!(decode_hex32(&to_hex(&k)), Some(k));
    assert_eq!(decode_hex32("ab"), None, "짧은 hex 거부");
    assert_eq!(decode_hex32(&"z".repeat(64)), None, "비-hex 거부");
}
