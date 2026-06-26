// 시크릿 볼트(app.secrets) — API 키·토큰 같은 민감값을 암호화 저장하는 코어 capability.
// 설계: 단일 암호화 볼트 파일 하나가 단일 진실, OS 키체인 비의존(순수 Rust crypto) —
// 멀티플랫폼·헤드리스·백업이식 기준을 모두 만족(KeePassXC/1Password/Bitwarden 구조).
//
// ── 키 계층(envelope) ────────────────────────────────────────────────────────
// master passphrase ─Argon2id(salt,OWASP)→ KEK(32B, 메모리에만)
//                                            │
//   항목값마다 랜덤 DEK(32B) ─XChaCha20Poly1305(val_nonce)→ val_ct
//   DEK ─XChaCha20Poly1305(dek_nonce, key=KEK)→ dek_ct(=wrap)
// 디스크에는 암호문(dek_ct/val_ct + nonce)만 — KEK·DEK·평문은 절대 디스크에 없다.
//
// verifier: 고정 마커를 KEK 로 AEAD 봉인한 헤더 필드 — unlock 시 복호 성공으로
// passphrase 정합을 검증(KEK 자체는 저장하지 않으므로 이게 유일한 검증 채널).
//
// get 명령 없음 — 평문 readback 을 코어가 차단한다(2b 의 secretRef 주입만이 평문 경로).
//
// ── 메모리 위생(zeroize) — 실제 스크럽 범위(거짓 주장 0) ─────────────────────────
// lock 시: kek Mutex 슬롯의 32바이트를 in-place 로 zeroize 한 뒤 None — 슬롯의 실제
//   바이트를 지운다(로컬 사본만 지우고 슬롯은 남기지 않는다).
// derive_kek→unlock 흐름의 파생 KEK 는 Zeroizing<[u8;32]> 로 감싸 잔존 스택 사본을
//   소멸 시 자동 스크럽. seal/open 내부 중간 DEK 는 사용 직후 zeroize.
// 한계(정직): Argon2/AEAD crate 내부가 입력 키를 복사하는 임시 버퍼·레지스터 잔존은
//   이 코드가 닿지 않는다 — Rust/crate 경계 밖이라 완전 스택 스크럽은 보장하지 않는다.
//   우리가 보장하는 것은 우리가 소유한 버퍼(슬롯·파생 KEK·중간 DEK)의 스크럽뿐이다.
//
// ── ns 는 암호 경계가 아니다 — 접근제어 라벨 ──────────────────────────────────
// 전 ns 가 단일 KEK 를 공유한다(per-ns 키 분리 없음). ns 는 암호적 격리가 아니라
//   API 주입층(api.ts 가 ns=manifest.id 주입)에서 강제되는 접근제어 라벨이다.
// catalogSecrets.ts 의 secret.* 명령은 임의 ns 파라미터를 허용한다 — CLI/MCP 는
//   운영자 full-trust 신뢰경계라 ns 를 자유 지정한다(플러그인 표면만 ns 가 고정).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::Aead;
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tauri::State;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::{Zeroize, Zeroizing};

// OWASP Argon2id 권장(2024): m=19456 KiB, t=2, p=1. 헤더에 기록 — 미래 파라미터 변경 대비.
const ARGON2_M_COST: u32 = 19456;
const ARGON2_T_COST: u32 = 2;
const ARGON2_P_COST: u32 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24; // XChaCha20Poly1305 = 24B nonce
const KEY_LEN: usize = 32;
// verifier 평문 마커 — KEK 로 봉인된 복호 결과가 이 값과 일치해야 passphrase 정합.
const VERIFIER_MARKER: &[u8] = b"soksak-vault-v1";
const VAULT_VERSION: u32 = 1;

// ── 직렬화 모델(serde_json) ──────────────────────────────────────────────────

// 항목 한 개 = envelope. 전부 암호문/nonce(평문 0). b64 직렬화(JSON 안전).
#[derive(Serialize, Deserialize, Clone)]
pub struct SealedItem {
    #[serde(with = "b64")]
    pub dek_nonce: Vec<u8>,
    #[serde(with = "b64")]
    pub dek_ct: Vec<u8>, // KEK 로 wrap 된 DEK
    #[serde(with = "b64")]
    pub val_nonce: Vec<u8>,
    #[serde(with = "b64")]
    pub val_ct: Vec<u8>, // DEK 로 암호화된 값
}

