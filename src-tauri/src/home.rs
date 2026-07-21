// soksak 홈 — identity 별 완전 독립(공유 없음). dev/debug/release 가 한 홈을 공유하면
// 데이터·recents·플러그인·크로미움 프로필이 identity 경계를 넘어 섞인다(실측: 공유 CEF
// 프로필의 ProcessSingleton 이 dev↔debug 를 넘어 두 번째 앱의 엔진 기동을 죽였다). 원칙:
//   com.soksak.app   → ~/.soksak
//   com.soksak.dev   → ~/.soksak-dev
//   com.soksak.debug → ~/.soksak-debug
// 파생 규칙 = identifier 마지막 세그먼트("app" 은 무접미, 그 외 "-<세그먼트>") — 새 identity 는
// 자동으로 자기 홈을 갖는다(하드코딩 목록 없음).
// identity 홈은 identifier 에서만 파생되는 고정값이다 — runtime env 로 override 하지 않는다(distribution
// 불변식: 다른 identity 홈을 runtime 에 지목하는 표면을 만들지 않는다, debug/test 이름도 예외 없음). 블랙박스
// e2e 는 홈을 옮기는 대신 실 identity 홈 안에서 DB·볼트만 격리한다(SOKSAK_DATA_DIR·SOKSAK_VAULT_PATH — 실홈의
// 설치 플러그인·사이드카는 그대로 쓰고 disposable 데이터만 분리). 격리 앱을 CLI 로 겨눌 땐 SOKSAK_SOCKET 을 쓴다.
// 데이터·플러그인·사이드카·테마·프로젝트·
// 소켓·시크릿·백업 전부가 이 한 값에서 파생된다(단일 진실).
// sok CLI(cli/src/main.rs)는 독립 busybox 바이너리라 같은 계약을 자체 구현한다 — 계약 정본은
// docs/ARCHITECTURE.md 의 identity 홈 절.

use std::path::PathBuf;
use std::sync::OnceLock;

static HOME: OnceLock<PathBuf> = OnceLock::new();
static IDENTIFIER: OnceLock<String> = OnceLock::new();

// release core 판정 — identifier 마지막 세그먼트가 "app". 이 값은 updater 채널만 결정한다.
// core build identity와 확장 unit의 development/official source 선택은 독립 축이다.
fn is_release_identifier(identifier: &str) -> bool {
    identifier.rsplit('.').next() == Some("app")
}

pub fn core_build_for_identifier(identifier: &str) -> String {
    match identifier.rsplit('.').next().unwrap_or("app") {
        "app" => "release".to_string(),
        "dev" => "dev".to_string(),
        "debug" => "debug".to_string(),
        other => other.to_string(),
    }
}

pub fn cli_for_core_build(core_build: &str) -> String {
    match core_build {
        "release" => "sok".to_string(),
        other => format!("sok-{other}"),
    }
}

/// release core identity 여부. init 전(유닛테스트 등)은 false.
pub fn is_release() -> bool {
    IDENTIFIER
        .get()
        .map(|s| is_release_identifier(s))
        .unwrap_or(false)
}

/// 프론트 updater 채널 판정용. 확장 개발 허용 여부에는 사용하지 않는다.
#[tauri::command]
pub fn app_is_release() -> bool {
    is_release()
}

fn suffix_for_identifier(identifier: &str) -> String {
    let seg = identifier.rsplit('.').next().unwrap_or("app");
    if seg == "app" {
        String::new()
    } else {
        format!("-{seg}")
    }
}

// 홈 베이스 경로 결정(순수 함수 — env 없이 인자로 검증). Windows 는 HOME 미설정이 흔해
// 빈 값이 되면 볼트·DB 경로가 cwd 상대 ".soksak" 로 깨지므로 USERPROFILE 로 폴백한다(fs.rs
// home_dir 선례와 동형). macOS/Linux 는 HOME 그대로(USERPROFILE 없음).
fn home_base(is_windows: bool, home: Option<&str>, userprofile: Option<&str>) -> PathBuf {
    fn non_empty(v: Option<&str>) -> Option<&str> {
        v.filter(|s| !s.is_empty())
    }
    let base = if is_windows {
        non_empty(home).or(non_empty(userprofile))
    } else {
        non_empty(home)
    };
    PathBuf::from(base.unwrap_or(""))
}

// 순수 — env 값을 인자로 받아 홈을 결정(테스트 격리, 병렬 안전). identity 홈은 identifier 에서만 파생되며
// runtime override 가 없다 — home_base(HOME/USERPROFILE 폴백)에 identity 접미를 붙일 뿐이다.
fn resolve_from(
    identifier: Option<&str>,
    is_windows: bool,
    home: Option<&str>,
    userprofile: Option<&str>,
) -> PathBuf {
    let base = home_base(is_windows, home, userprofile);
    let suffix = identifier.map(suffix_for_identifier).unwrap_or_default();
    base.join(format!(".soksak{suffix}"))
}

