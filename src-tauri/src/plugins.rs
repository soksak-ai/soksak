// 플러그인 설치/데이터 — 검증은 프론트 스펙(src/plugins/spec.ts)이 단일진실, 여기는
// 파일 IO 와 git 서브프로세스만(테마 모델 대칭). 설치 = ~/.soksak/plugins/<id>/ 로
// git clone, 전용 저장소 = ~/.soksak/plugins-data/<id>/<key>.json.

use std::path::{Path, PathBuf};

use serde::Serialize;

// ── 디렉토리/식별자 ──────────────────────────────────────────────────────────

fn plugins_dir() -> Result<PathBuf, String> {
    let dir = crate::home::soksak_home().join("plugins");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn plugins_data_dir() -> Result<PathBuf, String> {
    let dir = crate::home::soksak_home().join("plugins-data");
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

// 설치 디렉토리 쓰기 잠금/해제 — 설치본은 git 미러(사용자 작업공간 아님)다. 개발은 개발
// 폴더(소스)에서 하고 설치본은 직접 수정하면 안 된다(다음 update 의 reset --hard 가 날린다).
// chmod 로 한 겹 더 막아 앱의 git 경로(update 가 잠시 해제)만 통과시킨다. best-effort —
// 실패해도 설치/갱신 자체를 막지 않는다(데이터는 분리된 plugins-data 라 영향 없음).
fn set_tree_writable(dir: &Path, writable: bool) {
    let mode = if writable { "u+w" } else { "a-w" };
    let _ = std::process::Command::new("chmod")
        .arg("-R")
        .arg(mode)
        .arg(dir)
        .output();
}

// ── 스캔 ────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct PluginScanEntry {
    dir: String,
    dir_name: String,
    manifest: Option<String>,
    // .soksak.json 원문(있으면) — 공식 설치 상태(version=<semver>, repo, branch).
    // legacy version=dev|local은 프론트 loader가 거부하고 development-units.json으로 안내한다.
    state: Option<String>,
    error: Option<String>,
}

// 설치 디렉토리의 직속 하위 디렉토리 전부(파일/"." 시작 제외 — 설치 중 .tmp-* 도 자연
// 제외). plugin.json·.soksak.json 원문만 나르고 내용 검증은 프론트 스펙(단일진실)이 담당.
// 읽기 실패는 침묵 누락 대신 error 로 노출(§0-3 거부 사유 표시).
#[tauri::command]
pub fn plugin_scan() -> Result<Vec<PluginScanEntry>, String> {
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
        let state = std::fs::read_to_string(path.join(".soksak.json")).ok();
        out.push(PluginScanEntry {
            dir: path.to_string_lossy().to_string(),
            dir_name: name,
            manifest,
            state,
            error,
        });
    }
    out.sort_by(|a, b| a.dir_name.cmp(&b.dir_name));
    Ok(out)
}

// 공식 설치 상태 파일(.soksak.json) 기록 헬퍼 — version=<semver>, repo(원격 URL), branch.
fn write_state(dir: &Path, version: &str, repo: &str, branch: &str) {
    let state = serde_json::json!({ "version": version, "repo": repo, "branch": branch });
    let _ = std::fs::write(
        dir.join(".soksak.json"),
        serde_json::to_string_pretty(&state).unwrap_or_default(),
    );
}

// 현재 체크아웃된 브랜치명(detached 면 "HEAD"). 실패 시 "main".
fn current_branch(dir: &Path) -> String {
    std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "main".to_string())
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

#[derive(Serialize, Debug)]
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

    // .soksak.json 기록 — 설치본 자기 기술(version=설치 semver, repo, branch). dev 폴더와 구분되는 표식.
    let version = parsed
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0");
    write_state(&dest, version, &url, &current_branch(&dest));

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
    let r = install_git_into(&plugins_dir()?, &source, reference.as_deref())?;
    set_tree_writable(Path::new(&r.dir), false); // 설치 직후 읽기전용 잠금
    Ok(r)
}

// 설치된 플러그인 갱신 — 설치본은 소스의 미러(사용자 작업공간이 아님): fetch 후
// 원격 상태로 강제 동기화한다. pull(머지 의미론)은 원격 히스토리 재작성에 깨지고,
// 설치본의 로컬 수정은 지원 대상이 아니다(플러그인 개발은 plugin.dev.load).
#[tauri::command]
pub fn plugin_update(id: String) -> Result<PluginInstallResult, String> {
    plugin_update_in(&plugins_dir()?, &id)
}