// 볼트 헤더(평문 — KEK 도출에 필요한 비밀 아닌 파라미터). salt 는 비밀이 아니다(KDF 표준).
#[derive(Serialize, Deserialize, Clone)]
pub struct VaultHeader {
    pub version: u32,
    pub kdf: String, // "argon2id"
    pub m_cost: u32,
    pub t_cost: u32,
    pub p_cost: u32,
    #[serde(with = "b64")]
    pub salt: Vec<u8>,
    pub verifier: SealedItem, // VERIFIER_MARKER 를 KEK 로 봉인(passphrase 검증용)
}

// 볼트 전체 = 헤더 + entries(ns→key→항목). 단일 파일에 serde_json 으로 직렬화.
#[derive(Serialize, Deserialize, Clone)]
pub struct VaultData {
    pub header: VaultHeader,
    pub entries: BTreeMap<String, BTreeMap<String, SealedItem>>,
}

// b64 직렬화 헬퍼(serde with). 바이트 → base64 문자열(JSON 호환).
mod b64 {
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

// ── 순수 crypto(테스트 분리) ─────────────────────────────────────────────────

// passphrase + salt → KEK(32B). Argon2id, 헤더 파라미터. 실패는 사유 문자열.
// 파생 KEK 는 Zeroizing 으로 감싸 잔존 스택 사본을 소멸 시 자동 스크럽한다.
pub fn derive_kek(
    passphrase: &[u8],
    salt: &[u8],
    m: u32,
    t: u32,
    p: u32,
) -> Result<Zeroizing<[u8; KEY_LEN]>, String> {
    let params = Params::new(m, t, p, Some(KEY_LEN)).map_err(|e| format!("argon2 파라미터: {e}"))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut kek = Zeroizing::new([0u8; KEY_LEN]);
    argon2
        .hash_password_into(passphrase, salt, kek.as_mut())
        .map_err(|e| format!("KEK 도출 실패: {e}"))?;
    Ok(kek)
}

// 랜덤 nonce(24B, OsRng).
fn random_nonce() -> [u8; NONCE_LEN] {
    let mut n = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut n);
    n
}

// XChaCha20Poly1305 AEAD 봉인. key(32B) + nonce(24B) + 평문 → 암호문(인증 태그 포함).
fn aead_seal(key: &[u8; KEY_LEN], nonce: &[u8; NONCE_LEN], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = XChaCha20Poly1305::new(key.into());
    cipher
        .encrypt(XNonce::from_slice(nonce), plaintext)
        .map_err(|_| "AEAD 봉인 실패".to_string())
}

// XChaCha20Poly1305 AEAD 개봉. 잘못된 key 또는 변조 시 인증 실패 → Err(평문 누출 0).
fn aead_open(key: &[u8; KEY_LEN], nonce: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    if nonce.len() != NONCE_LEN {
        return Err("nonce 길이 오류".to_string());
    }
    let cipher = XChaCha20Poly1305::new(key.into());
    cipher
        .decrypt(XNonce::from_slice(nonce), ciphertext)
        .map_err(|_| "AEAD 개봉 실패(잘못된 키 또는 변조)".to_string())
}

// 값 봉인 → SealedItem(envelope). 랜덤 DEK 로 값 암호화, DEK 를 KEK 로 wrap.
pub fn seal(kek: &[u8; KEY_LEN], value: &[u8]) -> Result<SealedItem, String> {
    let mut dek = [0u8; KEY_LEN];
    OsRng.fill_bytes(&mut dek);
    let val_nonce = random_nonce();
    let val_ct = aead_seal(&dek, &val_nonce, value)?;
    let dek_nonce = random_nonce();
    let dek_ct = aead_seal(kek, &dek_nonce, &dek)?;
    dek.zeroize(); // 평문 DEK 즉시 소거
    Ok(SealedItem {
        dek_nonce: dek_nonce.to_vec(),
        dek_ct,
        val_nonce: val_nonce.to_vec(),
        val_ct,
    })
}

// SealedItem 개봉 → 평문. KEK 로 DEK unwrap, DEK 로 값 복호. 잘못된 KEK·변조면 Err.
pub fn open(kek: &[u8; KEY_LEN], item: &SealedItem) -> Result<Vec<u8>, String> {
    let mut dek_vec = aead_open(kek, &item.dek_nonce, &item.dek_ct)?;
    if dek_vec.len() != KEY_LEN {
        dek_vec.zeroize();
        return Err("DEK 길이 오류".to_string());
    }
    let mut dek = [0u8; KEY_LEN];
    dek.copy_from_slice(&dek_vec);
    dek_vec.zeroize();
    let out = aead_open(&dek, &item.val_nonce, &item.val_ct);
    dek.zeroize();
    out
}

