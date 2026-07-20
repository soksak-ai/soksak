// 개발 unit source 선언 — core build identity(dev/debug/release)와 독립이다.
// 각 identity 홈은 자기 config/development-units.json 을 소유하며, plugin/sidecar/kit의
// 개발 checkout은 설치본과 분리된 절대경로로 선택한다. 경로 추측과 symlink는 허용하지 않는다.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

const CONFIG_VERSION: u32 = 1;
const CONFIG_FILE: &str = "development-units.json";
static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct UnitDevSource {
    pub kind: String,
    pub id: String,
    pub source: String,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct UnitDevConfig {
    version: u32,
    units: Vec<UnitDevSource>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppEnvironment {
    core_build: String,
    identity: String,
    cli: String,
    home: String,
    build_profile: &'static str,
    updater_enabled: bool,
    unit_mode: &'static str,
    development_units: Vec<UnitDevSource>,
}

fn config_path(home: &Path) -> PathBuf {
    home.join("config").join(CONFIG_FILE)
}

fn valid_kind(kind: &str) -> bool {
    matches!(kind, "plugin" | "sidecar" | "kit")
}

fn valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn validate_declared_source(kind: &str, id: &str, source: &Path) -> Result<(), String> {
    if !valid_kind(kind) {
        return Err(format!(
            "지원하지 않는 unit kind: {kind:?} (plugin|sidecar|kit)"
        ));
    }
    if !valid_id(id) {
        return Err(format!("잘못된 unit id: {id:?} (^[a-z0-9][a-z0-9-]*$)"));
    }
    if !source.is_absolute() {
        return Err(format!(
            "개발 source는 절대경로여야 합니다: {}",
            source.display()
        ));
    }
    crate::path_security::reject_symlink_components(source)?;
    Ok(())
}

fn validate_source(home: &Path, kind: &str, id: &str, source: &Path) -> Result<(), String> {
    validate_declared_source(kind, id, source)?;
    validate_source_path_in(source, home)
}

fn validate_source_path(source: &Path) -> Result<(), String> {
    validate_source_path_in(source, &crate::home::soksak_home())
}

fn validate_source_path_in(source: &Path, home: &Path) -> Result<(), String> {
    if !source.is_absolute() {
        return Err(format!(
            "개발 source는 절대경로여야 합니다: {}",
            source.display()
        ));
    }
    crate::path_security::reject_symlink_components(source)?;
    if !source.is_dir() {
        return Err(format!(
            "개발 source 디렉터리가 없습니다: {}",
            source.display()
        ));
    }
    if let Some(foreign) = foreign_identity_home(source, home) {
        return Err(format!(
            "다른 identity 홈({}) 안의 경로는 이 홈의 개발 source 가 될 수 없습니다: {}. \
             그 홈의 앱으로 검증하거나, 발행한 뒤 이 홈에 설치해서 검증하십시오.",
            foreign.display(),
            source.display()
        ));
    }
    Ok(())
}

/// source 가 이 홈이 아닌 다른 identity 홈 안에 있으면 그 홈 경로를 돌려준다.
///
/// identity 홈은 `$HOME/.soksak`(release) 와 `$HOME/.soksak-<식별자>` 로 파생된다(home.rs).
/// 새 identity 는 자동으로 자기 홈을 갖기 때문에 목록을 하드코딩하지 않고, 이 홈의 형제 중
/// 같은 이름 규칙을 만족하는 디렉터리를 홈으로 본다. 홈 밖(작업 checkout)은 대상이 아니다.
fn foreign_identity_home(source: &Path, home: &Path) -> Option<PathBuf> {
    let parent = home.parent()?;
    source
        .ancestors()
        .find(|anc| {
            anc.parent() == Some(parent)
                && *anc != home
                && anc
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n == ".soksak" || n.starts_with(".soksak-"))
        })
        .map(Path::to_path_buf)
}

fn read_config_in(home: &Path) -> Result<UnitDevConfig, String> {
    let path = config_path(home);
    if !path.exists() {
        return Ok(UnitDevConfig {
            version: CONFIG_VERSION,
            units: Vec::new(),
        });
    }
    crate::path_security::reject_symlink_components(&path)?;
    let raw =
        std::fs::read_to_string(&path).map_err(|e| format!("{} 읽기 실패: {e}", path.display()))?;
    let mut config: UnitDevConfig =
        serde_json::from_str(&raw).map_err(|e| format!("{} 파싱 실패: {e}", path.display()))?;
    if config.version != CONFIG_VERSION {
        return Err(format!(
            "지원하지 않는 development unit config version: {} (지원={CONFIG_VERSION})",
            config.version
        ));
    }
    let mut keys = std::collections::HashSet::new();
    for unit in &config.units {
        // checkout은 선택 뒤 이동/삭제될 수 있다. 선언 자체는 계속 노출해 loader가 unit별로
        // 명시적 오류를 보고하게 하고, 공식 설치본으로 fallback하지 않는다.
        validate_declared_source(&unit.kind, &unit.id, Path::new(&unit.source))?;
        if !keys.insert((unit.kind.as_str(), unit.id.as_str())) {
            return Err(format!(
                "development unit config에 중복 key가 있습니다: {}/{}",
                unit.kind, unit.id
            ));
        }
    }
    config
        .units
        .sort_by(|a, b| (&a.kind, &a.id).cmp(&(&b.kind, &b.id)));
    Ok(config)
}

fn write_config_in(home: &Path, config: &UnitDevConfig) -> Result<(), String> {
    let path = config_path(home);
    let parent = path
        .parent()
        .ok_or_else(|| "development config 상위 경로 없음".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    crate::path_security::reject_symlink_components(parent)?;
    let tmp = parent.join(format!(".{CONFIG_FILE}.tmp-{}", std::process::id()));
    let bytes = serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("development config 원자 교체 실패: {e}"));
    }
    Ok(())
}

