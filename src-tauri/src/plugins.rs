// 플러그인 설치/데이터 — 검증은 프론트 스펙(src/plugins/spec.ts)이 단일진실, 여기는
// 파일 IO 와 git 서브프로세스만(테마 모델 대칭). 설치 = ~/.soksak/plugins/<id>/ 로
// git clone, 전용 저장소 = ~/.soksak/plugins-data/<id>/<key>.json.

use std::path::{Path, PathBuf};

use serde::Serialize;

// ── 디렉토리/식별자 ──────────────────────────────────────────────────────────

fn plugins_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| format!("HOME 없음: {e}"))?;
    let dir = PathBuf::from(home).join(".soksak").join("plugins");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn plugins_data_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| format!("HOME 없음: {e}"))?;
    let dir = PathBuf::from(home).join(".soksak").join("plugins-data");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

// 플러그인 id = ^[a-z0-9][a-z0-9-]*$ (스펙 §3 과 동일). 문자셋에 "."/"/" 자체가 없어
// 경로 탈출이 원천 차단된다. 디렉토리명으로 그대로 쓰이므로 여기서도 재검증.
fn sanitize_id(id: &str) -> Result<(), String> {
    let mut chars = id.chars();
    let head_ok = chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let rest_ok = chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if head_ok && rest_ok {
        Ok(())
    } else {
        Err(format!("잘못된 플러그인 id: {id:?}"))
    }
}

// 저장소 key = ^[A-Za-z0-9._-]+$. "." 은 허용 문자지만 "."/".." 단독은 경로 의미라 거부.
fn sanitize_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key == "." || key == ".." {
        return Err(format!("잘못된 저장소 key: {key:?}"));
    }
    if key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        Ok(())
    } else {
        Err(format!("잘못된 저장소 key: {key:?}"))
    }
}

// git 서브프로세스 1회 실행. 비정상 종료 시 stderr 를 그대로 에러 메시지로(원인 노출).
fn git_run(cmd: &mut std::process::Command) -> Result<(), String> {
    let out = cmd.output().map_err(|e| format!("git 실행 실패: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

// ── 스캔 ────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct PluginScanEntry {
    dir: String,
    dir_name: String,
    manifest: Option<String>,
    error: Option<String>,
}

// 설치 디렉토리의 직속 하위 디렉토리 전부(파일/"." 시작 제외 — 설치 중 .tmp-* 도 자연
// 제외). plugin.json 원문만 나르고 내용 검증은 프론트 스펙(단일진실)이 담당. 읽기 실패는
// 침묵 누락 대신 error 로 노출(§0-3 거부 사유 표시).
#[tauri::command]
pub fn plugins_scan() -> Result<Vec<PluginScanEntry>, String> {
    let base = plugins_dir()?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&base).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if !path.is_dir() || name.starts_with('.') {
            continue;
        }
        let (manifest, error) = match std::fs::read_to_string(path.join("plugin.json")) {
            Ok(m) => (Some(m), None),
            Err(e) => (None, Some(format!("plugin.json 읽기 실패: {e}"))),
        };
        out.push(PluginScanEntry {
            dir: path.to_string_lossy().to_string(),
            dir_name: name,
            manifest,
            error,
        });
    }
    out.sort_by(|a, b| a.dir_name.cmp(&b.dir_name));
    Ok(out)
}

// ── 설치/갱신/제거 ──────────────────────────────────────────────────────────

// "user/repo" 단축형(슬래시 1개, 양쪽 다 [A-Za-z0-9_.-]+)만 GitHub URL 로 확장.
// 그 외(전체 URL/로컬 경로)는 그대로 git 에 전달.
fn normalize_source(source: &str) -> String {
    let parts: Vec<&str> = source.split('/').collect();
    let seg_ok = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    };
    if parts.len() == 2 && seg_ok(parts[0]) && seg_ok(parts[1]) {
        // "user/repo.git" 도 단축형으로 수용 — ".git" 이중 부착 방지.
        let repo = parts[1].strip_suffix(".git").unwrap_or(parts[1]);
        return format!("https://github.com/{}/{repo}.git", parts[0]);
    }
    source.to_string()
}

#[derive(Serialize)]
pub struct PluginInstallResult {
    dir: String,
    dir_name: String,
    manifest: String,
}

