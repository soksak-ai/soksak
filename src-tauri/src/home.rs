// soksak 홈 — identity 별 완전 독립(공유 없음). dev/debug/release 가 한 홈을 공유하면
// 데이터·recents·플러그인·크로미움 프로필이 identity 경계를 넘어 섞인다(실측: 공유 CEF
// 프로필의 ProcessSingleton 이 dev↔debug 를 넘어 두 번째 앱의 엔진 기동을 죽였다). 원칙:
//   com.soksak.app   → ~/.soksak
//   com.soksak.dev   → ~/.soksak-dev
//   com.soksak.debug → ~/.soksak-debug
// 파생 규칙 = identifier 마지막 세그먼트("app" 은 무접미, 그 외 "-<세그먼트>") — 새 identity 는
// 자동으로 자기 홈을 갖는다(하드코딩 목록 없음). runtime 환경변수 override는 없다.
// 테스트도 경로를 받는 내부 함수로 격리하며 제품 경계를 열지 않는다. 데이터·플러그인·사이드카·테마·프로젝트·
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

fn resolve(identifier: Option<&str>) -> PathBuf {
    // 모든 build profile에서 identity가 home을 결정한다. 테스트는 이 함수의 identifier
    // 입력과 경로를 받는 하위 함수를 사용하며 runtime override를 제품에 추가하지 않는다.
    let home = std::env::var("HOME").unwrap_or_default();
    let suffix = identifier.map(suffix_for_identifier).unwrap_or_default();
    PathBuf::from(home).join(format!(".soksak{suffix}"))
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
    fn identity_and_cli_describe_core_build_only() {
        assert_eq!(core_build_for_identifier("com.soksak.app"), "release");
        assert_eq!(core_build_for_identifier("com.soksak.dev"), "dev");
        assert_eq!(core_build_for_identifier("com.soksak.debug"), "debug");
        assert_eq!(cli_for_core_build("release"), "sok");
        assert_eq!(cli_for_core_build("dev"), "sok-dev");
        assert_eq!(cli_for_core_build("debug"), "sok-debug");
    }
}
