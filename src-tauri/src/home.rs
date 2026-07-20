// soksak 홈 — identity 별 완전 독립(공유 없음). dev/debug/release 가 한 홈을 공유하면
// 데이터·recents·플러그인·크로미움 프로필이 identity 경계를 넘어 섞인다(실측: 공유 CEF
// 프로필의 ProcessSingleton 이 dev↔debug 를 넘어 두 번째 앱의 엔진 기동을 죽였다). 원칙:
//   com.soksak.app   → ~/.soksak
//   com.soksak.dev   → ~/.soksak-dev
//   com.soksak.debug → ~/.soksak-debug
// 파생 규칙 = identifier 마지막 세그먼트("app" 은 무접미, 그 외 "-<세그먼트>") — 새 identity 는
// 자동으로 자기 홈을 갖는다(하드코딩 목록 없음). SOKSAK_HOME 이 있으면 그 경로가 홈 전체를 지정한다
// (SOKSAK_VAULT_PATH 와 동형의 오픈-테스트 메커니즘, 모든 빌드 — docs/ARCHITECTURE.md A17 canonical): 실제
// 바이너리를 돌리는 블랙박스 e2e/도구가 데이터·볼트·소켓을 disposable 홈으로 격리해 공유 identity 홈을 안
// 건드리게 하는 유일 수단(내부 함수 격리가 안 되는 경계). 홈 relocation 은 데이터 유출이 아니고 release 는
// dev/local 플러그인 로드를 거부한다. 유닛테스트는 여전히 경로-인자 내부 함수로 격리한다.
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

// 순수 — env 값을 인자로 받아 홈을 결정(테스트 격리, 병렬 안전). SOKSAK_HOME 이 있으면 그 경로가 홈 전체를
// 지정한다 — 블랙박스 e2e/도구가 데이터·볼트·소켓을 disposable 홈으로 격리하는 오픈-테스트 메커니즘
// (SOKSAK_VAULT_PATH 와 동형, 모든 빌드에서 유효 — docs/ARCHITECTURE.md A17 canonical). 홈을 옮길 뿐
// 데이터를 유출하지 않고, release 는 dev/local 플러그인 로드를 거부하므로 악성 플러그인 주입 경로가 아니다.
fn resolve_from(
    soksak_home: Option<&str>,
    identifier: Option<&str>,
    is_windows: bool,
    home: Option<&str>,
    userprofile: Option<&str>,
) -> PathBuf {
    if let Some(h) = soksak_home.filter(|s| !s.is_empty()) {
        return PathBuf::from(h);
    }
    let base = home_base(is_windows, home, userprofile);
    let suffix = identifier.map(suffix_for_identifier).unwrap_or_default();
    base.join(format!(".soksak{suffix}"))
}

fn resolve(identifier: Option<&str>) -> PathBuf {
    resolve_from(
        std::env::var("SOKSAK_HOME").ok().as_deref(),
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

    // SOKSAK_HOME 이 홈 전체를 지정(SOKSAK_VAULT_PATH 동형·모든 빌드, A17). 빈 값·부재는 identity 파생 폴백.
    #[test]
    fn soksak_home_env_overrides_home() {
        use super::resolve_from;
        use std::path::PathBuf;
        assert_eq!(
            resolve_from(Some("/tmp/e2e-home"), Some("com.soksak.debug"), false, Some("/home/max"), None),
            PathBuf::from("/tmp/e2e-home"),
            "SOKSAK_HOME 이 홈을 그대로 지정(접미 없음)"
        );
        assert_eq!(
            resolve_from(Some(""), Some("com.soksak.debug"), false, Some("/home/max"), None),
            PathBuf::from("/home/max/.soksak-debug"),
            "빈 값은 무시 → identity 파생"
        );
        assert_eq!(
            resolve_from(None, Some("com.soksak.app"), false, Some("/home/max"), None),
            PathBuf::from("/home/max/.soksak"),
            "부재 → identity 파생(app 무접미)"
        );
    }
}