// 실제 설치 로직(테스트 가능하도록 base 디렉토리 주입형). 임시 디렉토리에 clone 후
// plugin.json 의 id 로 최종 디렉토리를 결정 — 모든 실패 경로에서 임시 디렉토리 정리.
fn install_git_into(
    base: &Path,
    source: &str,
    reference: Option<&str>,
) -> Result<PluginInstallResult, String> {
    std::fs::create_dir_all(base).map_err(|e| e.to_string())?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = base.join(format!(".tmp-{}-{}", std::process::id(), nanos));

    let url = normalize_source(source);
    if let Err(e) = git_run(
        std::process::Command::new("git")
            .arg("clone")
            .arg(&url)
            .arg(&tmp),
    ) {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!("git clone 실패: {e}"));
    }

    if let Some(refname) = reference {
        // checkout 인자 화이트리스트 — "-" 시작(옵션 주입) 및 허용 외 문자 거부.
        let ref_ok = !refname.is_empty()
            && !refname.starts_with('-')
            && refname
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'));
        if !ref_ok {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(format!("허용되지 않는 ref: {refname:?}"));
        }
        if let Err(e) = git_run(
            std::process::Command::new("git")
                .arg("-C")
                .arg(&tmp)
                .args(["checkout", refname]),
        ) {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(format!("git checkout 실패: {e}"));
        }
    }

    let manifest = match std::fs::read_to_string(tmp.join("plugin.json")) {
        Ok(m) => m,
        Err(_) => {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err("plugin.json 없음".to_string());
        }
    };

    // 전체 검증은 프론트 스펙 담당 — 여기서는 설치 경로 결정에 필요한 id 만 뽑는다.
    let parsed: serde_json::Value = match serde_json::from_str(&manifest) {
        Ok(v) => v,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(format!("plugin.json 파싱 실패: {e}"));
        }
    };
    let Some(id) = parsed.get("id").and_then(|v| v.as_str()).map(String::from) else {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err("plugin.json 에 id 없음".to_string());
    };
    if let Err(e) = sanitize_id(&id) {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(e);
    }

    let dest = base.join(&id);
    if dest.exists() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!("이미 설치됨: {id} — 갱신은 plugin_update"));
    }
    // .git 디렉토리째 이동(plugin_update 의 pull 에 필요).
    if let Err(e) = std::fs::rename(&tmp, &dest) {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(e.to_string());
    }

    Ok(PluginInstallResult {
        dir: dest.to_string_lossy().to_string(),
        dir_name: id,
        manifest,
    })
}

// git 소스(단축형/URL/로컬 경로)에서 플러그인 설치. reference 는 브랜치/태그/커밋.
#[tauri::command]
pub fn plugin_install_git(
    source: String,
    reference: Option<String>,
) -> Result<PluginInstallResult, String> {
    install_git_into(&plugins_dir()?, &source, reference.as_deref())
}

// 설치된 플러그인 갱신 — fast-forward pull 만(로컬 수정과의 충돌 머지 금지).
#[tauri::command]
pub fn plugin_update(id: String) -> Result<PluginInstallResult, String> {
    sanitize_id(&id)?;
    let dir = plugins_dir()?.join(&id);
    if !dir.is_dir() {
        return Err(format!("설치되지 않은 플러그인: {id}"));
    }
    if let Err(e) = git_run(
        std::process::Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["pull", "--ff-only"]),
    ) {
        return Err(format!("git pull 실패: {e}"));
    }
    let manifest =
        std::fs::read_to_string(dir.join("plugin.json")).map_err(|_| "plugin.json 없음".to_string())?;
    Ok(PluginInstallResult {
        dir: dir.to_string_lossy().to_string(),
        dir_name: id,
        manifest,
    })
}

// 플러그인 제거(디렉토리째). 전용 저장소(plugins-data)는 남긴다 — 재설치 시 데이터 보존.
#[tauri::command]
pub fn plugin_remove(id: String) -> Result<(), String> {
    sanitize_id(&id)?;
    let dir = plugins_dir()?.join(&id);
    if !dir.exists() {
        return Err(format!("설치되지 않은 플러그인: {id}"));
    }
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}

// ── 전용 저장소(plugin_data_*) ──────────────────────────────────────────────
// storage 권한용 — 플러그인당 <base>/<id>/<key>.json 평면 구조. id/key 검증으로
// 자기 디렉토리 밖 접근 차단. base 주입형 내부 함수 + 커맨드 위임(테스트 가능).

fn data_read_in(base: &Path, id: &str, key: &str) -> Result<Option<String>, String> {
    sanitize_id(id)?;
    sanitize_key(key)?;
    match std::fs::read_to_string(base.join(id).join(format!("{key}.json"))) {
        Ok(s) => Ok(Some(s)),
        // 미존재는 에러가 아니라 "값 없음"(프론트가 기본값 분기).
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn data_write_in(base: &Path, id: &str, key: &str, value: &str) -> Result<(), String> {
    sanitize_id(id)?;
    sanitize_key(key)?;
    let dir = base.join(id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{key}.json")), value).map_err(|e| e.to_string())
}

fn data_list_in(base: &Path, id: &str) -> Result<Vec<String>, String> {
    sanitize_id(id)?;
    let dir = base.join(id);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "json") {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                out.push(stem.to_string());
            }
        }
    }
    out.sort();
    Ok(out)
}

#[tauri::command]
pub fn plugin_data_read(id: String, key: String) -> Result<Option<String>, String> {
    data_read_in(&plugins_data_dir()?, &id, &key)
}

#[tauri::command]
pub fn plugin_data_write(id: String, key: String, value: String) -> Result<(), String> {
    data_write_in(&plugins_data_dir()?, &id, &key, &value)
}