fn plugin_update_in(base: &Path, id: &str) -> Result<PluginInstallResult, String> {
    sanitize_id(id)?;
    let dir = base.join(id);
    if !dir.is_dir() {
        return Err(format!("설치되지 않은 플러그인: {id}"));
    }
    // 기존 .soksak.json 파싱. 과거 단일-폴더 모델의 dev marker는 reset --hard로 작업물을
    // 훼손하지 않도록 계속 거부한다. 새 개발 source는 설치본 밖 config로 선택한다.
    let prev: Option<serde_json::Value> = std::fs::read_to_string(dir.join(".soksak.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());
    let cur_ver = prev
        .as_ref()
        .and_then(|v| v.get("version").and_then(|x| x.as_str()));
    if cur_ver == Some("dev") || cur_ver == Some("local") {
        return Err("dev/local 모드 플러그인은 update 대상이 아님(작업물 보호)".to_string());
    }
    let branch = prev
        .as_ref()
        .and_then(|v| v.get("branch").and_then(|x| x.as_str()))
        .map(String::from);
    let repo = prev
        .as_ref()
        .and_then(|v| v.get("repo").and_then(|x| x.as_str()))
        .unwrap_or("")
        .to_string();

    set_tree_writable(&dir, true); // git fetch/reset 위해 잠금 해제(실패 시 다음 update 가 재잠금)
    let fetch_args: Vec<&str> = match branch.as_deref() {
        Some(b) => vec!["fetch", "origin", b],
        None => vec!["fetch", "origin"],
    };
    if let Err(e) = git_run(
        std::process::Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(&fetch_args),
    ) {
        return Err(format!("git fetch 실패: {e}"));
    }
    if let Err(e) = git_run(std::process::Command::new("git").arg("-C").arg(&dir).args([
        "reset",
        "--hard",
        "FETCH_HEAD",
    ])) {
        return Err(format!("git reset 실패: {e}"));
    }
    let manifest = std::fs::read_to_string(dir.join("plugin.json"))
        .map_err(|_| "plugin.json 없음".to_string())?;
    // .soksak.json version 갱신(새 manifest version). reset 는 미추적 .soksak.json 을 보존하므로 명시 갱신.
    let new_ver = serde_json::from_str::<serde_json::Value>(&manifest)
        .ok()
        .and_then(|v| v.get("version").and_then(|x| x.as_str()).map(String::from))
        .unwrap_or_else(|| "0.0.0".to_string());
    let final_branch = branch.unwrap_or_else(|| current_branch(&dir));
    write_state(&dir, &new_ver, &repo, &final_branch);
    set_tree_writable(&dir, false); // 갱신 후 다시 읽기전용 잠금
    Ok(PluginInstallResult {
        dir: dir.to_string_lossy().to_string(),
        dir_name: id.to_string(),
        manifest,
    })
}

// 개발 스캐폴드 — <identity-home>/workspaces/plugins/<id>/ 에 최소 plugin.json·main.js 생성
// + git init. 개발 source 상태는 workspace 안의 version 마커가 아니라 identity 홈의 선언적
// development-units.json 이 소유한다. 공식 설치본(~/.soksak*/plugins)과 작업물을 섞지 않는다.
fn plugin_dev_new_in(base: &Path, id: &str) -> Result<PluginInstallResult, String> {
    sanitize_id(id)?;
    std::fs::create_dir_all(base).map_err(|e| e.to_string())?;
    let dir = base.join(id);
    if dir.exists() {
        return Err(format!("이미 존재하는 플러그인 폴더: {id}"));
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let staging = base.join(format!(".tmp-{id}-{}-{nanos}", std::process::id()));
    std::fs::create_dir(&staging).map_err(|e| e.to_string())?;
    let manifest = format!(
        "{{\n  \"spec\": \"soksak-spec-plugin@0.0.1\",\n  \"id\": \"{id}\",\n  \"name\": \"{id}\",\n  \"version\": \"0.0.1\",\n  \"description\": \"새 soksak 플러그인\",\n  \"entry\": \"main.js\",\n  \"permissions\": [],\n  \"contributes\": {{ \"views\": [], \"commands\": [], \"programs\": [] }}\n}}\n"
    );
    let staged = (|| {
        std::fs::write(staging.join("plugin.json"), &manifest).map_err(|e| e.to_string())?;
        std::fs::write(
            staging.join("main.js"),
            "export default { activate() {}, deactivate() {} };\n",
        )
        .map_err(|e| e.to_string())?;
        std::fs::write(staging.join(".gitignore"), "node_modules/\n").map_err(|e| e.to_string())?;
        git_run(
            std::process::Command::new("git")
                .args(["init", "-q"])
                .arg(&staging),
        )?;
        std::fs::rename(&staging, &dir).map_err(|e| format!("workspace 원자 교체 실패: {e}"))?;
        Ok::<(), String>(())
    })();
    if let Err(e) = staged {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    Ok(PluginInstallResult {
        dir: dir.to_string_lossy().to_string(),
        dir_name: id.to_string(),
        manifest,
    })
}

#[tauri::command]
pub fn plugin_dev_new(id: String) -> Result<PluginInstallResult, String> {
    let base = crate::home::soksak_home()
        .join("workspaces")
        .join("plugins");
    let result = plugin_dev_new_in(&base, &id)?;
    let dir = PathBuf::from(&result.dir);
    if let Err(e) = crate::unit_dev::set_source("plugin", &id, &dir) {
        // source 선언까지가 한 트랜잭션이다. 선택되지 않은 반쪽 workspace를 남기지 않는다.
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e);
    }
    Ok(result)
}

// 플러그인 제거(디렉토리째). 전용 저장소(plugins-data)는 남긴다 — 재설치 시 데이터 보존.
#[tauri::command]
pub fn plugin_remove(id: String) -> Result<(), String> {
    sanitize_id(&id)?;
    let dir = plugins_dir()?.join(&id);
    if !dir.exists() {
        return Err(format!("설치되지 않은 플러그인: {id}"));
    }
    set_tree_writable(&dir, true); // 읽기전용 잠금 해제 후 제거(잠긴 트리는 remove 가 막힌다)
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
            .args([
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "-c",
                "commit.gpgsign=false",
            ])
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
            r#"{"spec":"soksak-spec-plugin@0.0.1","id":"fixture-plugin","name":"Fixture","version":"0.1.0"}"#,
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

    // 설치 시 .soksak.json 기록, legacy dev marker면 update 거부(작업물 보호),
    // 정상 설치본이면 기록 브랜치로 fetch+reset 후 version 갱신.
    #[test]
    fn plugin_update_dev_refusal_and_branch_fetch() {
        let root = std::env::temp_dir().join(format!("soksak-plugupd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let src = root.join("fixture-src");
        std::fs::create_dir_all(&src).unwrap();
        git_t(&src, &["init"]);
        let write_manifest = |ver: &str| {
            std::fs::write(
                src.join("plugin.json"),
                format!(
                    r#"{{"spec":"soksak-spec-plugin@0.0.1","id":"upd-plugin","name":"Upd","version":"{ver}"}}"#
                ),
            )
            .unwrap();
        };
        write_manifest("0.1.0");
        git_t(&src, &["add", "."]);
        git_t(&src, &["commit", "-m", "v0.1.0"]);

        let base = root.join("plugins");
        let r = install_git_into(&base, &src.to_string_lossy(), None).unwrap();
        let dir = base.join(&r.dir_name);

        // 설치가 .soksak.json 기록(version=manifest, repo=source, branch=현재).
        let state: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".soksak.json")).unwrap())
                .unwrap();
        assert_eq!(state["version"], "0.1.0");
        assert_eq!(state["repo"].as_str().unwrap(), src.to_string_lossy());
        let branch = state["branch"].as_str().unwrap().to_string();
        assert!(!branch.is_empty());

        // dev 모드면 update 거부.
        std::fs::write(
            dir.join(".soksak.json"),
            r#"{"version":"dev","repo":"x","branch":"main"}"#,
        )
        .unwrap();
        let err = plugin_update_in(&base, "upd-plugin").unwrap_err();
        assert!(err.contains("update 대상이 아님"), "{err}");

        // local 모드(그냥 돌아감)도 update 거부 — 작업물 보호.
        std::fs::write(
            dir.join(".soksak.json"),
            r#"{"version":"local","repo":"","branch":""}"#,
        )
        .unwrap();
        let err = plugin_update_in(&base, "upd-plugin").unwrap_err();
        assert!(err.contains("update 대상이 아님"), "{err}");

        // 설치 모드로 복구 + src 새 버전 → update 가 fetch+reset, version 갱신.
        write_state(&dir, "0.1.0", &src.to_string_lossy(), &branch);
        write_manifest("0.2.0");
        git_t(&src, &["add", "."]);
        git_t(&src, &["commit", "-m", "v0.2.0"]);
        let r2 = plugin_update_in(&base, "upd-plugin").unwrap();
        assert!(r2.manifest.contains("0.2.0"), "{}", r2.manifest);
        let state2: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".soksak.json")).unwrap())
                .unwrap();
        assert_eq!(state2["version"], "0.2.0");

        let _ = std::fs::remove_dir_all(&root);
    }

    // dev 스캐폴드: plugin.json·main.js 생성. source 상태는 외부 config 소유이므로
    // workspace 안에 .soksak.json(version="dev")을 만들지 않는다.
    #[test]
    fn plugin_dev_new_scaffold() {
        let root = std::env::temp_dir().join(format!("soksak-devnew-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let base = root.join("plugins");
        let r = plugin_dev_new_in(&base, "my-plugin").unwrap();
        let dir = base.join("my-plugin");
        assert!(dir.join("plugin.json").is_file());
        assert!(dir.join("main.js").is_file());
        assert!(!dir.join(".soksak.json").exists());
        assert!(r.manifest.contains("my-plugin"));
        let manifest: serde_json::Value = serde_json::from_str(&r.manifest).unwrap();
        assert_eq!(manifest["version"], "0.0.1");
        // 이미 존재하면 거부.
        assert!(plugin_dev_new_in(&base, "my-plugin").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