// ── 비대칭 봉투(app.data 단계②) — X25519 sealed box + AAD ──────────────────────
// libsodium crypto_box_seal 구조: 공개키 P 로 봉인(개인키 불요 = vault lock 중에도 at-rest 쓰기 가능),
// 개인키 S 로만 개봉(unlock 필요). 1회용 ephemeral 키페어로 DH → HKDF-SHA256 대칭키 → 기존
// XChaCha20Poly1305(이번엔 AAD 바인딩). AAD 에 봉인 컨텍스트(ns‖coll‖scope‖id‖keyId)를 묶어
// 재배치/replay/교차-scope 이동을 거부한다(blocker high). 자체 crypto 발명 0 — RustCrypto + dalek.

const X25519_LEN: usize = 32;

// 비대칭 봉투 — 디스크/doc 컬럼 직렬화(전부 암호문·공개값, 비밀 0). b64(JSON 안전).
#[derive(Serialize, Deserialize, Clone)]
pub struct SealedBox {
    #[serde(with = "b64")]
    pub eph_pk: Vec<u8>, // ephemeral 공개키(32B) — 개봉 측 DH 입력
    #[serde(with = "b64")]
    pub nonce: Vec<u8>, // XChaCha20 nonce(24B)
    #[serde(with = "b64")]
    pub ct: Vec<u8>, // AEAD 암호문(인증 태그 포함)
}

// 개인키 S(32B) → 공개키 P = X25519_basepoint · S. unlock 시 P==basepoint(S) byte-eq 로
// encryption_keys.publicKey 스왑을 거부한다(blocker④). dalek 의 clamp/곱셈만 사용(자체 0).
pub fn public_from_secret(secret: &[u8; X25519_LEN]) -> [u8; X25519_LEN] {
    PublicKey::from(&StaticSecret::from(*secret)).to_bytes()
}

// 새 X25519 키페어 (S, P). S 는 vault wrap 대상(개인), P 는 encryption_keys 평문 메타(공개).
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

// AAD 바인딩 AEAD — 기존 aead_seal/open 은 AAD 없음. 비대칭 봉투는 AAD 필수라 Payload 변형.
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

// 공개키 P 로 봉인 — 개인키 불요(lock 중 at-rest 쓰기). aad 가 봉인 컨텍스트를 묶는다.
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

// 개인키 S 로 개봉(unlock 필요). aad 불일치·변조·잘못된 키 → Err(평문 누출 0).
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

// ── 상태(lib.rs manage) ──────────────────────────────────────────────────────

#[derive(Default)]
pub struct SecretsState {
    kek: Mutex<Option<[u8; KEY_LEN]>>, // unlock 시 메모리에만, lock 시 슬롯 in-place zeroize
    vault: Mutex<Option<VaultData>>,   // 디스크 동기화(None=미로딩)
    // 볼트 파일 경로 — init(lib.rs setup) 에서 1회 설정. 미설정이면 프로덕션 경로 계산으로 폴백.
    // 테스트는 임시 path 를 직접 주입(전역 HOME 변이 0 — data/store.rs·plugins.rs 주입형 선례).
    path: Mutex<Option<PathBuf>>,
}

// 프로덕션 볼트 경로: HOME → ~/.soksak/secrets.vault. data/mod.rs db_path 패턴.
// '주어진 경로로 동작' 과 분리(이 함수는 경로 계산만, 디렉토리 생성 포함).
pub fn default_vault_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| format!("HOME 없음: {e}"))?;
    let dir = PathBuf::from(home).join(".soksak");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("secrets.vault"))
}

// 볼트 경로 해소 — SOKSAK_VAULT_PATH 가 있으면 그 경로(헤드리스/E2E 격리용 오픈 메커니즘:
// 사용자 실볼트 비오염·실 passphrase 비종속), 없으면 default_vault_path(). SOKSAK_VAULT_KEY 와 대칭.
// env 조회를 주입받아 테스트가 전역 env 변형 없이 검증한다(병렬 테스트 안전).
pub fn resolve_vault_path(env: impl Fn(&str) -> Option<String>) -> Result<PathBuf, String> {
    match env("SOKSAK_VAULT_PATH") {
        Some(p) if !p.is_empty() => {
            let path = PathBuf::from(p);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            Ok(path)
        }
        _ => default_vault_path(),
    }
}

