// soksak 홈 — identity 별 완전 독립(공유 없음). dev/debug/release 가 한 홈을 공유하면
// 데이터·recents·플러그인·크로미움 프로필이 identity 경계를 넘어 섞인다(실측: 공유 CEF
// 프로필의 ProcessSingleton 이 dev↔debug 를 넘어 두 번째 앱의 엔진 기동을 죽였다). 원칙:
//   com.soksak.app   → ~/.soksak
//   com.soksak.dev   → ~/.soksak-dev
//   com.soksak.debug → ~/.soksak-debug
// 파생 규칙 = identifier 마지막 세그먼트("app" 은 무접미, 그 외 "-<세그먼트>") — 새 identity 는
// 자동으로 자기 홈을 갖는다(하드코딩 목록 없음). SOKSAK_HOME env 가 최우선(테스트 격리 —
// SOKSAK_VAULT_PATH 와 같은 오픈 테스트 메커니즘). 데이터·플러그인·사이드카·테마·프로젝트·
// 소켓·시크릿·백업 전부가 이 한 값에서 파생된다(단일 진실).
// sok CLI(cli/src/main.rs)는 독립 busybox 바이너리라 같은 계약을 자체 구현한다 — 계약 정본은
// docs/ARCHITECTURE.md 의 identity 홈 절.

use std::path::PathBuf;
use std::sync::OnceLock;

static HOME: OnceLock<PathBuf> = OnceLock::new();

fn suffix_for_identifier(identifier: &str) -> String {
    let seg = identifier.rsplit('.').next().unwrap_or("app");
    if seg == "app" {
        String::new()
    } else {
        format!("-{seg}")
    }
}

fn resolve(identifier: Option<&str>) -> PathBuf {
    if let Ok(p) = std::env::var("SOKSAK_HOME") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let suffix = identifier.map(suffix_for_identifier).unwrap_or_default();
    PathBuf::from(home).join(format!(".soksak{suffix}"))
}

/// 앱 부트 1회(lib.rs setup 최상단) — 이후 모든 경로가 이 값에서 파생된다.
pub fn init(identifier: &str) {
    let _ = HOME.set(resolve(Some(identifier)));
}

/// identity 홈(절대경로). init 전 호출(유닛테스트 등)은 SOKSAK_HOME > ~/.soksak 폴백.
pub fn soksak_home() -> PathBuf {
    HOME.get().cloned().unwrap_or_else(|| resolve(None))
}

#[cfg(test)]
mod tests {
    use super::suffix_for_identifier;

    #[test]
    fn identity_suffix_contract() {
        // 계약: app=무접미, 그 외 identity=마지막 세그먼트 접미. 새 identity 자동 수용.
        assert_eq!(suffix_for_identifier("com.soksak.app"), "");
        assert_eq!(suffix_for_identifier("com.soksak.dev"), "-dev");
        assert_eq!(suffix_for_identifier("com.soksak.debug"), "-debug");
        assert_eq!(suffix_for_identifier("com.soksak.beta"), "-beta");
    }
}
