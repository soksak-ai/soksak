//! X25519 sealed box — 코어 secrets(단계② app.data 암호화)에서 옮겨 온 비대칭 봉투의
//! 단일 진실. 앱 볼트와 soksak-ptyd(바이트 체크포인트 봉인)가 같은 스킴을 공유한다 —
//! 사본 금지, 새 crypto 발명 0(RustCrypto + dalek 조합만).
//!
//! libsodium crypto_box_seal 구조: 공개키 P 로 봉인(개인키 불요 = vault lock 중에도
//! at-rest 쓰기 가능), 개인키 S 로만 개봉(unlock 필요). 1회용 ephemeral 키페어로 DH →
//! HKDF-SHA256 대칭키 → XChaCha20Poly1305(AAD 바인딩). AAD 에 봉인 컨텍스트를 묶어
//! 재배치/replay/교차-컨텍스트 이동을 거부한다.

use chacha20poly1305::aead::Aead;
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

pub const X25519_LEN: usize = 32;
const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 24; // XChaCha20Poly1305 = 24B nonce

/// b64 직렬화 헬퍼(serde with). 바이트 → base64 문자열(JSON 호환).
pub mod b64 {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&STANDARD.encode(v))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        STANDARD.decode(s.as_bytes()).map_err(serde::de::Error::custom)
    }
}

/// 비대칭 봉투 — 디스크/doc 컬럼 직렬화(전부 암호문·공개값, 비밀 0). b64(JSON 안전).
#[derive(Serialize, Deserialize, Clone)]
pub struct SealedBox {
    #[serde(with = "b64")]
    pub eph_pk: Vec<u8>, // ephemeral 공개키(32B) — 개봉 측 DH 입력
    #[serde(with = "b64")]
    pub nonce: Vec<u8>, // XChaCha20 nonce(24B)
    #[serde(with = "b64")]
    pub ct: Vec<u8>, // AEAD 암호문(인증 태그 포함)
}

/// 개인키 S(32B) → 공개키 P = X25519_basepoint · S. unlock 시 P==basepoint(S) byte-eq 로
/// 공개키 스왑을 거부한다. dalek 의 clamp/곱셈만 사용(자체 0).
pub fn public_from_secret(secret: &[u8; X25519_LEN]) -> [u8; X25519_LEN] {
    PublicKey::from(&StaticSecret::from(*secret)).to_bytes()
}

/// 새 X25519 키페어 (S, P). S 는 vault wrap 대상(개인), P 는 평문 메타(공개).
pub fn gen_asym_keypair() -> ([u8; X25519_LEN], [u8; X25519_LEN]) {
    let s = StaticSecret::random_from_rng(OsRng);
    let p = PublicKey::from(&s).to_bytes();
    (s.to_bytes(), p)
}

// DH 공유비밀 → HKDF-SHA256 → 봉투 대칭키(32B). info 에 두 공개키를 묶어 키 혼동 방지.
fn derive_box_key(
    shared: &[u8; 32],
    eph_pk: &[u8; X25519_LEN],
    recipient_pk: &[u8; X25519_LEN],
) -> Zeroizing<[u8; KEY_LEN]> {
    let hk = hkdf::Hkdf::<sha2::Sha256>::new(None, shared);
    let mut info = Vec::with_capacity(13 + 2 * X25519_LEN);
    info.extend_from_slice(b"soksak-box-v1");
    info.extend_from_slice(eph_pk);
    info.extend_from_slice(recipient_pk);
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    hk.expand(&info, key.as_mut()).expect("hkdf-sha256 32B expand 는 불변 길이");
    key
}