fn resolve(identifier: Option<&str>) -> PathBuf {
    resolve_from(
        identifier,
        cfg!(windows),
        std::env::var("HOME").ok().as_deref(),
        std::env::var("USERPROFILE").ok().as_deref(),
    )
}

/// 앱 부트 1회(lib.rs setup 최상단) — 이후 모든 경로가 이 값에서 파생된다.
pub fn init(identifier: &str) {
    let _ = HOME.set(resolve(Some(identifier)));
    let _ = IDENTIFIER.set(identifier.to_string());
}

/// identity 홈(절대경로). init 전 호출(유닛테스트 등)은 ~/.soksak 폴백.
pub fn soksak_home() -> PathBuf {
    HOME.get().cloned().unwrap_or_else(|| resolve(None))
}

pub fn identifier() -> String {
    IDENTIFIER
        .get()
        .cloned()
        .unwrap_or_else(|| "com.soksak.app".to_string())
}

#[cfg(test)]
mod tests {
    use super::{cli_for_core_build, core_build_for_identifier, suffix_for_identifier};

    #[test]
    fn release_identifier_contract() {
        use super::is_release_identifier;
        assert!(is_release_identifier("com.soksak.app"));
        assert!(!is_release_identifier("com.soksak.dev"));
        assert!(!is_release_identifier("com.soksak.debug"));
    }

    #[test]
    fn identity_suffix_contract() {
        // 계약: app=무접미, 그 외 identity=마지막 세그먼트 접미. 새 identity 자동 수용.
        assert_eq!(suffix_for_identifier("com.soksak.app"), "");
        assert_eq!(suffix_for_identifier("com.soksak.dev"), "-dev");
        assert_eq!(suffix_for_identifier("com.soksak.debug"), "-debug");
        assert_eq!(suffix_for_identifier("com.soksak.beta"), "-beta");
    }

    #[test]
    fn home_base_falls_back_to_userprofile_on_windows() {
        use super::home_base;
        use std::path::PathBuf;
        // 비Windows: HOME 사용, USERPROFILE 무시.
        assert_eq!(
            home_base(false, Some("/home/max"), Some("C:\\Users\\max")),
            PathBuf::from("/home/max")
        );
        // Windows: HOME 있으면 그대로.
        assert_eq!(
            home_base(true, Some("H:\\home"), Some("C:\\Users\\max")),
            PathBuf::from("H:\\home")
        );
        // Windows: HOME 미설정 → USERPROFILE 폴백(빈 HOME 의 cwd 상대 ".soksak" 붕괴 방지).
        assert_eq!(
            home_base(true, None, Some("C:\\Users\\max")),
            PathBuf::from("C:\\Users\\max")
        );
        // Windows: HOME 빈 문자열도 USERPROFILE 폴백.
        assert_eq!(
            home_base(true, Some(""), Some("C:\\Users\\max")),
            PathBuf::from("C:\\Users\\max")
        );
        // 비Windows: HOME 미설정 → 빈 베이스(기존 동작 유지 — USERPROFILE 로 새지 않는다).
        assert_eq!(
            home_base(false, None, Some("C:\\Users\\max")),
            PathBuf::from("")
        );
    }

    #[test]
    fn identity_and_cli_describe_core_build_only() {
        assert_eq!(core_build_for_identifier("com.soksak.app"), "release");
        assert_eq!(core_build_for_identifier("com.soksak.dev"), "dev");
        assert_eq!(core_build_for_identifier("com.soksak.debug"), "debug");
        assert_eq!(cli_for_core_build("release"), "sok");
        assert_eq!(cli_for_core_build("dev"), "sok-dev");
        assert_eq!(cli_for_core_build("debug"), "sok-debug");
    }

    // identity 홈은 identifier 에서만 파생되고 runtime override 표면이 없다(distribution 불변식). 홈 relocate
    // 없이도 블랙박스 e2e 는 실홈 안에서 DB·볼트만 격리한다(SOKSAK_DATA_DIR·SOKSAK_VAULT_PATH).
    #[test]
    fn home_derives_from_identifier_only() {
        use super::resolve_from;
        use std::path::PathBuf;
        assert_eq!(
            resolve_from(Some("com.soksak.debug"), false, Some("/home/max"), None),
            PathBuf::from("/home/max/.soksak-debug"),
            "debug identity → -debug 접미"
        );
        assert_eq!(
            resolve_from(Some("com.soksak.app"), false, Some("/home/max"), None),
            PathBuf::from("/home/max/.soksak"),
            "app → 무접미"
        );
        assert_eq!(
            resolve_from(Some("com.soksak.beta"), false, Some("/home/max"), None),
            PathBuf::from("/home/max/.soksak-beta"),
            "새 identity 자동 수용"
        );
    }
}
