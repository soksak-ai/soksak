// remote::pairing — 데스크톱 소유 페어링 설정(헤드리스 QR 등가물). PART A: additive 배선.
//
// 이 모듈은 floor 로직(auth/noise)을 **건드리지 않는다** — 그 floor 들의 PUBLIC API
// (PinnedPeerRegistry::pin / DeviceRegistry::pair / StaticKeypair::from_parts)만 호출해
// 라이브 레지스트리를 채운다. bridge.rs 가 켜질 때(SOKSAK_REMOTE_TCP/_IROH/_TUNNEL) 이
// 모듈로 (1) 데스크톱 static 키를 영속 로드하고 (2) 페어링된 기기를 핀닝한다.
//
// 절대 불변식(RULE 0 — 뚫리면 끝):
//   - **폰은 스스로 페어링 못 한다**(anti-escalation): 핀닝 엔트리는 오직 이 데스크톱 소유
//     설정(파일/env)에서만 온다. 폰이 보내는 어떤 frame 도 이 함수들에 닿지 않는다 —
//     bridge.rs 가 부팅 시 1회 호출할 뿐이고, serve_connection 은 페어링을 변이하는 경로가
//     없다. 즉 "페어링 설정"은 데스크톱 디스크/환경에만 존재한다(폰-도달 불가).
//   - **빈 설정 ⇒ fail-closed**: 페어링 기기가 0이면 어떤 연결도 핸드셰이크 미성립
//     (noise floor 가 미핀닝 peer 를 거부). "켬"이 곧 "접근 허용"이 아니다.
//   - **malformed ⇒ 거부(조용한 bad-key 핀닝 0)**: 키 길이/hex/scope 가 틀린 엔트리는
//     Err 로 거부하고 그 기기를 핀닝하지 않는다. 부분 엔트리(키 하나 누락)도 거부.
//   - 데스크톱 static 개인키는 **데스크톱 소유 위치**(앱 config 디렉터리 또는 env 경로)에만
//     영속된다 — 폰-도달 불가. 공개키만 노출(페어링 표시용 — RULE 4/8).
#![allow(dead_code)]

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::remote::auth::{DeviceRegistry, Scope};
use crate::remote::noise::{StaticKeypair, X25519_KEY_LEN};

// ===========================================================================
// 0. env 키 — 데스크톱 소유 설정의 단일 진실(RULE 8 observable). 폰은 이걸 못 바꾼다.
// ===========================================================================

/// 데스크톱 X25519 static 키쌍 영속 파일 경로(선택). 미설정 ⇒ 앱 config 디렉터리 default.
/// **데스크톱 소유** — 폰-도달 불가. 첫 실행 시 생성·저장, 이후 로드(안정적 데스크톱 키).
pub const DESKTOP_KEY_PATH_ENV: &str = "SOKSAK_REMOTE_DESKTOP_KEY_PATH";

/// 페어링된 기기 설정 파일 경로(선택). 미설정 ⇒ 앱 config 디렉터리 default(paired-devices.json).
/// **데스크톱 소유** — 폰은 이 파일을 못 쓴다. 핀닝 엔트리의 유일한 출처(anti-escalation).
pub const PAIRED_DEVICES_PATH_ENV: &str = "SOKSAK_REMOTE_PAIRED_DEVICES";

/// 페어링된 기기를 **인라인 JSON** 으로 주는 env(선택, E2E/헤드리스 편의). 파일과 동일 스키마
/// (JSON 배열). 설정 시 파일보다 우선한다. 역시 **데스크톱 소유** — 폰-도달 불가.
pub const PAIRED_DEVICES_JSON_ENV: &str = "SOKSAK_REMOTE_PAIRED_DEVICES_JSON";

/// auth DeviceRegistry 의 max_devices(선택). 미설정 ⇒ 기본 8.
pub const MAX_DEVICES_ENV: &str = "SOKSAK_REMOTE_MAX_DEVICES";

// ===========================================================================
// 1. 설정 에러 — fail-closed 의 명시적 분류(조용한 bad-key 0).
// ===========================================================================

