// OS 키체인 device KEK — 볼트 KEK(32B)를 OS 보안 저장소(macOS Keychain / Windows Credential
// Manager / Linux Secret Service)에 get-or-create 하는 단일책임 모듈. 이 KEK 로 볼트를 어떻게 여는지
// (secrets.rs 투명 언락 배선)는 이 모듈이 모른다 — 여기는 오직 "32B KEK 바이트를 OS 저장소에서
// get-or-create" 만 책임진다(단일 책임). 볼트·Argon2·verifier 를 전혀 모른다.
//
// ── 안전핀(fail-loud) ────────────────────────────────────────────────────────
// 무음 폴백·무음 재생성 절대 금지. 헤드리스 Linux/무 D-Bus 세션/잠긴 컬렉션은 StoreUnavailable 로
// 표면화한다(파일 키 무음 생성 = P0 가 지운 SOKSAK_VAULT_KEY 백도어 재도입이므로 금지). 저장 blob 이
// 32B base64 가 아니면 Corrupt — 새 KEK 를 무음 발급하면 옛 KEK 로 wrap 된 볼트가 영구 복호불가(전손).
//
// ── 메모리 위생(zeroize) — 실제 스크럽 범위(거짓 주장 0) ─────────────────────────
// 반환 KEK 는 Zeroizing<[u8;32]> — 호출자 drop 시 자동 스크럽(컴파일 타임 보장). 생성 시 랜덤 raw·
// base64 중간 문자열·decode 중간 Vec 은 Zeroizing/명시 zeroize 로 소거. 한계(정직): keyring 플랫폼
// impl 내부 버퍼(get_password 가 만드는 String 등 크레이트 경계 밖)는 우리가 닿지 못한다 — 비보장.
//
// ── 서비스 신원 격리 ──────────────────────────────────────────────────────────
// 키체인 서비스명 = home::identifier() → dev/debug/release 가 KEK 를 공유하지 않는다(home.rs identity
// 격리 규칙 이식). account = "device-kek-v1"(버전드 — 미래 마이그레이션). 앱 신원 ACL 결속.
//
// ── 단일 인스턴스 전제 ────────────────────────────────────────────────────────
// ipc.rs 소켓 선점으로 단일 인스턴스라 두 프로세스 동시 create TOCTOU 는 실질 무시 가능. read→(없으면)
// write 순서라 최악의 경우도 마지막 write 승.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use zeroize::{Zeroize, Zeroizing};

pub const KEK_LEN: usize = 32;

// 반환 KEK — drop 시 자동 스크럽.
pub type OsKek = Zeroizing<[u8; KEK_LEN]>;

// 에러 타입 — String 관례를 의도적으로 벗어난 typed enum. 헤드리스 감지가 호출부의 분기(무음 폴백
// 금지)를 강제하므로 String 으론 부족하다(패턴매치 불가). 상위 경계는 String 으로 축약할 수 있다.
#[derive(Debug)]
pub enum OsKeyError {
    /// 키체인 미도달(헤드리스 Linux/무 D-Bus 세션/잠긴 컬렉션). 무음 폴백 금지 신호.
    StoreUnavailable(String),
    /// 키체인 도달했으나 연산 실패(쓰기 거부/모호/plat 실패).
    StoreFailure(String),
    /// 저장 blob 이 32B base64 아님. 재생성 금지(전손 차단) — 명시 실패.
    Corrupt(String),
}

impl std::fmt::Display for OsKeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OsKeyError::StoreUnavailable(m) => write!(f, "OS 키체인 미도달: {m}"),
            OsKeyError::StoreFailure(m) => write!(f, "OS 키체인 연산 실패: {m}"),
            OsKeyError::Corrupt(m) => write!(f, "OS 키체인 KEK 손상: {m}"),
        }
    }
}

impl std::error::Error for OsKeyError {}

// 테스트 seam — 실제 키체인 미접촉을 위한 주입 경계(resolve_vault_path 의 env 클로저 선례와 동형).
pub trait SecretStore {
    /// 미존재=Ok(None), 미도달=Err(StoreUnavailable).
    fn read(&self) -> Result<Option<String>, OsKeyError>;
    fn write(&self, secret: &str) -> Result<(), OsKeyError>;
}