// ns 검증 — data/mod.rs validate_ns 와 동형(경로/식별자 안전 문자만). 코어 단일 규칙 복제
// (네임스페이스 격리의 바닥값 — 플러그인 id 또는 core).
fn validate_ns(ns: &str) -> Result<(), String> {
    let mut chars = ns.chars();
    let head = chars.next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let rest = chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if head && rest {
        Ok(())
    } else {
        Err(format!("잘못된 ns: {ns:?}"))
    }
}

// 시크릿 key 검증 — 임의 식별자(영숫자·-·_·.). 빈 문자열 거부.
fn validate_key(key: &str) -> Result<(), String> {
    if !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        Ok(())
    } else {
        Err(format!("잘못된 key: {key:?}"))
    }
}

impl SecretsState {
    // init: 볼트 경로를 주입(lib.rs setup 1회). 프로덕션은 default_vault_path() 를 넘긴다.
    pub fn set_path(&self, path: PathBuf) {
        *self.path.lock().expect("secrets path mutex") = Some(path);
    }

    // 이 State 가 쓸 볼트 경로 — 주입됐으면 그 path, 아니면 프로덕션 계산으로 폴백.
    fn vault_file(&self) -> Result<PathBuf, String> {
        if let Some(p) = self.path.lock().map_err(|e| e.to_string())?.as_ref() {
            return Ok(p.clone());
        }
        default_vault_path()
    }

    // 새 볼트 헤더 생성 — salt 생성 + KEK 도출 + verifier 봉인. KEK 는 호출자가 보관.
    fn new_vault(passphrase: &[u8]) -> Result<(VaultData, Zeroizing<[u8; KEY_LEN]>), String> {
        let mut salt = [0u8; SALT_LEN];
        OsRng.fill_bytes(&mut salt);
        let kek = derive_kek(passphrase, &salt, ARGON2_M_COST, ARGON2_T_COST, ARGON2_P_COST)?;
        let verifier = seal(&kek, VERIFIER_MARKER)?;
        // kek: &Zeroizing<[u8;32]> → seal 의 &[u8;32] 는 Deref 강제로 충족.
        let header = VaultHeader {
            version: VAULT_VERSION,
            kdf: "argon2id".to_string(),
            m_cost: ARGON2_M_COST,
            t_cost: ARGON2_T_COST,
            p_cost: ARGON2_P_COST,
            salt: salt.to_vec(),
            verifier,
        };
        Ok((VaultData { header, entries: BTreeMap::new() }, kek))
    }

    // 주어진 경로 → VaultData. 없으면 None. (경로 주입형 — 테스트가 임시 path 를 직접 준다.)
    fn load_from_disk(path: &Path) -> Result<Option<VaultData>, String> {
        if !path.exists() {
            return Ok(None);
        }
        let raw = std::fs::read(path).map_err(|e| format!("볼트 읽기 실패: {e}"))?;
        let vault: VaultData =
            serde_json::from_slice(&raw).map_err(|e| format!("볼트 파싱 실패: {e}"))?;
        Ok(Some(vault))
    }