/// 페어링 설정 로드/파싱 실패 사유. 어떤 사유든 그 엔트리는 핀닝되지 않는다(fail-closed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairingConfigError {
    /// JSON 파싱 실패(전체 설정).
    BadJson(String),
    /// hex 디코드 실패 또는 길이 불량(32B 아님) — 키 바이트 형식 불량.
    BadKeyHex { device_id: String, field: String },
    /// scope 문자열이 read-only|write|destructive 가 아님.
    BadScope { device_id: String, scope: String },
    /// device_id 가 빈 문자열.
    EmptyDeviceId,
    /// noise 핀닝 거부(PinnedPeerRegistry::pin — InvalidKey/KeyMismatch).
    NoisePinRejected { device_id: String },
    /// auth 페어링 거부(DeviceRegistry::pair — InvalidKey/KeyMismatch/CapacityExceeded).
    AuthPairRejected { device_id: String },
}

impl std::fmt::Display for PairingConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PairingConfigError::BadJson(e) => write!(f, "pairing config JSON 파싱 실패: {e}"),
            PairingConfigError::BadKeyHex { device_id, field } => {
                write!(f, "기기 '{device_id}' 의 {field} 키 hex/길이 불량")
            }
            PairingConfigError::BadScope { device_id, scope } => {
                write!(f, "기기 '{device_id}' 의 scope '{scope}' 불량")
            }
            PairingConfigError::EmptyDeviceId => f.write_str("device_id 가 빈 문자열"),
            PairingConfigError::NoisePinRejected { device_id } => {
                write!(f, "기기 '{device_id}' noise 핀닝 거부(InvalidKey/KeyMismatch)")
            }
            PairingConfigError::AuthPairRejected { device_id } => {
                write!(f, "기기 '{device_id}' auth 페어링 거부(InvalidKey/한도/KeyMismatch)")
            }
        }
    }
}

impl std::error::Error for PairingConfigError {}

// ===========================================================================
// 2. PairedDeviceEntry — 설정 1줄(한 기기). 데스크톱이 페어링 때 핀닝하는 두 공개키 + scope.
// ===========================================================================

/// 페어링된 기기 1대의 설정 엔트리(JSON). QR 페어링이 데스크톱에 넘기는 것과 동형:
/// device_id + 폰의 두 공개키(x25519=Noise 채널, ed25519=assertion) + 데스크톱이 부여하는 scope.
///
/// 키는 hex 문자열(64자 = 32B). scope 는 "read-only" | "write" | "destructive"(kebab-case).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairedDeviceEntry {
    pub device_id: String,
    /// 폰의 X25519 static **공개**키 hex(Noise 핀닝 — PinnedPeerRegistry::pin).
    pub x25519_pub: String,
    /// 폰의 Ed25519 **공개**키 hex(assertion 핀닝 — DeviceRegistry::pair).
    pub ed25519_pub: String,
    /// 데스크톱이 이 기기에 부여하는 최대 권한.
    pub granted_scope: String,
}

impl PairedDeviceEntry {
    /// scope 문자열 → Scope(엄격 매칭, 미상은 거부 — fail-closed).
    fn parse_scope(&self) -> Result<Scope, PairingConfigError> {
        match self.granted_scope.trim().to_ascii_lowercase().as_str() {
            "read-only" | "readonly" | "read_only" => Ok(Scope::ReadOnly),
            "write" => Ok(Scope::Write),
            "destructive" => Ok(Scope::Destructive),
            other => Err(PairingConfigError::BadScope {
                device_id: self.device_id.clone(),
                scope: other.to_string(),
            }),
        }
    }

