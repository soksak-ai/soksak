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
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use chacha20poly1305::aead::Aead;
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
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
        STANDARD
            .decode(s.as_bytes())
            .map_err(serde::de::Error::custom)
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
    let params =
        Params::new(m, t, p, Some(KEY_LEN)).map_err(|e| format!("argon2 파라미터: {e}"))?;
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
fn aead_seal(
    key: &[u8; KEY_LEN],
    nonce: &[u8; NONCE_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, String> {
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

// ── 복구 코드(R24) — 개인키 S 를 passphrase(KEK) 외 recovery-key 로도 2중 wrap ─────────
// passphrase 분실 시에도 S 를 되찾는 독립 경로. recovery code 문자열을 Argon2id 로 RK 도출 → 기존
// seal/open(대칭 envelope)으로 S 를 wrap. blob(salt+SealedItem)은 암호문이라 평문 DB(encryption_keys)에
// 저장 안전 — recovery code 자체는 사용자만 보관(1회 표시, 영구손실 고지). 코드는 decode 안 한다(Argon2id
// 입력일 뿐) → 생성은 typeable 문자열만 만들면 된다(Crockford base32, 혼동문자 I/L/O/U 제외).

const RECOVERY_BYTES: usize = 20; // 160비트 — recovery 코드 엔트로피

// Crockford base32(0-9 A-Z, ILOU 제외) — recovery 코드용 인코딩(생성 전용, decode 불요).
fn crockford_base32(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let mut out = String::new();
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    for &b in bytes {
        buffer = (buffer << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((buffer >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((buffer << (5 - bits)) & 0x1f) as usize] as char);
    }
    out
}

// 새 recovery 코드 — 160비트 랜덤 → Crockford base32 → 4자 그룹 대시 구분(타이핑 친화). 1회 표시용.
pub fn gen_recovery_code() -> String {
    let mut raw = [0u8; RECOVERY_BYTES];
    OsRng.fill_bytes(&mut raw);
    let enc = crockford_base32(&raw);
    enc.as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).unwrap_or(""))
        .collect::<Vec<_>>()
        .join("-")
}

// recovery 코드로 입력 정규화 — 대시/공백 제거 + 대문자(사용자가 소문자·구분자 섞어 입력해도 동일 RK).
fn normalize_recovery(code: &str) -> String {
    code.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_uppercase())
        .collect()
}

// recovery 코드로 secret(S) wrap → (salt, SealedItem). Argon2id(코드)→RK, seal(RK, secret).
pub fn recovery_wrap(recovery_code: &str, secret: &[u8]) -> Result<(Vec<u8>, SealedItem), String> {
    let norm = normalize_recovery(recovery_code);
    if norm.is_empty() {
        return Err("빈 recovery 코드".to_string());
    }
    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    let rk = derive_kek(
        norm.as_bytes(),
        &salt,
        ARGON2_M_COST,
        ARGON2_T_COST,
        ARGON2_P_COST,
    )?;
    let item = seal(&rk, secret)?;
    Ok((salt.to_vec(), item))
}

// recovery 코드로 secret 복구 — Argon2id(코드,salt)→RK, open(RK, item). 잘못된 코드면 AEAD Err.
pub fn recovery_unwrap(
    recovery_code: &str,
    salt: &[u8],
    item: &SealedItem,
) -> Result<Vec<u8>, String> {
    let norm = normalize_recovery(recovery_code);
    let rk = derive_kek(
        norm.as_bytes(),
        salt,
        ARGON2_M_COST,
        ARGON2_T_COST,
        ARGON2_P_COST,
    )?;
    open(&rk, item)
}

// recovery blob 직렬화 — encryption_keys.recovery 컬럼에 저장할 JSON(salt + SealedItem, 전부 b64).
#[derive(Serialize, Deserialize, Clone)]
pub struct RecoveryBlob {
    #[serde(with = "b64")]
    pub salt: Vec<u8>,
    pub sealed: SealedItem,
}

// ── 비대칭 봉투(app.data 단계②) — X25519 sealed box + AAD ──────────────────────
// 실체는 공유 크레이트 soksak-seal 로 옮겼다(soksak-ptyd 가 바이트 체크포인트 봉인에
// 같은 스킴을 쓴다 — 사본 금지). 여기서는 기존 소비자(data/crypto.rs·commands)의
// 경로를 그대로 유지하는 재수출만 남는다. AAD 컨텍스트(ns‖coll‖scope‖id‖keyId) 규약과
// 키 수명(S 는 vault 에만, P 는 encryption_keys 평문 메타)은 이 모듈·data 계층이 소유.
pub use soksak_seal::{gen_asym_keypair, open_sealed, public_from_secret, seal_to, SealedBox};

// ── 상태(lib.rs manage) ──────────────────────────────────────────────────────

#[derive(Default)]
pub struct SecretsState {
    kek: Mutex<Option<[u8; KEY_LEN]>>, // unlock 시 메모리에만, lock 시 슬롯 in-place zeroize
    vault: Mutex<Option<VaultData>>,   // 디스크 동기화(None=미로딩)
    // 볼트 파일 경로 — init(lib.rs setup) 에서 1회 설정. 미설정이면 프로덕션 경로 계산으로 폴백.
    // 테스트는 임시 path 를 직접 주입(전역 HOME 변이 0 — data/store.rs·plugins.rs 주입형 선례).
    path: Mutex<Option<PathBuf>>,
    // [단계③] auto-lock — idle 타이머가 lock 을 건다(vault lock = 프로세스 전역 = app.data S 도 전부 무효화).
    idle_timeout_ms: Mutex<i64>, // 0 = 비활성. set_idle_timeout 으로 설정.
    last_activity_ms: Mutex<i64>, // 프론트가 활동 시 touch. unlock 도 touch(즉시 재잠금 방지).
    lock_epoch: Mutex<u64>, // lock 마다 +1 — 프론트가 stale lock 상태 구분, broadcast 페이로드.
    // [R23] true 면 vault 가 있어야 한다(app.data 에 봉투 키 등록됨). 부팅 시 setup 이 설정 — vault 파일이
    // 없는데 이게 true 면 unlock 의 새 vault 자동생성을 거부한다(임의 passphrase 통과+전손 차단).
    expect_vault: Mutex<bool>,
}

// 현재 시각(ms) — auto-lock 판정·touch 용. data::now_millis 와 동일 계산(자기완결).
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// 프로덕션 볼트 경로: HOME → ~/.soksak/secrets.vault. data/mod.rs db_path 패턴.
// '주어진 경로로 동작' 과 분리(이 함수는 경로 계산만, 디렉토리 생성 포함).
// 순수 경로 계산 — mkdir 부수효과 없음(디렉토리 생성은 쓰기 시점의 것). 유닛테스트가 이 함수를
// 호출해도 사용자 홈에 흔적을 남기지 않는다(A17 — 실측: cargo test 가 ~/.soksak 을 재생성했었다).
pub fn default_vault_path() -> Result<PathBuf, String> {
    Ok(crate::home::soksak_home().join("secrets.vault"))
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

// ns 검증 — 일반 namespace는 plugin id와 동형(lower/digit/hyphen). `core_registry-*`는
// 레지스트리 credential 전용 core-owned class다. `_`는 plugin id 문법에 없으므로 app.secrets의
// ownership-fixed plugin namespace가 core credential owner와 alias될 수 없다.
fn validate_ns(ns: &str) -> Result<(), String> {
    let candidate = ns.strip_prefix("core_registry-").unwrap_or(ns);
    let mut chars = candidate.chars();
    let head = chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let rest = chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if head && rest {
        Ok(())
    } else {
        Err(format!("잘못된 ns: {ns:?}"))
    }
}

// 시크릿 key 검증 — 임의 식별자(영숫자·-·_·.). 빈 문자열 거부.
fn validate_key(key: &str) -> Result<(), String> {
    // ":" 허용 — "env:<VAR>" 규약(vault_env 동적 주입, PS9)의 접두 구분자. 키는 볼트 entries 맵의
    // 키로만 쓰이고 ns:key 로 인코딩되지 않으며 aad 에 실리지 않아 안전(경로·셸 주입 면역).
    if !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' || c == ':')
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
        let kek = derive_kek(
            passphrase,
            &salt,
            ARGON2_M_COST,
            ARGON2_T_COST,
            ARGON2_P_COST,
        )?;
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
        Ok((
            VaultData {
                header,
                entries: BTreeMap::new(),
            },
            kek,
        ))
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
        if let Some(parent) = tmp.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("볼트 디렉토리 생성 실패: {e}"))?;
        }
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
                let marker =
                    open(&kek, &h.verifier).map_err(|_| "잘못된 passphrase".to_string())?;
                if marker != VERIFIER_MARKER {
                    return Err("잘못된 passphrase".to_string());
                }
                (vault, kek)
            }
            None => {
                // [R23] vault 가 있어야 하는데(봉투 키 등록됨) 파일이 없으면 — 삭제·손실 의심. 임의
                // passphrase 로 새 vault 를 자동생성하면 그게 통과해 봉인 레코드가 영구 복호불가가 된다.
                // 거부하고 백업 vault 복원을 유도한다(전손 footgun 차단).
                if self.expect_vault.lock().map(|g| *g).unwrap_or(false) {
                    return Err(
                        "vault 파일 부재 + 암호화 키 등록됨 — 손실/삭제 의심. 임의 passphrase 로 새 vault 생성 거부(백업 복원 필요)"
                            .to_string(),
                    );
                }
                let (vault, kek) = Self::new_vault(pw)?;
                Self::flush(&path, &vault)?;
                (vault, kek)
            }
        };
        // Zeroizing 파생 KEK → 슬롯에 사본 저장(파생 본은 함수 끝에서 자동 스크럽).
        *self.kek.lock().map_err(|e| e.to_string())? = Some(*kek);
        *self.vault.lock().map_err(|e| e.to_string())? = Some(vault);
        self.touch(now_ms()); // unlock 직후 활동 기록 — idle 타이머가 즉시 재잠그지 않게.
        Ok(())
    }

    // lock: KEK 슬롯을 in-place zeroize → None. take() 의 로컬 사본이 아니라
    // Mutex 슬롯의 실제 32바이트를 직접 지운다(헤더의 '슬롯 in-place 스크럽' 보장과 일치).
    // 볼트 데이터(암호문)는 메모리에 남겨도 무해하나 함께 비운다. lock_epoch +1(전 창 broadcast 표식).
    pub fn lock(&self) -> Result<(), String> {
        let mut guard = self.kek.lock().map_err(|e| e.to_string())?;
        if let Some(k) = guard.as_mut() {
            k.zeroize();
        }
        *guard = None;
        *self.vault.lock().map_err(|e| e.to_string())? = None;
        if let Ok(mut g) = self.lock_epoch.lock() {
            *g = g.wrapping_add(1);
        }
        Ok(())
    }

    // [단계③] auto-lock — 활동 기록(프론트가 입력/포커스 시 touch). any-window 활동이 타이머를 리셋한다.
    pub fn touch(&self, now: i64) {
        if let Ok(mut g) = self.last_activity_ms.lock() {
            *g = now;
        }
    }

    // idle 타임아웃 설정(ms, 0=비활성). 음수는 0 으로 클램프.
    pub fn set_idle_timeout(&self, ms: i64) {
        if let Ok(mut g) = self.idle_timeout_ms.lock() {
            *g = ms.max(0);
        }
    }

    pub fn idle_timeout(&self) -> i64 {
        self.idle_timeout_ms.lock().map(|g| *g).unwrap_or(0)
    }

    pub fn lock_epoch(&self) -> u64 {
        self.lock_epoch.lock().map(|g| *g).unwrap_or(0)
    }

    // [R23] 부팅 시 app.data 에 봉투 키가 있으면 setup 이 true 로 — 그럼 vault 부재 시 새 vault 자동생성을 막는다.
    pub fn set_expect_vault(&self, expect: bool) {
        if let Ok(mut g) = self.expect_vault.lock() {
            *g = expect;
        }
    }

    // 지금 자동 잠금해야 하는가 — unlock 상태 + 타임아웃>0 + (now - 마지막활동) ≥ 타임아웃. 순수 판정
    // (now 주입)이라 테스트 가능. lib.rs 백그라운드 틱이 이걸 호출해 lock + broadcast.
    pub fn auto_lock_due(&self, now: i64) -> bool {
        if !self.is_unlocked() {
            return false;
        }
        let timeout = self.idle_timeout();
        if timeout <= 0 {
            return false;
        }
        let last = self.last_activity_ms.lock().map(|g| *g).unwrap_or(0);
        now.saturating_sub(last) >= timeout
    }

    pub fn is_unlocked(&self) -> bool {
        self.kek.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    // KEK 사본으로 클로저 실행(locked 면 Err). 락 가드 안에서 처리(누출 최소화).
    fn with_kek<T>(
        &self,
        f: impl FnOnce(&[u8; KEY_LEN]) -> Result<T, String>,
    ) -> Result<T, String> {
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
        vault
            .entries
            .entry(ns.to_string())
            .or_default()
            .insert(key.to_string(), item);
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
        let removed = vault
            .entries
            .get_mut(ns)
            .is_some_and(|m| m.remove(key).is_some());
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
pub fn test_state_with_secret(
    path: PathBuf,
    passphrase: &str,
    ns: &str,
    key: &str,
    value: &str,
) -> SecretsState {
    let s = SecretsState::default();
    s.set_path(path);
    s.unlock(passphrase).expect("test unlock");
    s.set(ns, key, value).expect("test set");
    s
}

// ── app.data 봉투 개인키 보관(단계②) ─────────────────────────────────────────
// app.data 비대칭 봉투의 개인키 S(32B)는 이 vault 에만 KEK wrap 으로 보관된다(공개키 P 는 data DB 의
// encryption_keys 평문 메타). 코어 예약 ns — 플러그인 secret.* 는 ns=pluginId 로 주입되므로 이 ns 에
// 닿지 못한다(접근제어 라벨). 봉인은 P 만 쓰므로 vault lock 중에도 가능, 개봉(S)만 unlock 필요(R12/R18).
pub const DATA_ENC_NS: &str = "core-data-enc";

impl SecretsState {
    // S(32B)를 vault 에 wrap 저장 — 암호화 활성/회전 시. unlock 필요(set 이 with_kek 게이트).
    pub fn put_data_key(&self, key_id: &str, secret: &[u8; 32]) -> Result<(), String> {
        self.set(DATA_ENC_NS, key_id, &STANDARD.encode(secret))
    }

    // keyId 의 S 를 vault 에서 unwrap. lock 이거나 미존재면 Ok(None)(복호 불가 → 읽기 경로가 게이트).
    pub fn get_data_key(&self, key_id: &str) -> Result<Option<[u8; 32]>, String> {
        if !self.is_unlocked() {
            return Ok(None);
        }
        let b64 = match self.resolve(DATA_ENC_NS, key_id) {
            Ok(v) => v,
            Err(_) => return Ok(None), // 미존재(잠김은 위에서 차단)
        };
        let raw = STANDARD.decode(b64).map_err(|e| e.to_string())?;
        if raw.len() != KEY_LEN {
            return Err("data key 길이 오류(32B 아님)".to_string());
        }
        let mut s = [0u8; KEY_LEN];
        s.copy_from_slice(&raw);
        Ok(Some(s))
    }

    // retired 키 폐기 시 S 를 vault 에서 제거(R18, count==0 검증은 data::crypto 가 선행).
    pub fn delete_data_key(&self, key_id: &str) -> Result<bool, String> {
        self.delete(DATA_ENC_NS, key_id)
    }
}

// ── 내부 평문 해소(Rust 전용 — process_spawn secret_env 주입) ────────────────
// pub fn 이지만 tauri::command 아님 → IPC/CLI 비노출. 평문은 호출자(process_spawn)가
// 자식 env 로만 흘린다(JS 로 반환 0, R2). 잠김=Err(vault locked), 미존재=Err.
pub fn resolve(state: &SecretsState, ns: &str, key: &str) -> Result<String, String> {
    state.resolve(ns, key)
}

// vault_env 주입(PS9) — ns 의 "env:" 접두 볼트 키를 (환경변수명, 평문) 쌍으로 해소한다. "env:" 규약은
// 1판 buildSecretEnvMap 과 동형(사용자 구성 env 시크릿). 잠김/미존재/해소 실패면 그 키는 건너뛴다
// (빈 벡터 가능 — loud 실패 아님, 1판 세션-env 폴백과 동형). 평문은 호출자(스폰 env 경계)만 만진다.
pub fn env_secrets(state: &SecretsState, ns: &str) -> Vec<(String, String)> {
    let keys = match state.keys(ns) {
        Ok(k) => k,
        Err(_) => return vec![],
    };
    let mut out = Vec::new();
    for k in keys {
        let Some(var) = k.strip_prefix("env:") else {
            continue;
        };
        if var.is_empty() {
            continue;
        }
        if let Ok(plain) = state.resolve(ns, &k) {
            out.push((var.to_string(), plain));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0)); // 결정적 순서(테스트·재현).
    out
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
pub fn secret_unlock(
    app: AppHandle,
    passphrase: String,
    state: State<'_, SecretsState>,
) -> Result<(), String> {
    state.unlock(&passphrase)?;
    // [단계④] unlock 성공 → 전 창 broadcast. 프론트가 잠금 중 폐기한 화면을 sealed 기록에서 재-hydrate
    // (R14 dispose↔re-hydrate 사이클). lock 과 대칭 채널.
    let _ = app.emit("secrets-unlocked", state.lock_epoch());
    Ok(())
}

// lock + 전 창 broadcast("secrets-locked", lock_epoch). 수동 lock 과 idle 자동 lock 모두 이 경로로 알린다
// → 프론트가 잠금 UI 전환·터미널 폐기(R14) 등 반응. 단일 vault·단일 KEK 라 한 번 lock 이 프로세스 전역.
pub fn lock_and_broadcast(app: &AppHandle, state: &SecretsState) -> Result<(), String> {
    state.lock()?;
    let _ = app.emit("secrets-locked", state.lock_epoch());
    Ok(())
}

#[tauri::command]
pub fn secret_lock(app: AppHandle, state: State<'_, SecretsState>) -> Result<(), String> {
    lock_and_broadcast(&app, &state)
}

// [단계③] idle 활동 기록 — 프론트가 입력/포커스/명령 시 호출(디바운스). any-window 활동이 타이머 리셋.
#[tauri::command]
pub fn secret_touch(state: State<'_, SecretsState>) {
    state.touch(now_ms());
}

// idle 자동잠금 타임아웃(ms, 0=비활성) 설정. 프론트 설정값 반영.
#[tauri::command]
pub fn secret_autolock(ms: i64, state: State<'_, SecretsState>) {
    state.set_idle_timeout(ms);
}

#[derive(Serialize)]
pub struct LockInfo {
    pub unlocked: bool,
    pub idle_timeout_ms: i64,
    pub lock_epoch: u64,
}

// 잠금 상태 조회 — 프론트가 현재 unlock 여부·타임아웃·epoch 를 읽어 UI 동기화.
#[tauri::command]
pub fn secret_lock_info(state: State<'_, SecretsState>) -> LockInfo {
    LockInfo {
        unlocked: state.is_unlocked(),
        idle_timeout_ms: state.idle_timeout(),
        lock_epoch: state.lock_epoch(),
    }
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
pub fn secret_delete(
    ns: String,
    key: String,
    state: State<'_, SecretsState>,
) -> Result<bool, String> {
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
        derive_kek(
            b"correct horse",
            b"salt-aaaa-bbbb-cc",
            ARGON2_M_COST,
            ARGON2_T_COST,
            ARGON2_P_COST,
        )
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
        let iso = std::env::temp_dir()
            .join("soksak-vault-override-test")
            .join("secrets.vault");
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
        let empty = resolve_vault_path(|k| {
            if k == "SOKSAK_VAULT_PATH" {
                Some(String::new())
            } else {
                None
            }
        })
        .unwrap();
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
        let wrong = derive_kek(
            b"wrong pass",
            b"salt-aaaa-bbbb-cc",
            ARGON2_M_COST,
            ARGON2_T_COST,
            ARGON2_P_COST,
        )
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

    // Registry credentials live in a core-owned namespace class containing `_`. Plugin ids
    // cannot contain `_`, so a plugin's ownership-fixed app.secrets namespace can never alias it.
    #[test]
    fn core_registry_namespace_is_disjoint_and_supported() {
        let (s, dir) = state_with_tmp_vault("core-registry-ns");
        s.unlock("pw").unwrap();
        s.set("core_registry-corp", "http-authorization", "Bearer private")
            .expect("core registry namespace must be a valid vault owner");
        assert!(s.has("core_registry-corp", "http-authorization").unwrap());
        assert!(s.set("plugin_with_underscore", "token", "bad").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // env_secrets(PS9) — ns 의 "env:" 접두 키만 (환경변수명, 평문)으로, 접두 벗기고 정렬. 비-env 키·
    // 잠김은 제외. 서비스 vault_env 동적 주입의 바닥(1판 buildSecretEnvMap 등가).
    #[test]
    fn env_secrets_resolves_env_prefixed_keys() {
        let (s, dir) = state_with_tmp_vault("envsec");
        s.unlock("pw").expect("unlock");
        s.set("wf", "env:ANTHROPIC_AUTH_TOKEN", "tok")
            .expect("set token");
        s.set("wf", "env:CLAUDE_ACCOUNT_NAME", "acct")
            .expect("set acct");
        s.set("wf", "apiKey", "not-env").expect("set non-env"); // 비-env 키는 제외
        let got = env_secrets(&s, "wf");
        assert_eq!(
            got,
            vec![
                ("ANTHROPIC_AUTH_TOKEN".to_string(), "tok".to_string()),
                ("CLAUDE_ACCOUNT_NAME".to_string(), "acct".to_string()),
            ],
            "env: 키만, 접두 제거, 정렬"
        );
        // 잠금 → 빈 벡터(loud 실패 아님).
        s.lock().expect("lock");
        assert!(env_secrets(&s, "wf").is_empty(), "잠김이면 빈 벡터");
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
        assert_ne!(
            public_from_secret(&s2),
            p,
            "다른 S → 다른 P(스왑 탐지 가능)"
        );
    }

    // (asym-c, blocker high) AAD 불일치 → open Err. scope 만 바뀐 AAD 로 개봉 거부(교차-scope 누출 0).
    #[test]
    fn asym_aad_mismatch_rejected() {
        let (s, p) = gen_asym_keypair();
        let boxed = seal_to(&p, b"value", AAD1).unwrap();
        assert!(
            open_sealed(&s, &boxed, AAD2).is_err(),
            "다른 AAD 면 개봉 거부"
        );
        assert!(open_sealed(&s, &boxed, b"").is_err(), "빈 AAD 면 개봉 거부");
        assert_eq!(open_sealed(&s, &boxed, AAD1).unwrap(), b"value"); // 정합 AAD 는 성공
    }

    // (asym-d) 잘못된 개인키 → open Err. 변조(ct/eph_pk) → open Err(평문 누출 0).
    #[test]
    fn asym_wrong_key_and_tamper_rejected() {
        let (_s, p) = gen_asym_keypair();
        let (s_other, _p2) = gen_asym_keypair();
        let boxed = seal_to(&p, b"value", AAD1).unwrap();
        assert!(
            open_sealed(&s_other, &boxed, AAD1).is_err(),
            "타 개인키 거부"
        );
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

    // (r24, B10) recovery code — S 를 코드로 wrap/unwrap 라운드트립. 잘못된 코드 거부. 구분자/대소문자
    // 무관 정규화. 코드는 typeable(Crockford base32, 혼동문자 없음).
    #[test]
    fn recovery_code_roundtrip() {
        let (s, _p) = gen_asym_keypair();
        let code = gen_recovery_code();
        // 코드 형식 — 대시 그룹, 혼동문자(I L O U) 없음.
        assert!(code.contains('-'), "그룹 구분 대시");
        for c in code.chars().filter(|c| *c != '-') {
            assert!(
                "0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(c),
                "Crockford 문자만: {c}"
            );
        }
        let (salt, sealed) = recovery_wrap(&code, &s).unwrap();
        // 정확한 코드 → 복구.
        assert_eq!(
            recovery_unwrap(&code, &salt, &sealed).unwrap(),
            s,
            "코드로 S 복구"
        );
        // 구분자/소문자 섞어도 동일(정규화).
        let messy = code.to_lowercase().replace('-', " ");
        assert_eq!(
            recovery_unwrap(&messy, &salt, &sealed).unwrap(),
            s,
            "정규화 후 동일 복구"
        );
        // 잘못된 코드 → 거부(AEAD).
        assert!(
            recovery_unwrap("WRONG-CODE-0000", &salt, &sealed).is_err(),
            "잘못된 코드 거부"
        );
        // blob 직렬화 라운드트립.
        let blob = RecoveryBlob {
            salt: salt.clone(),
            sealed: sealed.clone(),
        };
        let json = serde_json::to_string(&blob).unwrap();
        let back: RecoveryBlob = serde_json::from_str(&json).unwrap();
        assert_eq!(recovery_unwrap(&code, &back.salt, &back.sealed).unwrap(), s);
    }

    // (r23, B8) vault must-exist — 키가 등록된 상태(expect_vault)에서 vault 파일이 없으면 unlock 이 새
    // vault 자동생성을 거부한다(임의 passphrase 통과+전손 차단). expect 없으면 정상 생성(첫 실행).
    #[test]
    fn vault_must_exist_gate() {
        let (s, dir) = state_with_tmp_vault("mustexist");
        // 첫 실행 — expect 없음 → 새 vault 생성 정상.
        s.unlock("pw").unwrap();
        s.lock().unwrap();
        // vault 파일 삭제(손실 모의) + expect_vault 켜기(키 등록됨 가정).
        let path = s.vault_file().unwrap();
        std::fs::remove_file(&path).unwrap();
        s.set_expect_vault(true);
        // 임의 passphrase 로 unlock 시도 → 거부(새 vault 자동생성 안 함).
        assert!(
            s.unlock("any-passphrase").is_err(),
            "vault 부재+키등록 → 자동생성 거부"
        );
        // expect 끄면(키 없음) 다시 생성 허용.
        s.set_expect_vault(false);
        assert!(s.unlock("pw").is_ok(), "expect 없으면 새 vault 생성 허용");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // (lock-a, 단계③) auto_lock_due 판정 — lock 이면 false, 타임아웃 0 이면 false, idle 경과 시 true,
    // touch 가 타이머를 리셋. lock_epoch 가 lock 마다 증가.
    #[test]
    fn auto_lock_policy() {
        let (s, dir) = state_with_tmp_vault("autolock");
        // 잠김 상태 — 타임아웃 무관 false.
        s.set_idle_timeout(1000);
        assert!(!s.auto_lock_due(now_ms()), "lock 상태면 자동잠금 대상 아님");

        s.unlock("pw").unwrap();
        let e0 = s.lock_epoch();
        // 타임아웃 0 = 비활성.
        s.set_idle_timeout(0);
        assert!(!s.auto_lock_due(1_000_000), "타임아웃 0 = 비활성");
        // 타임아웃 1000ms, 마지막 활동 t=10_000.
        s.set_idle_timeout(1000);
        s.touch(10_000);
        assert!(!s.auto_lock_due(10_500), "0.5s 경과 < 1s → 잠금 아님");
        assert!(s.auto_lock_due(11_000), "1s 경과 = 1s → 잠금");
        assert!(s.auto_lock_due(99_999), "한참 idle → 잠금");
        // touch 가 타이머 리셋.
        s.touch(99_000);
        assert!(
            !s.auto_lock_due(99_500),
            "touch 후 0.5s → 잠금 아님(any-window 활동 reset)"
        );

        // lock 하면 epoch +1, 이후 auto_lock_due false(이미 잠김).
        s.lock().unwrap();
        assert_eq!(s.lock_epoch(), e0 + 1, "lock 마다 epoch 증가");
        assert!(!s.auto_lock_due(99_999), "잠긴 뒤엔 대상 아님");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // (asym-f) app.data 봉투 개인키 vault 보관 — wrap/unwrap 라운드트립, lock 게이트, 디스크 영속, 삭제.
    #[test]
    fn data_key_vault_roundtrip() {
        let (s, dir) = state_with_tmp_vault("datakey");
        // lock 상태 — get 은 None(복호 불가).
        assert!(s.get_data_key("key-1").unwrap().is_none(), "lock 이면 None");
        s.unlock("pw").unwrap();
        let (sk, _p) = gen_asym_keypair();
        s.put_data_key("key-1", &sk).unwrap();
        assert_eq!(
            s.get_data_key("key-1").unwrap().unwrap(),
            sk,
            "KEK wrap/unwrap 라운드트립"
        );
        assert!(s.get_data_key("key-2").unwrap().is_none(), "미존재 키 None");
        // lock 후 None, 재 unlock 시 디스크에서 복원(영속).
        s.lock().unwrap();
        assert!(s.get_data_key("key-1").unwrap().is_none(), "lock 후 None");
        s.unlock("pw").unwrap();
        assert_eq!(
            s.get_data_key("key-1").unwrap().unwrap(),
            sk,
            "재 unlock 복원"
        );
        assert!(s.delete_data_key("key-1").unwrap());
        assert!(s.get_data_key("key-1").unwrap().is_none(), "삭제 후 None");
        let _ = std::fs::remove_dir_all(&dir);
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