#[tauri::command]
pub fn plugin_data_list(id: String) -> Result<Vec<String>, String> {
    data_list_in(&plugins_data_dir()?, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_id_rules() {
        assert!(sanitize_id("memo").is_ok());
        assert!(sanitize_id("git-2").is_ok());
        assert!(sanitize_id("").is_err());
        assert!(sanitize_id("-a").is_err());
        assert!(sanitize_id("A").is_err());
        assert!(sanitize_id("a/b").is_err());
        // id 문자셋에 "." 자체가 없으므로 ".." 류 경로 탈출이 원천 거부됨을 확인.
        assert!(sanitize_id("a..b").is_err());
        assert!(sanitize_id("한글").is_err());
    }

    #[test]
    fn sanitize_key_rules() {
        assert!(sanitize_key("notes").is_ok());
        assert!(sanitize_key("a.b-c_d").is_ok());
        assert!(sanitize_key("").is_err());
        assert!(sanitize_key(".").is_err());
        assert!(sanitize_key("..").is_err());
        assert!(sanitize_key("a/b").is_err());
        assert!(sanitize_key("a\\b").is_err());
    }

    #[test]
    fn normalize_source_shorthand() {
        assert_eq!(
            normalize_source("user/repo"),
            "https://github.com/user/repo.git"
        );
        // ".git" 포함 단축형 — 이중 부착 없이 동일 URL.
        assert_eq!(
            normalize_source("user/repo.git"),
            "https://github.com/user/repo.git"
        );
        assert_eq!(normalize_source("https://x/y.git"), "https://x/y.git");
        assert_eq!(normalize_source("/abs/path"), "/abs/path");
        // 슬래시 2개 = 단축형 아님 → 그대로.
        assert_eq!(normalize_source("a/b/c"), "a/b/c");
    }

    // 전용 저장소 왕복: 쓰기 → 읽기 → 목록 → 미존재 읽기 None.
    #[test]
    fn data_roundtrip() {
        let base = std::env::temp_dir().join(format!("soksak-plugdata-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);

        // 빈 상태: 읽기 None, 목록 빈 배열(디렉토리 미생성 상태도 에러 아님).
        assert_eq!(data_read_in(&base, "memo", "notes").unwrap(), None);
        assert!(data_list_in(&base, "memo").unwrap().is_empty());

        data_write_in(&base, "memo", "notes", r#"{"a":1}"#).unwrap();
        data_write_in(&base, "memo", "config", "{}").unwrap();
        assert_eq!(
            data_read_in(&base, "memo", "notes").unwrap().as_deref(),
            Some(r#"{"a":1}"#)
        );
        assert_eq!(data_list_in(&base, "memo").unwrap(), ["config", "notes"]);
        assert_eq!(data_read_in(&base, "memo", "missing").unwrap(), None);

        // 검증 실패 경로 — 자기 디렉토리 밖 접근 시도.
        assert!(data_read_in(&base, "memo", "../escape").is_err());
        assert!(data_write_in(&base, "../memo", "k", "v").is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

    // 테스트용 git 실행(전역 설정 비의존 — user/gpgsign 을 -c 로 고정).
    fn git_t(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false"])
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?} 실패: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    // 로컬 픽스처 레포 clone → id 디렉토리로 안착, 중복 설치 거부, 임시 디렉토리 잔류 없음.
    #[test]
    fn install_git_flow() {
        let root = std::env::temp_dir().join(format!("soksak-pluginstall-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let src = root.join("fixture-src");
        std::fs::create_dir_all(&src).unwrap();
        git_t(&src, &["init"]);
        std::fs::write(
            src.join("plugin.json"),
            r#"{"spec":"soksak-plugin-spec@1","id":"fixture-plugin","name":"Fixture","version":"0.1.0"}"#,
        )
        .unwrap();
        std::fs::write(src.join("main.js"), "export function activate() {}\n").unwrap();
        git_t(&src, &["add", "."]);
        git_t(&src, &["commit", "-m", "init"]);

        let base = root.join("plugins");
        let r = install_git_into(&base, &src.to_string_lossy(), None).unwrap();
        assert_eq!(r.dir_name, "fixture-plugin");
        assert!(base.join("fixture-plugin").join("plugin.json").is_file());
        // 갱신(pull)을 위해 .git 유지.
        assert!(base.join("fixture-plugin").join(".git").exists());
        assert!(r.manifest.contains("fixture-plugin"));

        // 동일 id 재설치 → 거부(갱신은 plugin_update 경로).
        let Err(err) = install_git_into(&base, &src.to_string_lossy(), None) else {
            panic!("이미 설치된 id 재설치가 성공하면 안 됨");
        };
        assert!(err.contains("이미 설치됨"), "{err}");
        // 실패 경로에서 임시 clone 디렉토리가 남지 않음.
        let leftover = std::fs::read_dir(&base)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().starts_with(".tmp-"));
        assert!(!leftover);

        let _ = std::fs::remove_dir_all(&root);
    }
}