    /// x25519/ed25519 공개키 hex → 32B(둘 다). 길이/hex 불량은 거부(조용한 bad-key 0).
    fn parse_keys(&self) -> Result<([u8; 32], [u8; 32]), PairingConfigError> {
        let x = decode_hex32(&self.x25519_pub).ok_or_else(|| PairingConfigError::BadKeyHex {
            device_id: self.device_id.clone(),
            field: "x25519_pub".into(),
        })?;
        let e = decode_hex32(&self.ed25519_pub).ok_or_else(|| PairingConfigError::BadKeyHex {
            device_id: self.device_id.clone(),
            field: "ed25519_pub".into(),
        })?;
        Ok((x, e))
    }
}

/// 파싱·검증된 페어링 설정 — 핀닝 직전의 typed 형태(키 32B + Scope). 순수 함수가 만든다
/// (디스크/registry 무관) → 테스트가 "phone-supplied bytes 가 registry 를 변이 못 함" 을 단언 가능.
#[derive(Debug, Clone)]
pub struct ValidatedDevice {
    pub device_id: String,
    pub x25519_pub: [u8; X25519_KEY_LEN],
    pub ed25519_pub: [u8; 32],
    pub scope: Scope,
}

/// 설정 엔트리 목록을 **검증만** 한다(핀닝 0 — 순수). 하나라도 형식 불량이면 Err(그 엔트리
/// 사유). 전부 통과해야 Ok(검증된 목록). device_id 빈 문자열도 거부.
///
/// 이 함수는 registry 를 받지 않는다 — 그러므로 어떤 입력 바이트도 registry 를 변이할 수 없다
/// (PART A 테스트의 핵심: phone-supplied 바이트는 검증 단계를 못 넘으면 registry 근처도 못 간다).
pub fn validate_entries(
    entries: &[PairedDeviceEntry],
) -> Result<Vec<ValidatedDevice>, PairingConfigError> {
    let mut out = Vec::with_capacity(entries.len());
    for e in entries {
        if e.device_id.trim().is_empty() {
            return Err(PairingConfigError::EmptyDeviceId);
        }
        let scope = e.parse_scope()?;
        let (x25519_pub, ed25519_pub) = e.parse_keys()?;
        out.push(ValidatedDevice {
            device_id: e.device_id.clone(),
            x25519_pub,
            ed25519_pub,
            scope,
        });
    }
    Ok(out)
}

/// 검증된 기기 목록을 라이브 레지스트리에 핀닝한다(noise + auth, 단일 진실 한 쌍). floor 의
/// PUBLIC API 만 호출 — 핀닝 거부(InvalidKey/KeyMismatch/한도)는 Err 로 환원(조용한 bad-key 0).
///
/// noise.pin(x25519) + auth.pair(ed25519, scope) 를 같은 device_id 로 — session.rs 의 기기-신원
/// 결속(채널 peer ≡ assertion device)이 성립한다. 한 엔트리라도 거부되면 Err(이미 핀닝된 앞
/// 엔트리는 남지만, 호출자는 부팅 시 1회 빈 registry 에 적용하므로 부분 적용은 곧 그 부팅의 상태).
pub fn pin_devices(
    devices: &[ValidatedDevice],
    noise: &mut crate::remote::noise::PinnedPeerRegistry,
    auth: &mut DeviceRegistry,
) -> Result<(), PairingConfigError> {
    for d in devices {
        noise
            .pin(&d.device_id, &d.x25519_pub)
            .map_err(|_| PairingConfigError::NoisePinRejected {
                device_id: d.device_id.clone(),
            })?;
        auth.pair(&d.device_id, &d.ed25519_pub, d.scope).map_err(|_| {
            PairingConfigError::AuthPairRejected {
                device_id: d.device_id.clone(),
            }
        })?;
    }
    Ok(())
}

// ===========================================================================
// 3. 설정 소스 로드 — env(인라인 JSON) 우선, 아니면 파일, 둘 다 없으면 빈(fail-closed).
// ===========================================================================