    // VaultData → 주어진 경로(원자적: 임시파일 쓰고 rename). 볼트는 암호문만 담는다.
    fn flush(path: &Path, vault: &VaultData) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("볼트 디렉토리 실패: {e}"))?;
        }
        let bytes = serde_json::to_vec_pretty(vault).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("vault.tmp");
        std::fs::write(&tmp, &bytes).map_err(|e| format!("볼트 쓰기 실패: {e}"))?;
        std::fs::rename(&tmp, path).map_err(|e| format!("볼트 교체 실패: {e}"))
    }

    // unlock: 볼트 없으면 새로 생성(salt·verifier), 있으면 KEK 도출 후 verifier 복호로 검증.
    // 성공 시 KEK 를 메모리 보관. 잘못된 passphrase 면 verifier 개봉 실패 → Err.
    fn unlock(&self, passphrase: &str) -> Result<(), String> {
        let pw = passphrase.as_bytes();
        let path = self.vault_file()?;
        let (vault, kek) = match Self::load_from_disk(&path)? {
            Some(vault) => {
                let h = &vault.header;
                let kek = derive_kek(pw, &h.salt, h.m_cost, h.t_cost, h.p_cost)?;
                // verifier 복호로 passphrase 정합 검증(마커 일치까지 확인).
                let marker = open(&kek, &h.verifier).map_err(|_| "잘못된 passphrase".to_string())?;
                if marker != VERIFIER_MARKER {
                    return Err("잘못된 passphrase".to_string());
                }
                (vault, kek)
            }
            None => {
                let (vault, kek) = Self::new_vault(pw)?;
                Self::flush(&path, &vault)?;
                (vault, kek)
            }
        };
        // Zeroizing 파생 KEK → 슬롯에 사본 저장(파생 본은 함수 끝에서 자동 스크럽).
        *self.kek.lock().map_err(|e| e.to_string())? = Some(*kek);
        *self.vault.lock().map_err(|e| e.to_string())? = Some(vault);
        Ok(())
    }

    // lock: KEK 슬롯을 in-place zeroize → None. take() 의 로컬 사본이 아니라
    // Mutex 슬롯의 실제 32바이트를 직접 지운다(헤더의 '슬롯 in-place 스크럽' 보장과 일치).
    // 볼트 데이터(암호문)는 메모리에 남겨도 무해하나 함께 비운다.
    fn lock(&self) -> Result<(), String> {
        let mut guard = self.kek.lock().map_err(|e| e.to_string())?;
        if let Some(k) = guard.as_mut() {
            k.zeroize();
        }
        *guard = None;
        *self.vault.lock().map_err(|e| e.to_string())? = None;
        Ok(())
    }

    fn is_unlocked(&self) -> bool {
        self.kek.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    // KEK 사본으로 클로저 실행(locked 면 Err). 락 가드 안에서 처리(누출 최소화).
    fn with_kek<T>(&self, f: impl FnOnce(&[u8; KEY_LEN]) -> Result<T, String>) -> Result<T, String> {
        let guard = self.kek.lock().map_err(|e| e.to_string())?;
        let kek = guard.as_ref().ok_or("vault locked")?;
        f(kek)
    }

    fn set(&self, ns: &str, key: &str, value: &str) -> Result<(), String> {
        validate_ns(ns)?;
        validate_key(key)?;
        let item = self.with_kek(|kek| seal(kek, value.as_bytes()))?;
        let path = self.vault_file()?;
        let mut guard = self.vault.lock().map_err(|e| e.to_string())?;
        let vault = guard.as_mut().ok_or("vault locked")?;
        vault.entries.entry(ns.to_string()).or_default().insert(key.to_string(), item);
        Self::flush(&path, vault)
    }

    fn has(&self, ns: &str, key: &str) -> Result<bool, String> {
        validate_ns(ns)?;
        if !self.is_unlocked() {
            return Err("vault locked".to_string());
        }
        let guard = self.vault.lock().map_err(|e| e.to_string())?;
        let vault = guard.as_ref().ok_or("vault locked")?;
        Ok(vault.entries.get(ns).is_some_and(|m| m.contains_key(key)))
    }

    fn delete(&self, ns: &str, key: &str) -> Result<bool, String> {
        validate_ns(ns)?;
        if !self.is_unlocked() {
            return Err("vault locked".to_string());
        }
        let path = self.vault_file()?;
        let mut guard = self.vault.lock().map_err(|e| e.to_string())?;
        let vault = guard.as_mut().ok_or("vault locked")?;
        let removed = vault.entries.get_mut(ns).is_some_and(|m| m.remove(key).is_some());
        if removed {
            Self::flush(&path, vault)?;
        }
        Ok(removed)
    }

    // ns·key 의 평문을 복호해 반환 — Rust 전용(get 커맨드/CLI 미노출, 평문 readback 차단 유지).
    // 유일 호출자 = process_spawn 의 secret_env 주입(자식 env 로만 흐름). 잠김=Err, 미존재=Err.
    fn resolve(&self, ns: &str, key: &str) -> Result<String, String> {
        validate_ns(ns)?;
        validate_key(key)?;
        let item = {
            let guard = self.vault.lock().map_err(|e| e.to_string())?;
            let vault = guard.as_ref().ok_or("vault locked")?;
            vault
                .entries
                .get(ns)
                .and_then(|m| m.get(key))
                .cloned()
                .ok_or_else(|| format!("시크릿 없음: {ns}/{key}"))?
        };
        let plain = self.with_kek(|kek| open(kek, &item))?;
        String::from_utf8(plain).map_err(|_| "시크릿 평문 UTF-8 아님".to_string())
    }

    // ns 의 key 목록만(값 아님 — 평문 readback 차단 원칙).
    fn keys(&self, ns: &str) -> Result<Vec<String>, String> {
        validate_ns(ns)?;
        if !self.is_unlocked() {
            return Err("vault locked".to_string());
        }
        let guard = self.vault.lock().map_err(|e| e.to_string())?;
        let vault = guard.as_ref().ok_or("vault locked")?;
        Ok(vault
            .entries
            .get(ns)
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default())
    }
}