// AAD 바인딩 AEAD — 비대칭 봉투는 AAD 필수라 Payload 변형.
fn aead_seal_aad(
    key: &[u8; KEY_LEN],
    nonce: &[u8; NONCE_LEN],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, String> {
    let cipher = XChaCha20Poly1305::new(key.into());
    cipher
        .encrypt(XNonce::from_slice(nonce), chacha20poly1305::aead::Payload { msg: plaintext, aad })
        .map_err(|_| "AEAD 봉인 실패".to_string())
}
fn aead_open_aad(
    key: &[u8; KEY_LEN],
    nonce: &[u8],
    ciphertext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, String> {
    if nonce.len() != NONCE_LEN {
        return Err("nonce 길이 오류".to_string());
    }
    let cipher = XChaCha20Poly1305::new(key.into());
    cipher
        .decrypt(XNonce::from_slice(nonce), chacha20poly1305::aead::Payload { msg: ciphertext, aad })
        .map_err(|_| "AEAD 개봉 실패(잘못된 키·AAD·변조)".to_string())
}

/// 공개키 P 로 봉인 — 개인키 불요(lock 중 at-rest 쓰기). aad 가 봉인 컨텍스트를 묶는다.
pub fn seal_to(
    recipient_pk: &[u8; X25519_LEN],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<SealedBox, String> {
    let eph = StaticSecret::random_from_rng(OsRng);
    let eph_pk = PublicKey::from(&eph).to_bytes();
    let shared = eph.diffie_hellman(&PublicKey::from(*recipient_pk));
    let key = derive_box_key(shared.as_bytes(), &eph_pk, recipient_pk);
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let ct = aead_seal_aad(&key, &nonce, plaintext, aad)?;
    Ok(SealedBox { eph_pk: eph_pk.to_vec(), nonce: nonce.to_vec(), ct })
}

/// 개인키 S 로 개봉(unlock 필요). aad 불일치·변조·잘못된 키 → Err(평문 누출 0).
pub fn open_sealed(
    recipient_sk: &[u8; X25519_LEN],
    boxed: &SealedBox,
    aad: &[u8],
) -> Result<Vec<u8>, String> {
    if boxed.eph_pk.len() != X25519_LEN {
        return Err("eph_pk 길이 오류".to_string());
    }
    let mut eph_pk = [0u8; X25519_LEN];
    eph_pk.copy_from_slice(&boxed.eph_pk);
    let s = StaticSecret::from(*recipient_sk);
    let recipient_pk = PublicKey::from(&s).to_bytes();
    let shared = s.diffie_hellman(&PublicKey::from(eph_pk));
    let key = derive_box_key(shared.as_bytes(), &eph_pk, &recipient_pk);
    aead_open_aad(&key, &boxed.nonce, &boxed.ct, aad)
}

#[cfg(test)]
mod tests {
    use super::*;

    // seal(P)→open(S) 라운드트립 + AAD/키/변조 거부 — 스킴을 이 크레이트 자체에서
    // 못박는다(세부 거부 스위트는 코어 secrets 테스트가 유지).
    #[test]
    fn seal_open_roundtrip_and_rejections() {
        let (s, p) = gen_asym_keypair();
        let boxed = seal_to(&p, b"payload", b"ctx-a").unwrap();
        assert_eq!(open_sealed(&s, &boxed, b"ctx-a").unwrap(), b"payload");
        assert!(open_sealed(&s, &boxed, b"ctx-b").is_err(), "AAD 불일치 거부");
        let (s2, _) = gen_asym_keypair();
        assert!(open_sealed(&s2, &boxed, b"ctx-a").is_err(), "타 개인키 거부");
        let mut tampered = seal_to(&p, b"payload", b"ctx-a").unwrap();
        tampered.ct[0] ^= 1;
        assert!(open_sealed(&s, &tampered, b"ctx-a").is_err(), "변조 거부");
        assert_eq!(public_from_secret(&s), p, "P = basepoint(S)");
    }

    #[test]
    fn sealed_box_serializes_b64_fields() {
        let (_s, p) = gen_asym_keypair();
        let boxed = seal_to(&p, b"x", b"a").unwrap();
        let json = serde_json::to_value(&boxed).unwrap();
        assert!(json["eph_pk"].is_string() && json["nonce"].is_string() && json["ct"].is_string());
    }
}