// 핵심 — get-or-create. store 를 인자로 받는다(전역·env·set_var 0). 없으면 랜덤 32B 생성·영속·반환.
// Corrupt/StoreUnavailable 은 그대로 전파(무음 재생성·무음 폴백 절대 금지).
pub fn get_or_create_kek(store: &impl SecretStore) -> Result<OsKek, OsKeyError> {
    match store.read()? {
        Some(encoded) => decode_kek(&encoded),
        None => {
            let mut raw: OsKek = Zeroizing::new([0u8; KEK_LEN]);
            OsRng.fill_bytes(raw.as_mut());
            // 인코딩 중간 문자열도 비밀이라 Zeroizing 으로 감싸 drop 시 소거.
            let encoded = Zeroizing::new(STANDARD.encode(raw.as_ref()));
            store.write(&encoded)?;
            Ok(raw)
        }
    }
}

// base64 → [u8;32]. 길이 불일치·디코드 실패는 Corrupt(재생성 금지 안전핀). 중간 Vec 즉시 zeroize.
fn decode_kek(encoded: &str) -> Result<OsKek, OsKeyError> {
    let mut decoded = STANDARD
        .decode(encoded.as_bytes())
        .map_err(|e| OsKeyError::Corrupt(format!("base64 아님: {e}")))?;
    if decoded.len() != KEK_LEN {
        let got = decoded.len();
        decoded.zeroize();
        return Err(OsKeyError::Corrupt(format!(
            "KEK 길이 {got}B (기대 {KEK_LEN}B)"
        )));
    }
    let mut kek: OsKek = Zeroizing::new([0u8; KEK_LEN]);
    kek.copy_from_slice(&decoded);
    decoded.zeroize();
    Ok(kek)
}

// 프로덕션 store — keyring::Entry. 서비스=home::identifier()(dev/debug/release 격리, home.rs 단일진실),
// account="device-kek-v1"(버전드). 앱 신원 ACL 결속 → 타 호출 위치는 OS 가 조회 거부.
pub struct OsKeyStore {
    service: String,
    account: String,
}

impl OsKeyStore {
    pub fn app() -> Self {
        Self {
            service: crate::home::identifier(),
            account: "device-kek-v1".to_string(),
        }
    }
}

// keyring::Error 분류 — NoStorageAccess/PlatformFailure 는 StoreUnavailable(헤드리스·잠금·무 D-Bus),
// 그 외는 StoreFailure. NoEntry 는 read 에서 Ok(None) 로 별도 처리(여기로 오지 않는다).
fn classify(err: keyring::Error) -> OsKeyError {
    match err {
        keyring::Error::NoStorageAccess(inner) => OsKeyError::StoreUnavailable(inner.to_string()),
        keyring::Error::PlatformFailure(inner) => OsKeyError::StoreUnavailable(inner.to_string()),
        other => OsKeyError::StoreFailure(other.to_string()),
    }
}