// 테스트 전용 헬퍼 — 다른 모듈(process.rs)의 secret_env 주입 테스트가 임시 볼트를 세팅할 때 쓴다.
// 프로덕션 경로는 unlock/set 이 private 이므로 IPC/CLI 로만 진입(평문 readback 차단 불변).
#[cfg(test)]
pub fn test_state_with_secret(path: PathBuf, passphrase: &str, ns: &str, key: &str, value: &str) -> SecretsState {
    let s = SecretsState::default();
    s.set_path(path);
    s.unlock(passphrase).expect("test unlock");
    s.set(ns, key, value).expect("test set");
    s
}

// ── 내부 평문 해소(Rust 전용 — process_spawn secret_env 주입) ────────────────
// pub fn 이지만 tauri::command 아님 → IPC/CLI 비노출. 평문은 호출자(process_spawn)가
// 자식 env 로만 흘린다(JS 로 반환 0, R2). 잠김=Err(vault locked), 미존재=Err.
pub fn resolve(state: &SecretsState, ns: &str, key: &str) -> Result<String, String> {
    state.resolve(ns, key)
}

// ── Tauri 커맨드 ─────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct BackendInfo {
    pub backend: String, // "vault"
    pub unlocked: bool,
}

// 헤드리스/e2e: SOKSAK_VAULT_KEY env 가 있으면 그 값으로 자동 unlock(GUI·생체 없이 결정적).
// setup 에서 1회 호출 — 명령들이 즉시 쓸 수 있도록.
pub fn auto_unlock_from_env(state: &SecretsState) {
    if let Ok(key) = std::env::var("SOKSAK_VAULT_KEY") {
        if !key.is_empty() {
            if let Err(e) = state.unlock(&key) {
                eprintln!("[secrets] SOKSAK_VAULT_KEY 자동 unlock 실패: {e}");
            }
        }
    }
}

#[tauri::command]
pub fn secret_unlock(passphrase: String, state: State<'_, SecretsState>) -> Result<(), String> {
    state.unlock(&passphrase)
}

#[tauri::command]
pub fn secret_lock(state: State<'_, SecretsState>) -> Result<(), String> {
    state.lock()
}

#[tauri::command]
pub fn secret_set(
    ns: String,
    key: String,
    value: String,
    state: State<'_, SecretsState>,
) -> Result<(), String> {
    state.set(&ns, &key, &value)
}

#[tauri::command]
pub fn secret_has(ns: String, key: String, state: State<'_, SecretsState>) -> Result<bool, String> {
    state.has(&ns, &key)
}

#[tauri::command]
pub fn secret_delete(ns: String, key: String, state: State<'_, SecretsState>) -> Result<bool, String> {
    state.delete(&ns, &key)
}

#[tauri::command]
pub fn secret_keys(ns: String, state: State<'_, SecretsState>) -> Result<Vec<String>, String> {
    state.keys(&ns)
}

#[tauri::command]
pub fn secret_backend(state: State<'_, SecretsState>) -> Result<BackendInfo, String> {
    Ok(BackendInfo {
        backend: "vault".to_string(),
        unlocked: state.is_unlocked(),
    })
}