/// 페어링 기기 설정을 **파싱만** 한다(핀닝 0). JSON 텍스트(배열) → 검증된 목록.
/// malformed JSON ⇒ BadJson, 형식 불량 엔트리 ⇒ 그 엔트리 사유(전부 거부).
pub fn parse_devices_json(json: &str) -> Result<Vec<ValidatedDevice>, PairingConfigError> {
    let trimmed = json.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new()); // 빈 ⇒ 0 기기(fail-closed: 아무도 연결 못 함).
    }
    let entries: Vec<PairedDeviceEntry> =
        serde_json::from_str(trimmed).map_err(|e| PairingConfigError::BadJson(e.to_string()))?;
    validate_entries(&entries)
}

/// 데스크톱 소유 소스에서 페어링 기기 설정을 로드한다(env 인라인 JSON 우선 → 파일 → 빈).
///
/// 우선순위(전부 데스크톱 소유 — 폰-도달 불가):
///   1. SOKSAK_REMOTE_PAIRED_DEVICES_JSON(인라인 JSON) — 설정 시 이것만 본다(E2E 편의).
///   2. SOKSAK_REMOTE_PAIRED_DEVICES(파일 경로) 또는 default 경로(앱 config/paired-devices.json).
///   3. 둘 다 없거나 파일 부재 ⇒ 빈 목록(fail-closed — 아무도 연결 못 함).
///
/// `config_dir` = 앱 config 디렉터리(bridge.rs 가 AppHandle 에서 해소해 넘긴다). 테스트는
/// 임시 경로를 넘긴다(Tauri 비의존 — RULE 8 무강결합).
pub fn load_paired_devices(
    config_dir: Option<&std::path::Path>,
    env: impl Fn(&str) -> Option<String>,
) -> Result<Vec<ValidatedDevice>, PairingConfigError> {
    // 1. 인라인 JSON env — 설정되면 이것만(파일 무시).
    if let Some(json) = env(PAIRED_DEVICES_JSON_ENV) {
        if !json.trim().is_empty() {
            return parse_devices_json(&json);
        }
    }
    // 2. 파일 경로 — env 또는 default.
    let path: Option<PathBuf> = env(PAIRED_DEVICES_PATH_ENV)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| config_dir.map(|d| d.join("paired-devices.json")));
    if let Some(p) = path {
        match std::fs::read_to_string(&p) {
            Ok(txt) => return parse_devices_json(&txt),
            // 파일 부재 = 빈(fail-closed). 다른 I/O 에러도 빈으로(읽기 실패 ⇒ 아무도 연결 못 함).
            Err(_) => return Ok(Vec::new()),
        }
    }
    Ok(Vec::new())
}

/// auth DeviceRegistry 의 max_devices 를 env 에서 읽는다(미설정/불량 ⇒ 기본 8).
pub fn max_devices(env: impl Fn(&str) -> Option<String>) -> usize {
    env(MAX_DEVICES_ENV)
        .and_then(|s| s.trim().parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(8)
}

// ===========================================================================
// 4. 데스크톱 static 키 영속 — 안정적 데스크톱 키(폰이 핀닝). 데스크톱 소유 위치에만.
// ===========================================================================

/// 디스크에 저장되는 데스크톱 static 키 형태(JSON). **개인키가 hex 로 평문 저장된다** —
/// 데스크톱 소유 위치(앱 config 디렉터리, 폰-도달 불가)에만 쓰며, 파일 권한을 0600 으로 좁힌다.
#[derive(Debug, Serialize, Deserialize)]
struct StoredDesktopKey {
    x25519_private: String,
    x25519_public: String,
    note: String,
}

/// 데스크톱 static 키 파일 경로를 해소한다 — env 경로 또는 config_dir/desktop-static.json.
pub fn desktop_key_path(
    config_dir: Option<&std::path::Path>,
    env: impl Fn(&str) -> Option<String>,
) -> Option<PathBuf> {
    env(DESKTOP_KEY_PATH_ENV)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| config_dir.map(|d| d.join("desktop-static.json")))
}