fn list_in(home: &Path) -> Result<Vec<UnitDevSource>, String> {
    Ok(read_config_in(home)?.units)
}

fn set_in(home: &Path, kind: &str, id: &str, source: &Path) -> Result<UnitDevSource, String> {
    validate_source(home, kind, id, source)?;
    // lexical 절대경로를 그대로 보존한다. canonicalize로 symlink를 숨기지 않는다.
    let selected = UnitDevSource {
        kind: kind.to_string(),
        id: id.to_string(),
        source: source.to_string_lossy().into_owned(),
    };
    let mut config = read_config_in(home)?;
    config.units.retain(|u| !(u.kind == kind && u.id == id));
    config.units.push(selected.clone());
    config
        .units
        .sort_by(|a, b| (&a.kind, &a.id).cmp(&(&b.kind, &b.id)));
    write_config_in(home, &config)?;
    Ok(selected)
}

fn remove_in(home: &Path, kind: &str, id: &str) -> Result<bool, String> {
    if !valid_kind(kind) {
        return Err(format!(
            "지원하지 않는 unit kind: {kind:?} (plugin|sidecar|kit)"
        ));
    }
    if !valid_id(id) {
        return Err(format!("잘못된 unit id: {id:?} (^[a-z0-9][a-z0-9-]*$)"));
    }
    let mut config = read_config_in(home)?;
    let before = config.units.len();
    config.units.retain(|u| !(u.kind == kind && u.id == id));
    let removed = before != config.units.len();
    if removed {
        write_config_in(home, &config)?;
    }
    Ok(removed)
}

pub(crate) fn set_source(kind: &str, id: &str, source: &Path) -> Result<UnitDevSource, String> {
    let _guard = WRITE_LOCK.lock().map_err(|e| e.to_string())?;
    set_in(&crate::home::soksak_home(), kind, id, source)
}

#[tauri::command]
pub fn unit_dev_list() -> Result<Vec<UnitDevSource>, String> {
    list_in(&crate::home::soksak_home())
}

#[tauri::command]
pub fn unit_dev_set(kind: String, id: String, source: String) -> Result<UnitDevSource, String> {
    set_source(&kind, &id, Path::new(&source))
}

#[tauri::command]
pub fn unit_dev_validate_path(source: String) -> Result<String, String> {
    validate_source_path(Path::new(&source))?;
    Ok(source)
}

#[tauri::command]
pub fn unit_dev_remove(kind: String, id: String) -> Result<bool, String> {
    let _guard = WRITE_LOCK.lock().map_err(|e| e.to_string())?;
    remove_in(&crate::home::soksak_home(), &kind, &id)
}