impl SecretStore for OsKeyStore {
    fn read(&self) -> Result<Option<String>, OsKeyError> {
        let entry = keyring::Entry::new(&self.service, &self.account).map_err(classify)?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(other) => Err(classify(other)),
        }
    }

    fn write(&self, secret: &str) -> Result<(), OsKeyError> {
        let entry = keyring::Entry::new(&self.service, &self.account).map_err(classify)?;
        entry.set_password(secret).map_err(classify)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // 인메모리 store — 실 키체인 미접촉(set_var 0, keyring 미호출). write 횟수를 기록해
    // "무음 재생성 없음"(Corrupt 시 write 미호출)까지 검증한다.
    struct MemoryKeyStore {
        slot: Mutex<Option<String>>,
        writes: Mutex<u32>,
    }

    impl MemoryKeyStore {
        fn empty() -> Self {
            Self {
                slot: Mutex::new(None),
                writes: Mutex::new(0),
            }
        }
        fn seeded(value: &str) -> Self {
            Self {
                slot: Mutex::new(Some(value.to_string())),
                writes: Mutex::new(0),
            }
        }
        fn writes(&self) -> u32 {
            *self.writes.lock().unwrap()
        }
        fn peek(&self) -> Option<String> {
            self.slot.lock().unwrap().clone()
        }
    }

    impl SecretStore for MemoryKeyStore {
        fn read(&self) -> Result<Option<String>, OsKeyError> {
            Ok(self.slot.lock().unwrap().clone())
        }
        fn write(&self, secret: &str) -> Result<(), OsKeyError> {
            *self.writes.lock().unwrap() += 1;
            *self.slot.lock().unwrap() = Some(secret.to_string());
            Ok(())
        }
    }

    // 헤드리스/무 D-Bus 시뮬레이션 — read/write 가 항상 StoreUnavailable.
    struct UnavailableStore;
    impl SecretStore for UnavailableStore {
        fn read(&self) -> Result<Option<String>, OsKeyError> {
            Err(OsKeyError::StoreUnavailable("no secret-service".to_string()))
        }
        fn write(&self, _secret: &str) -> Result<(), OsKeyError> {
            Err(OsKeyError::StoreUnavailable("no secret-service".to_string()))
        }
    }

    // 생성 후 재조회 안정 — 같은 store 로 2회 호출 시 동일 KEK, 2회차는 write 안 함.
    #[test]
    fn create_then_read_stable() {
        let store = MemoryKeyStore::empty();
        let first = get_or_create_kek(&store).expect("create");
        let second = get_or_create_kek(&store).expect("read back");
        assert_eq!(first.as_ref(), second.as_ref(), "생성 후 재조회 안정");
        assert_eq!(store.writes(), 1, "재조회는 write 안 함(기존 값 반환)");
    }

    // 서로 다른 빈 store 2개 → 서로 다른 KEK(OsRng 랜덤 확인).
    #[test]
    fn absent_stores_yield_random() {
        let a = get_or_create_kek(&MemoryKeyStore::empty()).expect("a");
        let b = get_or_create_kek(&MemoryKeyStore::empty()).expect("b");
        assert_ne!(a.as_ref(), b.as_ref(), "빈 store 2개 → 서로 다른 랜덤 KEK");
    }

    // 손상 blob → Err(Corrupt), 그리고 write 미호출·슬롯 불변(무음 재생성 금지 회귀 가드).
    #[test]
    fn corrupt_blob_rejected() {
        // (1) 비-base64
        let bad = MemoryKeyStore::seeded("not-base64!!");
        let before = bad.peek();
        assert!(
            matches!(get_or_create_kek(&bad), Err(OsKeyError::Corrupt(_))),
            "비base64 → Corrupt"
        );
        assert_eq!(bad.writes(), 0, "Corrupt 는 재생성(write) 금지");
        assert_eq!(bad.peek(), before, "슬롯 값 불변(무음 재생성 없음)");

        // (2) 31B — 유효 base64지만 32B 미달
        let short = STANDARD.encode([7u8; 31]);
        let bad2 = MemoryKeyStore::seeded(&short);
        assert!(
            matches!(get_or_create_kek(&bad2), Err(OsKeyError::Corrupt(_))),
            "31B → Corrupt"
        );
        assert_eq!(bad2.writes(), 0, "길이 미달도 재생성 금지");
    }

    // 미도달 store → get_or_create_kek 이 Err(StoreUnavailable) 전파(Ok 폴백 아님). 무음 폴백 금지 가드.
    #[test]
    fn unavailable_surfaces_error() {
        let result = get_or_create_kek(&UnavailableStore);
        assert!(
            matches!(result, Err(OsKeyError::StoreUnavailable(_))),
            "무음 폴백 금지 — StoreUnavailable 를 그대로 표면화해야"
        );
    }

    // decode_kek 경계 단위 — 정확히 32B 만 통과, 그 외 길이·디코드 실패는 Corrupt.
    #[test]
    fn decode_length_gate() {
        let exact = STANDARD.encode([9u8; KEK_LEN]);
        assert_eq!(decode_kek(&exact).unwrap().as_ref(), &[9u8; KEK_LEN]);

        let long = STANDARD.encode([1u8; 33]);
        assert!(
            matches!(decode_kek(&long), Err(OsKeyError::Corrupt(_))),
            "33B → Corrupt"
        );
        assert!(
            matches!(decode_kek("@@@@"), Err(OsKeyError::Corrupt(_))),
            "디코드 실패 → Corrupt"
        );
    }

    // zeroize 는 drop 스크럽이라 직접 관측 불가 — 정직하게 타입으로만 증명한다. 반환 타입이
    // Zeroizing<[u8;32]> 임을 컴파일 타임에 강제(이게 아니면 컴파일 실패). 크레이트 경계 밖 스크럽은 비보장.
    #[test]
    fn kek_is_zeroizing_typed() {
        fn assert_zeroizing(_: &Zeroizing<[u8; KEK_LEN]>) {}
        let kek = get_or_create_kek(&MemoryKeyStore::empty()).expect("create");
        assert_zeroizing(&kek);
    }
}