// ── 테스트(순수 crypto) ──────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn kek_a() -> Zeroizing<[u8; KEY_LEN]> {
        derive_kek(b"correct horse", b"salt-aaaa-bbbb-cc", ARGON2_M_COST, ARGON2_T_COST, ARGON2_P_COST)
            .unwrap()
    }

    // 임시 볼트 path 주입 — 전역 HOME 변이 0(병렬 test-threads 레이스 제거).
    // data/store.rs(&Connection)·plugins.rs(&Path base) 주입형 선례.
    fn state_with_tmp_vault(tag: &str) -> (SecretsState, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "soksak-secrets-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("secrets.vault");
        let s = SecretsState::default();
        s.set_path(path);
        (s, dir)
    }

    // (a0) resolve_vault_path — SOKSAK_VAULT_PATH 주입 시 그 경로(격리), 없으면 default.
    // 오픈 메커니즘: 헤드리스/E2E 가 사용자 실볼트를 오염하지 않게 경로를 격리한다(passphrase 비종속).
    #[test]
    fn vault_path_env_override() {
        let iso = std::env::temp_dir().join("soksak-vault-override-test").join("secrets.vault");
        let chosen = resolve_vault_path(|k| {
            if k == "SOKSAK_VAULT_PATH" {
                Some(iso.to_string_lossy().into_owned())
            } else {
                None
            }
        })
        .unwrap();
        assert_eq!(chosen, iso, "SOKSAK_VAULT_PATH 주입 → 그 경로");
        // 미주입 → default_vault_path 와 동일(프로덕션 경로 유지).
        let fallback = resolve_vault_path(|_| None).unwrap();
        assert_eq!(fallback, default_vault_path().unwrap(), "미주입 → default");
        // 빈 문자열 → default(빈 env 를 '설정 안 함' 으로 취급).
        let empty = resolve_vault_path(|k| if k == "SOKSAK_VAULT_PATH" { Some(String::new()) } else { None }).unwrap();
        assert_eq!(empty, default_vault_path().unwrap(), "빈 env → default");
    }

    // (a) seal → open roundtrip — 같은 KEK 로 봉인·개봉 시 평문 복원.
    #[test]
    fn seal_open_roundtrip() {
        let kek = kek_a();
        let item = seal(&kek, b"sk-secret-token-123").unwrap();
        let plain = open(&kek, &item).unwrap();
        assert_eq!(plain, b"sk-secret-token-123");
    }

    // (b) wrong KEK → open Err — AEAD 인증이 잘못된 키를 거부(평문 누출 0).
    #[test]
    fn wrong_kek_rejected() {
        let kek = kek_a();
        let item = seal(&kek, b"value").unwrap();
        let wrong =
            derive_kek(b"wrong pass", b"salt-aaaa-bbbb-cc", ARGON2_M_COST, ARGON2_T_COST, ARGON2_P_COST)
                .unwrap();
        assert!(open(&wrong, &item).is_err());
    }

    // (c) val_ct/dek_ct 변조 → open Err — 무결성(AEAD 태그 불일치).
    #[test]
    fn tamper_rejected() {
        let kek = kek_a();
        // val_ct 변조
        let mut item = seal(&kek, b"value").unwrap();
        item.val_ct[0] ^= 0xff;
        assert!(open(&kek, &item).is_err());
        // dek_ct 변조
        let mut item2 = seal(&kek, b"value").unwrap();
        item2.dek_ct[0] ^= 0xff;
        assert!(open(&kek, &item2).is_err());
    }

    // (d) unlock 잘못된 passphrase → Err. 임시 path 주입(HOME 변이 0), 다른 pass 로 재unlock.
    #[test]
    fn unlock_wrong_passphrase_rejected() {
        let (s, dir) = state_with_tmp_vault("wrongpass");

        s.unlock("right-passphrase").unwrap(); // 새 볼트 생성
        s.lock().unwrap();
        let bad = s.unlock("WRONG-passphrase");
        assert!(bad.is_err(), "잘못된 passphrase 는 거부되어야 함");
        s.unlock("right-passphrase").unwrap(); // 올바른 pass 는 다시 열림

        let _ = std::fs::remove_dir_all(&dir);
    }

    // (e) ns 격리 — ns A 의 key 가 ns B keys 에 안 보임.
    #[test]
    fn ns_isolation() {
        let (s, dir) = state_with_tmp_vault("ns");

        s.unlock("pw").unwrap();
        s.set("plugin-a", "token", "aaa").unwrap();
        s.set("plugin-b", "key", "bbb").unwrap();

        assert_eq!(s.keys("plugin-a").unwrap(), vec!["token".to_string()]);
        assert_eq!(s.keys("plugin-b").unwrap(), vec!["key".to_string()]);
        assert!(s.has("plugin-a", "token").unwrap());
        assert!(!s.has("plugin-b", "token").unwrap()); // A 의 key 가 B 에 안 보임
        assert!(s.keys("plugin-c").unwrap().is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    // locked 상태에서 연산 거부.
    #[test]
    fn locked_ops_rejected() {
        let s = SecretsState::default();
        assert!(s.set("ns", "k", "v").is_err());
        assert!(s.has("ns", "k").is_err());
        assert!(s.keys("ns").is_err());
        assert!(s.delete("ns", "k").is_err());
    }

    // resolve(내부 평문 해소) — unlock 상태에서 저장값 평문 복원(process_spawn 주입 경로의 바닥).
    #[test]
    fn resolve_roundtrip() {
        let (s, dir) = state_with_tmp_vault("resolve");
        s.unlock("pw").unwrap();
        s.set("plugin-a", "apiKey", "sk-token-xyz").unwrap();
        assert_eq!(s.resolve("plugin-a", "apiKey").unwrap(), "sk-token-xyz");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── 비대칭 봉투(단계②) ──────────────────────────────────────────────────
    const AAD1: &[u8] = b"terminal|command_blocks|proj-a|rec-1|key-1|1";
    const AAD2: &[u8] = b"terminal|command_blocks|proj-b|rec-1|key-1|1"; // scope 만 다름

    // (asym-a) seal_to(P) → open_sealed(S) roundtrip — 같은 키페어·같은 AAD 면 평문 복원.
    #[test]
    fn asym_seal_open_roundtrip() {
        let (s, p) = gen_asym_keypair();
        let msg = br#"{"id":"rec-1","output":"secret echo"}"#;
        let boxed = seal_to(&p, msg, AAD1).unwrap();
        assert_eq!(open_sealed(&s, &boxed, AAD1).unwrap(), msg);
    }

    // (asym-b, blocker④) P == basepoint(S) — public_from_secret(S) 가 키페어 P 와 byte-eq.
    // 키스왑 거부의 토대: encryption_keys.publicKey 가 S 에서 파생됐는지 검증할 수 있다.
    #[test]
    fn asym_public_matches_basepoint() {
        let (s, p) = gen_asym_keypair();
        assert_eq!(public_from_secret(&s), p, "P 는 basepoint·S 와 일치해야");
        // 다른 S 의 P 는 다르다(스왑된 P 는 검증에서 탈락).
        let (s2, _p2) = gen_asym_keypair();
        assert_ne!(public_from_secret(&s2), p, "다른 S → 다른 P(스왑 탐지 가능)");
    }

    // (asym-c, blocker high) AAD 불일치 → open Err. scope 만 바뀐 AAD 로 개봉 거부(교차-scope 누출 0).
    #[test]
    fn asym_aad_mismatch_rejected() {
        let (s, p) = gen_asym_keypair();
        let boxed = seal_to(&p, b"value", AAD1).unwrap();
        assert!(open_sealed(&s, &boxed, AAD2).is_err(), "다른 AAD 면 개봉 거부");
        assert!(open_sealed(&s, &boxed, b"").is_err(), "빈 AAD 면 개봉 거부");
        assert_eq!(open_sealed(&s, &boxed, AAD1).unwrap(), b"value"); // 정합 AAD 는 성공
    }

    // (asym-d) 잘못된 개인키 → open Err. 변조(ct/eph_pk) → open Err(평문 누출 0).
    #[test]
    fn asym_wrong_key_and_tamper_rejected() {
        let (_s, p) = gen_asym_keypair();
        let (s_other, _p2) = gen_asym_keypair();
        let boxed = seal_to(&p, b"value", AAD1).unwrap();
        assert!(open_sealed(&s_other, &boxed, AAD1).is_err(), "타 개인키 거부");
        // ct 변조
        let (s, p) = gen_asym_keypair();
        let mut t1 = seal_to(&p, b"value", AAD1).unwrap();
        t1.ct[0] ^= 0xff;
        assert!(open_sealed(&s, &t1, AAD1).is_err(), "ct 변조 거부");
        // eph_pk 변조 → DH 키 달라짐 → 인증 실패
        let mut t2 = seal_to(&p, b"value", AAD1).unwrap();
        t2.eph_pk[0] ^= 0xff;
        assert!(open_sealed(&s, &t2, AAD1).is_err(), "eph_pk 변조 거부");
    }

    // (asym-e) 봉투 직렬화 라운드트립 — doc 컬럼 문자열로 직렬화/역직렬화 후 개봉 가능(저장 경로 검증).
    #[test]
    fn asym_serialize_roundtrip() {
        let (s, p) = gen_asym_keypair();
        let boxed = seal_to(&p, b"persisted", AAD1).unwrap();
        let json = serde_json::to_string(&boxed).unwrap();
        let back: SealedBox = serde_json::from_str(&json).unwrap();
        assert_eq!(open_sealed(&s, &back, AAD1).unwrap(), b"persisted");
    }

    // resolve 잠금/미존재 게이트 — 잠김=Err(vault locked), 미존재 key/ns=Err(평문 누출 0).
    #[test]
    fn resolve_locked_and_missing_rejected() {
        let (s, dir) = state_with_tmp_vault("resolve-gate");
        // 잠김 — unlock 전.
        assert!(s.resolve("plugin-a", "apiKey").is_err());
        s.unlock("pw").unwrap();
        s.set("plugin-a", "apiKey", "v").unwrap();
        // 미존재 key.
        assert!(s.resolve("plugin-a", "nope").is_err());
        // 미존재 ns.
        assert!(s.resolve("plugin-z", "apiKey").is_err());
        // lock 후 다시 잠김.
        s.lock().unwrap();
        assert!(s.resolve("plugin-a", "apiKey").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