#[tauri::command]
pub fn app_environment() -> Result<AppEnvironment, String> {
    let identity = crate::home::identifier();
    let core_build = crate::home::core_build_for_identifier(&identity);
    let cli = crate::home::cli_for_core_build(&core_build);
    let units = unit_dev_list()?;
    Ok(AppEnvironment {
        updater_enabled: core_build == "release",
        unit_mode: if units.is_empty() {
            "official"
        } else {
            "mixed"
        },
        core_build,
        identity,
        cli,
        home: crate::home::soksak_home().to_string_lossy().into_owned(),
        build_profile: if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        development_units: units,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(name: &str) -> PathBuf {
        let temp = std::env::temp_dir();
        // macOS의 /var는 /private/var symlink다. 제품 기준을 낮추지 않고 테스트 fixture만
        // 물리 경로에 둬서 "source 경로에 symlink 0"을 그대로 검증한다.
        temp.canonicalize()
            .unwrap_or(temp)
            .join(format!("soksak-unit-dev-{name}-{}", std::process::id()))
    }

    #[test]
    fn source_selection_is_identity_home_local_and_atomic() {
        let root = test_root("roundtrip");
        let _ = std::fs::remove_dir_all(&root);
        let home = root.join("home");
        let source = root.join("weather");
        std::fs::create_dir_all(&source).unwrap();

        let selected = set_in(&home, "plugin", "weather", &source).unwrap();
        assert_eq!(selected.source, source.to_string_lossy());
        assert_eq!(list_in(&home).unwrap(), vec![selected]);
        assert!(config_path(&home).is_file());
        assert!(remove_in(&home, "plugin", "weather").unwrap());
        assert!(list_in(&home).unwrap().is_empty());
        assert!(!remove_in(&home, "plugin", "weather").unwrap());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn relative_and_missing_sources_are_rejected() {
        let root = test_root("invalid");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        assert!(set_in(&root, "plugin", "weather", Path::new("relative/plugin")).is_err());
        assert!(set_in(&root, "plugin", "weather", &root.join("missing")).is_err());
        assert!(set_in(&root, "unknown", "weather", &root).is_err());
        assert!(set_in(&root, "plugin", "weather.dev", &root).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn config_rejects_unknown_fields_and_duplicate_unit_keys() {
        let root = test_root("strict-config");
        let _ = std::fs::remove_dir_all(&root);
        let home = root.join("home");
        let source = root.join("weather");
        std::fs::create_dir_all(&source).unwrap();
        let path = config_path(&home);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();

        std::fs::write(
            &path,
            format!(
                r#"{{"version":1,"units":[{{"kind":"plugin","id":"weather","source":"{}","unexpected":true}}]}}"#,
                source.display()
            ),
        )
        .unwrap();
        assert!(
            read_config_in(&home).is_err(),
            "알 수 없는 필드는 계약 위반이어야 한다"
        );

        std::fs::write(
            &path,
            format!(
                r#"{{"version":1,"units":[{{"kind":"plugin","id":"weather","source":"{}"}},{{"kind":"plugin","id":"weather","source":"{}"}}]}}"#,
                source.display(),
                source.display()
            ),
        )
        .unwrap();
        assert!(
            read_config_in(&home).is_err(),
            "같은 unit key 중복은 모호성이므로 거부해야 한다"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn selected_source_that_later_disappears_remains_discoverable() {
        let root = test_root("disappeared");
        let _ = std::fs::remove_dir_all(&root);
        let home = root.join("home");
        let source = root.join("weather");
        std::fs::create_dir_all(&source).unwrap();
        set_in(&home, "plugin", "weather", &source).unwrap();
        std::fs::remove_dir_all(&source).unwrap();

        let units = list_in(&home).unwrap();
        assert_eq!(
            units.len(),
            1,
            "깨진 선택도 상태면에 남아 loader가 loud하게 보고해야 한다"
        );
        assert_eq!(units[0].source, source.to_string_lossy());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_source_or_parent_is_rejected() {
        use std::os::unix::fs::symlink;

        let root = test_root("symlink");
        let _ = std::fs::remove_dir_all(&root);
        let real = root.join("real");
        let child = real.join("plugin");
        std::fs::create_dir_all(&child).unwrap();
        let link = root.join("link");
        symlink(&real, &link).unwrap();

        assert!(set_in(
            &root.join("home"),
            "plugin",
            "weather",
            &link.join("plugin")
        )
        .is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_a_source_inside_another_identity_home() {
        // home.rs 불변식: identity 홈은 완전 독립이고 플러그인은 경계를 넘지 않는다.
        // 다른 홈의 plugins/<id> 를 이 홈의 개발 source 로 선언하면 debug 앱이 dev 홈의
        // 작업 트리를 실행하게 된다(동의 게이트도 dev source 예외로 우회).
        let root = test_root("foreign-home");
        let _ = std::fs::remove_dir_all(&root);
        let home = root.join(".soksak-debug");
        let foreign = root.join(".soksak-dev").join("plugins").join("weather");
        let own = home.join("workspaces").join("plugins").join("weather");
        std::fs::create_dir_all(&foreign).unwrap();
        std::fs::create_dir_all(&own).unwrap();

        assert!(validate_source_path_in(&foreign, &home).is_err());
        assert!(validate_source_path_in(&own, &home).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn allows_a_source_outside_every_identity_home() {
        let root = test_root("outside-home");
        let _ = std::fs::remove_dir_all(&root);
        let home = root.join(".soksak-debug");
        let checkout = root.join("work").join("my-plugin");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&checkout).unwrap();

        assert!(validate_source_path_in(&checkout, &home).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }
}
