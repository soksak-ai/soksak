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

fn validate_declared_source(home: &Path, kind: &str, id: &str, source: &Path) -> Result<(), String> {
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
    // 봉쇄: dev source는 자기 identity 홈 밖으로 나갈 수 없다. 홈 밖 참조를 구조로 막아 한 identity(예:
    // debug)가 다른 identity(dev) 홈의 unit을 dev-source로 끌어오는 누수를 차단한다 — 그건 발행→설치를
    // 거쳐야 한다. `..` 상위 탐색도 금지해 렉시컬 escape를 봉쇄(symlink는 위에서 이미 거부).
    if source
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!("개발 source에 상위 탐색(..) 금지: {}", source.display()));
    }
    if !source.starts_with(home) {
        return Err(format!(
            "개발 source는 identity 홈 밖으로 나갈 수 없습니다(다른 identity/dev 홈 참조 차단): {} (홈: {})",
            source.display(),
            home.display()
        ));
    }
    Ok(())
}

fn validate_source(home: &Path, kind: &str, id: &str, source: &Path) -> Result<(), String> {
    validate_declared_source(home, kind, id, source)?;
    validate_source_path(source)
}

fn validate_source_path(source: &Path) -> Result<(), String> {
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
    Ok(())
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
        validate_declared_source(home, &unit.kind, &unit.id, Path::new(&unit.source))?;
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
        let source = home.join("weather");
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
    fn source_outside_identity_home_is_rejected() {
        // 구멍 봉쇄: 한 identity 홈이 다른 identity(예: dev) 홈의 unit을 dev-source로 끌어오는 걸 막는다.
        // debug 홈이 ~/.soksak-dev/plugins/... 를 참조하던 누수 — 홈 밖 절대경로는 loud하게 거부한다.
        let root = test_root("outside-home");
        let _ = std::fs::remove_dir_all(&root);
        let home = root.join("home-debug");
        let other = root.join("home-dev").join("plugins").join("weather");
        std::fs::create_dir_all(&other).unwrap();

        // set: 홈 밖 source 등록 거부.
        let err = set_in(&home, "plugin", "weather", &other).unwrap_err();
        assert!(err.contains("홈 밖"), "홈 밖 source는 거부되어야 한다: {err}");

        // read: 이미 홈 밖 source가 박힌 config도 로드 시 거부(부팅 시 debug의 dev 누수 차단).
        let path = config_path(&home);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            format!(
                r#"{{"version":1,"units":[{{"kind":"plugin","id":"weather","source":"{}"}}]}}"#,
                other.display()
            ),
        )
        .unwrap();
        assert!(
            read_config_in(&home).is_err(),
            "홈 밖 source가 박힌 config는 로드 시 거부되어야 한다"
        );

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
        let source = home.join("weather");
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
        let source = home.join("weather");
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
}