/// 데스크톱 static 키쌍을 **로드하거나(있으면) 생성·저장(첫 실행)**. 데스크톱 소유 경로에만.
/// 안정적 데스크톱 키 = 폰이 한 번 핀닝하면 데스크톱 재시작 후에도 같은 키로 핸드셰이크 가능.
///
/// 경로 미해소(config_dir/env 둘 다 없음) ⇒ ephemeral 생성(영속 0 — 매 부팅 새 키, 안정 핀닝 불가).
/// 파일 손상/형식불량 ⇒ 새로 생성·덮어쓰기(부팅을 막지 않되, 핀닝은 갱신 필요).
pub fn load_or_create_desktop_key(
    config_dir: Option<&std::path::Path>,
    env: impl Fn(&str) -> Option<String>,
) -> Result<StaticKeypair, crate::remote::noise::NoiseError> {
    let path = match desktop_key_path(config_dir, &env) {
        Some(p) => p,
        // 경로 없음 — ephemeral(영속 불가). 안정 핀닝은 경로가 있어야 한다(로깅은 호출자).
        None => return StaticKeypair::generate(),
    };
    // 기존 키 로드 시도.
    if let Ok(txt) = std::fs::read_to_string(&path) {
        if let Ok(stored) = serde_json::from_str::<StoredDesktopKey>(&txt) {
            if let (Some(priv_b), Some(pub_b)) = (
                decode_hex32(&stored.x25519_private),
                decode_hex32(&stored.x25519_public),
            ) {
                if let Ok(kp) = StaticKeypair::from_parts(priv_b, pub_b) {
                    return Ok(kp);
                }
            }
        }
        // 손상/형식불량 — 아래에서 새로 생성·덮어쓴다(부팅을 막지 않음).
    }
    // 새 키 생성 + 영속(첫 실행 또는 손상 복구).
    let kp = StaticKeypair::generate()?;
    persist_desktop_key(&path, &kp);
    Ok(kp)
}

/// 데스크톱 static 키쌍을 파일에 저장한다(개인키 포함 — 데스크톱 소유 위치만). 0600 권한.
/// 저장 실패는 부팅을 막지 않는다(메모리의 키로 그 세션은 동작 — 다음 부팅에 재생성).
fn persist_desktop_key(path: &std::path::Path, kp: &StaticKeypair) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let stored = StoredDesktopKey {
        // private_bytes 는 비공개라 직접 못 꺼낸다 — from_parts 라운드트립용 직렬화는
        // public 만으로는 불가하므로, StaticKeypair 가 영속을 위해 private 도 노출하는
        // serialize 헬퍼를 제공한다(persistable_parts). 아래 호출.
        x25519_private: to_hex(&kp.persistable_private()),
        x25519_public: to_hex(&kp.public_key()),
        note: "desktop-owned static key (phone-unreachable); private kept 0600".into(),
    };
    let Ok(txt) = serde_json::to_string_pretty(&stored) else {
        return;
    };
    // 개인키 파일은 **생성 시점부터 0600** 으로 연다 — write→chmod 사이의 world-readable
    // 윈도우(개인키가 잠깐 노출되는 구멍)를 없앤다. set_permissions 백스톱은 기존 파일이
    // 느슨한 권한이던 경우만을 위한 보조(우리는 항상 0600 으로 생성하므로 보통 무동작).
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
        {
            if f.write_all(txt.as_bytes()).is_ok() {
                let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = std::fs::write(path, txt);
    }
}

// ===========================================================================
// 5. hex 유틸(공개키/개인키 직렬화). 개인키 hex 는 데스크톱 소유 파일에만 쓰인다.
// ===========================================================================

/// 32B → 64-char lowercase hex.
pub fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// 64-char hex → 32B. 길이≠64 또는 비-hex 문자 ⇒ None(형식 불량 — 조용한 bad-key 0).
pub fn decode_hex32(s: &str) -> Option<[u8; 32]> {
    let s = s.trim();
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    let bytes = s.as_bytes();
    for (i, chunk) in bytes.chunks(2).enumerate() {
        let hi = hex_nibble(chunk[0])?;
        let lo = hex_nibble(chunk[1])?;
        out[i] = (hi << 4) | lo;
    }
    Some(out)
}

fn hex_nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests;
