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

// 개발 스캐폴드 — <identity-home>/workspaces/plugins/<id>/ 에 RELEASABLE 플러그인 생성 + git init.
// 사이드카 스캐폴드(sidecar_dev_new_in)와 대칭: 신원(package.json·plugin.json·main.js) + 선언한
// 배포 파일집합(release-files.json — 단일소스 빌더의 discovery 마커) + conformance 테스트 + THIN
// release.yml/test.yml(soksak-spec 를 pin 으로 체크아웃해 단일소스 build-release/publish 를 돈다 —
// 릴리즈 스크립트 vendor 0). 개발 source 상태는 workspace 안의 version 마커가 아니라 identity 홈의
// 선언적 development-units.json 이 소유한다. 공식 설치본(~/.soksak*/plugins)과 작업물을 섞지 않는다.
fn plugin_dev_new_in(base: &Path, id: &str) -> Result<PluginInstallResult, String> {
    sanitize_id(id)?;
    std::fs::create_dir_all(base).map_err(|e| e.to_string())?;
    let dir = base.join(id);
    if dir.exists() {
        return Err(format!("이미 존재하는 플러그인 폴더: {id}"));
    }
    // 노드 주소 = "<id>-root". plugin.json contributes.nodes 가 선언하고 main.js 가 data-node 로
    // 배선한다 — conformance 테스트가 이 둘의 1:1(선언≡배선)을 검사한다.
    let node = format!("{id}-root");
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let staging = base.join(format!(".tmp-{id}-{}-{nanos}", std::process::id()));
    std::fs::create_dir(&staging).map_err(|e| e.to_string())?;
    let manifest = render_plugin(PLUGIN_PLUGIN_JSON, id, &node);
    let staged = (|| {
        let write = |rel: &str, body: String| -> Result<(), String> {
            let p = staging.join(rel);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&p, body).map_err(|e| e.to_string())
        };
        // package.json — private product boundary(단일소스 build-release 가 강제: name===id,
        // private:true, license Apache-2.0, publish* 스크립트 금지) + soksakRelease 소유 블록.
        write("package.json", render_plugin(PLUGIN_PACKAGE_JSON, id, &node))?;
        write("plugin.json", manifest.clone())?;
        write("main.js", render_plugin(PLUGIN_MAIN_JS, id, &node))?;
        // release-files.json — 선언한 배포 파일집합 + discovery 마커(build-release.mjs 가 읽는다).
        write("release-files.json", PLUGIN_RELEASE_FILES_JSON.to_string())?;
        write("src/conformance.test.ts", PLUGIN_CONFORMANCE_TEST_TS.to_string())?;
        write("tsconfig.json", PLUGIN_TSCONFIG_JSON.to_string())?;
        write("README.md", render_plugin(PLUGIN_README, id, &node))?;
        write(".gitignore", PLUGIN_GITIGNORE.to_string())?;
        // THIN 워크플로 — 릴리즈 로직 vendor 0. release.yml 이 soksak-spec 를 pin 으로 체크아웃해
        // 단일소스 release-template(build-release + publish) 를 discovery(=--unit-root 없음)로 돈다.
        write(".github/workflows/release.yml", render_plugin(PLUGIN_RELEASE_YML, id, &node))?;
        write(".github/workflows/test.yml", PLUGIN_TEST_YML.to_string())?;
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

// ── sidecar.new — releasable service-sidecar scaffold ────────────────────────
// Mirrors plugin_dev_new_in's atomic-stage → git init → rename → set_source transaction, but emits
// the sidecar shape: IDENTITY (Cargo.toml, release/unit.json) + STATIC pins (targets.json,
// spec-validator.json — byte-verbatim, never templated) + a serve skeleton + the THIN release.yml
// that references the single-source release-template in soksak-spec. It vendors ZERO release scripts
// (the logic lives once in packages/plugin-spec/release-template). The pin below is the one commit
// the soksak-spec-service Cargo dep, the validator checkout, and spec-validator.json all share.
const SIDECAR_SPEC_PIN: &str = "24ff193f6f2c49cc76b610a58f5dbadabbdf639f";

const SIDECAR_TARGETS_JSON: &str = r#"[
  {
    "target": "aarch64-apple-darwin",
    "runner": "macos-15"
  },
  {
    "target": "aarch64-unknown-linux-gnu",
    "runner": "ubuntu-24.04-arm"
  },
  {
    "target": "x86_64-apple-darwin",
    "runner": "macos-15-intel"
  },
  {
    "target": "x86_64-pc-windows-msvc",
    "runner": "windows-2025"
  },
  {
    "target": "x86_64-unknown-linux-gnu",
    "runner": "ubuntu-24.04"
  }
]
"#;

const SIDECAR_SERVICE_RS: &str = r#"//! Service handler skeleton — replace the `echo` op with the real ones. The wire framing (hello,
//! req/res, idempotency, the mutation mutex) lives in the shared serve harness; this only
//! implements op handlers (PS17).
use serde_json::{json, Value};
use soksak_spec_service::{serve_stdio, Emit, ErrCode, OpCtx, Outcome, ServiceHandler};

pub struct Service;

impl Service {
    pub fn new() -> Self {
        Service
    }
}

impl Default for Service {
    fn default() -> Self {
        Self::new()
    }
}

impl ServiceHandler for Service {
    fn ops(&self) -> Vec<String> {
        vec!["echo".to_string()]
    }

    fn read_only(&self, op: &str) -> bool {
        op == "echo"
    }

    fn handle(&self, op: &str, params: Value, _ctx: &OpCtx, _emit: &Emit) -> Outcome {
        match op {
            "echo" => Outcome::ok(json!({ "echo": params })),
            other => Outcome::err(ErrCode::UnknownOp, format!("unknown op: {other}")),
        }
    }
}

pub fn run_serve() {
    serve_stdio(Service::new());
}
"#;

const SIDECAR_CARGO_TOML: &str = r#"[package]
name = "__ID__"
version = "0.0.1"
edition = "2021"
publish = false
repository = "https://github.com/soksak-ai/__ID__"

[lib]
name = "__CRATE__"

[[bin]]
name = "__ID__"
path = "src/main.rs"

[dependencies]
serde_json = "1"
soksak-spec-service = { git = "https://github.com/soksak-ai/soksak-spec.git", rev = "__PIN__", package = "soksak-spec-service" }
"#;

const SIDECAR_UNIT_JSON: &str = r#"{
  "id": "__ID__",
  "version": "0.0.1",
  "releaseTag": "v0.0.1",
  "repository": "https://github.com/soksak-ai/__ID__",
  "interface": { "id": "__INTERFACE__", "version": "0.0.1" }
}
"#;

const SIDECAR_SPEC_VALIDATOR_JSON: &str = r#"{
  "repository": "https://github.com/soksak-ai/soksak-spec",
  "commit": "__PIN__",
  "validator": "packages/plugin-spec/bin/validate.mjs"
}
"#;

const SIDECAR_MAIN_RS: &str = r#"//! __ID__ service sidecar. Spawned by the core ServiceManager with the `serve` subcommand; speaks
//! the soksak-spec-service NDJSON wire over stdio.
fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    match argv.first().map(String::as_str) {
        Some("serve") | None => __CRATE__::run_serve(),
        Some(other) => {
            eprintln!("__ID__: unknown subcommand '{other}' (expected: serve)");
            std::process::exit(2);
        }
    }
}
"#;

const SIDECAR_LIB_RS: &str = r#"//! __ID__ service sidecar library. Op handlers + the serve entry point.
pub mod service;

pub use service::run_serve;
"#;

const SIDECAR_WIRE_RS: &str = r#"//! Wire smoke test — spawns the real binary, speaks the NDJSON wire, asserts hello + one op.
//! Extend as you add ops.
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

#[test]
fn hello_then_echo() {
    let mut child = Command::new(env!("CARGO_BIN_EXE___ID__"))
        .arg("serve")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn the sidecar");
    let mut stdin = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let hello = lines.next().expect("a hello frame").expect("read hello");
    assert!(hello.contains("\"t\":\"hello\""), "expected a hello frame, got: {hello}");
    writeln!(stdin, "{{\"t\":\"req\",\"id\":\"1\",\"op\":\"echo\",\"params\":{{\"x\":1}}}}").expect("write req");
    let res = lines.next().expect("a res frame").expect("read res");
    assert!(res.contains("\"echo\""), "expected an echo res, got: {res}");
    let _ = child.kill();
}
"#;

const SIDECAR_STAGE_SH: &str = r#"#!/usr/bin/env bash
# Build the sidecar and stage it into <dist>/ for local core-routed loading, or cross-build for a
# release target (the 5-platform CI matrix calls `./stage.sh dist <triple>`). No native engine —
# a service sidecar is a plain cargo build. Usage: stage.sh [<dist-dir>] [<target-triple>]
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"

dist="${1:-dist}"
target="${2:-}"
name="__ID__"

ext=""
case "$target" in *windows*) ext=".exe" ;; esac

if [ -n "$target" ]; then
  cargo build --release --target "$target" --bin "$name"
  reldir="$target/release"
else
  cargo build --release --bin "$name"
  reldir="release"
fi

TARGET_DIR="${CARGO_TARGET_DIR:-target}"
src="$TARGET_DIR/$reldir/$name$ext"
[ -f "$src" ] || { echo "release binary not found at $src" >&2; exit 1; }

mkdir -p "$dist"
tmp="$dist/.$name.tmp.$$"
cp "$src" "$tmp"
chmod +x "$tmp"
mv -f "$tmp" "$dist/$name$ext"
echo "staged: $dist/$name$ext"
"#;

const SIDECAR_README: &str = r#"# __ID__

A soksak service sidecar (interface `__INTERFACE__`). Spawned by the core ServiceManager; speaks the
soksak-spec-service NDJSON wire over stdio.

- `cargo test` — the wire smoke test.
- `./stage.sh` — build + stage into `dist/` for local core-routed loading.
- Release is driven by the single-source pipeline in `soksak-ai/soksak-spec`
  (`.github/workflows/release.yml` checks it out at the pin and runs it — this repo vendors zero
  release logic). Cut a release with the `release` workflow_dispatch on `main`.
"#;

const SIDECAR_GITIGNORE: &str = "/target\n/dist\n";

const SIDECAR_RELEASE_YML: &str = r#"# Release — five-platform native build, then the single-source publish pipeline from soksak-spec.
# This repo vendors NO release logic: the publish job checks out soksak-ai/soksak-spec at the pin
# and runs its release-template scripts against this unit's artifacts.
name: release
on:
  workflow_dispatch:
concurrency:
  group: release-${{ github.repository }}
  cancel-in-progress: false
permissions:
  contents: read
jobs:
  build:
    if: github.ref == 'refs/heads/main'
    strategy:
      fail-fast: false
      matrix:
        include:
          - target: aarch64-apple-darwin
            runner: macos-15
          - target: x86_64-apple-darwin
            runner: macos-15-intel
          - target: aarch64-unknown-linux-gnu
            runner: ubuntu-24.04-arm
          - target: x86_64-unknown-linux-gnu
            runner: ubuntu-24.04
          - target: x86_64-pc-windows-msvc
            runner: windows-2025
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
      - uses: dtolnay/rust-toolchain@4be7066ada62dd38de10e7b70166bc74ed198c30
        with:
          toolchain: "1.96.0"
          targets: ${{ matrix.target }}
      - name: Build and stage the release binary
        shell: bash
        run: ./stage.sh dist "${{ matrix.target }}"
      - id: archive
        shell: bash
        run: |
          ver="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)"
          out="__ID__-$ver-${{ matrix.target }}.tar.gz"
          tar -czf "$out" -C dist .
          if command -v sha256sum >/dev/null 2>&1; then sha256sum "$out" | tee "$out.sha256"; else shasum -a 256 "$out" | tee "$out.sha256"; fi
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: dist-${{ matrix.target }}
          path: |
            __ID__-*.tar.gz
            __ID__-*.tar.gz.sha256
          if-no-files-found: error
          compression-level: 0
  publish:
    needs: build
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          repository: soksak-ai/soksak-spec
          ref: __PIN__
          path: .pipeline
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: "22.12.0"
      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1
        with:
          version: "10.30.3"
      - id: identity
        run: |
          ver="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)"
          echo "tag=v$ver" >> "$GITHUB_OUTPUT"
      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093
        with:
          pattern: dist-*
          path: dist
          merge-multiple: true
      - name: Build the pinned public validator
        working-directory: .pipeline
        run: |
          pnpm --config.node-linker=hoisted --config.symlink=false install --frozen-lockfile
          pnpm --filter @soksak-ai/plugin-spec build
      # The single-source scripts run at this checkout root and discover the unit by its
      # release/unit.json marker — no --unit-root argument, no cwd guessing (DEPLOY §1).
      - name: Build + validate the release documents (single-source scripts, unit discovered)
        run: |
          node .pipeline/packages/plugin-spec/release-template/sidecar/build-release.mjs --commit "${{ github.sha }}" --tag "${{ steps.identity.outputs.tag }}" --artifacts dist --out dist-release
          node .pipeline/packages/plugin-spec/release-template/sidecar/validate-with-spec.mjs --spec-root .pipeline --release-dir dist-release
      - name: Create least-privilege release token
        id: release-token
        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1
        with:
          client-id: ${{ vars.SOKSAK_RELEASE_CLIENT_ID }}
          private-key: ${{ secrets.SOKSAK_RELEASE_PRIVATE_KEY }}
          permission-administration: read
          permission-contents: write
      - name: Publish through owner-enforced immutable releases
        env:
          GH_TOKEN: ${{ steps.release-token.outputs.token }}
        run: |
          enforced="$(gh api "repos/${{ github.repository }}/immutable-releases" --jq '.enabled and .enforced_by_owner')"
          test "$enforced" = "true" || { echo "owner-enforced immutable releases must be enabled before tagging" >&2; exit 1; }
          tag="${{ steps.identity.outputs.tag }}"
          assets="$(find dist dist-release -type f \( -name '*.tar.gz' -o -name '*.sha256' -o -name '*.json' \) | sort)"
          test "$(printf '%s\n' "$assets" | grep -c '\.tar\.gz$')" -eq 5 || { echo "expected 5 platform archives" >&2; exit 1; }
          test "$(printf '%s\n' "$assets" | grep -c '\.tar\.gz\.sha256$')" -eq 5 || { echo "expected 5 archive checksums" >&2; exit 1; }
          test "$(printf '%s\n' "$assets" | grep -c '/release\.json$')" -eq 1 || { echo "expected the owner release manifest" >&2; exit 1; }
          test "$(printf '%s\n' "$assets" | grep -c '/conformance-[a-z]*\.json$')" -eq 3 || { echo "expected 3 conformance reports" >&2; exit 1; }
          gh release create "$tag" --repo "${{ github.repository }}" --target "${{ github.sha }}" --title "$tag" --generate-notes $assets
"#;

/// Validate an unprefixed sidecar name (the id is `soksak-sidecar-<name>`).
fn sanitize_sidecar_name(name: &str) -> Result<(), String> {
    let mut chars = name.chars();
    let head = chars.next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let rest = chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if head && rest {
        Ok(())
    } else {
        Err(format!("잘못된 사이드카 이름: {name:?} (소문자·숫자·- 만, 접두사 없이)"))
    }
}

fn render_sidecar(template: &str, id: &str, crate_name: &str, interface: &str) -> String {
    template
        .replace("__ID__", id)
        .replace("__CRATE__", crate_name)
        .replace("__INTERFACE__", interface)
        .replace("__PIN__", SIDECAR_SPEC_PIN)
}

/// Scaffold a releasable service sidecar under `base`. `name` is unprefixed; the id is
/// `soksak-sidecar-<name>`, the default interface `soksak-spec-sidecar-<name>`. Atomic: stages into
/// a temp dir, git-inits, then renames into place; any failure rolls back the staging dir.
fn sidecar_dev_new_in(
    base: &Path,
    name: &str,
    interface: Option<&str>,
) -> Result<PluginInstallResult, String> {
    sanitize_sidecar_name(name)?;
    let id = format!("soksak-sidecar-{name}");
    let interface = interface.map(str::to_string).unwrap_or_else(|| format!("soksak-spec-sidecar-{name}"));
    if !interface.strip_prefix("soksak-spec-sidecar-").is_some_and(|r| {
        !r.is_empty() && r.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    }) {
        return Err(format!("잘못된 interface id: {interface:?} (soksak-spec-sidecar-<...>)"));
    }
    let crate_name = id.replace('-', "_");

    std::fs::create_dir_all(base).map_err(|e| e.to_string())?;
    let dir = base.join(&id);
    if dir.exists() {
        return Err(format!("이미 존재하는 사이드카 폴더: {id}"));
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let staging = base.join(format!(".tmp-{id}-{}-{nanos}", std::process::id()));
    std::fs::create_dir(&staging).map_err(|e| e.to_string())?;

    let r = &render_sidecar;
    let staged = (|| {
        let write = |rel: &str, body: String| -> Result<(), String> {
            let p = staging.join(rel);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&p, body).map_err(|e| e.to_string())
        };
        write("Cargo.toml", r(SIDECAR_CARGO_TOML, &id, &crate_name, &interface))?;
        write("release/unit.json", r(SIDECAR_UNIT_JSON, &id, &crate_name, &interface))?;
        // targets.json + spec-validator.json are STATIC pins — byte-verbatim, never templated.
        write("release/targets.json", SIDECAR_TARGETS_JSON.to_string())?;
        write("validation/spec-validator.json", render_sidecar(SIDECAR_SPEC_VALIDATOR_JSON, &id, &crate_name, &interface))?;
        write("src/main.rs", r(SIDECAR_MAIN_RS, &id, &crate_name, &interface))?;
        write("src/lib.rs", r(SIDECAR_LIB_RS, &id, &crate_name, &interface))?;
        write("src/service.rs", SIDECAR_SERVICE_RS.to_string())?;
        write("tests/wire.rs", r(SIDECAR_WIRE_RS, &id, &crate_name, &interface))?;
        write("stage.sh", r(SIDECAR_STAGE_SH, &id, &crate_name, &interface))?;
        write("README.md", r(SIDECAR_README, &id, &crate_name, &interface))?;
        write(".gitignore", SIDECAR_GITIGNORE.to_string())?;
        write(".github/workflows/release.yml", r(SIDECAR_RELEASE_YML, &id, &crate_name, &interface))?;
        // stage.sh executable bit — cosmetic on git but correct on disk.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(staging.join("stage.sh"), std::fs::Permissions::from_mode(0o755));
        }
        git_run(std::process::Command::new("git").args(["init", "-q"]).arg(&staging))?;
        std::fs::rename(&staging, &dir).map_err(|e| format!("workspace 원자 교체 실패: {e}"))?;
        Ok::<(), String>(())
    })();
    if let Err(e) = staged {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    Ok(PluginInstallResult {
        dir: dir.to_string_lossy().to_string(),
        dir_name: id,
        manifest: render_sidecar(SIDECAR_UNIT_JSON, "", "", &interface),
    })
}

#[tauri::command]
pub fn sidecar_dev_new(name: String, interface: Option<String>) -> Result<PluginInstallResult, String> {
    let base = crate::home::soksak_home().join("workspaces").join("sidecars");
    let result = sidecar_dev_new_in(&base, &name, interface.as_deref())?;
    let dir = PathBuf::from(&result.dir);
    if let Err(e) = crate::unit_dev::set_source("sidecar", &result.dir_name, &dir) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e);
    }
    Ok(result)
}

// ── plugin.new — releasable plugin scaffold templates ────────────────────────
// Mirrors the sidecar templates: the emission is a set of byte-verbatim files with __ID__/__NODE__/
// __PIN__ placeholders. A plugin is platform-agnostic (one "any" artifact) so there is no build
// matrix or targets.json; the shipped entry is the tracked hand-written main.js (canonical single-
// source plugin pattern: soksak-plugin-reminder-demo). The release.yml vendors ZERO release scripts —
// it checks out soksak-spec at the ONE shared pin (SIDECAR_SPEC_PIN) and runs the single-source
// plugin release-template (build-release + publish), discovering the unit by its release-files.json
// marker (no --unit-root, no cwd guessing).

const PLUGIN_PACKAGE_JSON: &str = r#"{
  "name": "__ID__",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "license": "Apache-2.0",
  "description": "A soksak plugin.",
  "soksakRelease": {
    "kind": "plugin",
    "id": "__ID__",
    "repository": "https://github.com/soksak-ai/__ID__",
    "manifest": "release.json"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "^24.10.1",
    "typescript": "~5.9.3",
    "vitest": "^2.1.8"
  }
}
"#;

const PLUGIN_PLUGIN_JSON: &str = r#"{
  "spec": "soksak-spec-plugin@0.0.1",
  "id": "__ID__",
  "name": { "ko": "__ID__", "en": "__ID__" },
  "version": "0.0.1",
  "description": { "ko": "새 soksak 플러그인", "en": "A new soksak plugin" },
  "entry": "main.js",
  "permissions": ["ui", "commands"],
  "contributes": {
    "views": [
      {
        "id": "main",
        "title": { "ko": "__ID__", "en": "__ID__" },
        "icon": "◆",
        "placements": ["content"],
        "status": []
      }
    ],
    "commands": [
      { "name": "hello", "title": { "ko": "Hello", "en": "Hello" } }
    ],
    "nodes": [
      { "id": "__NODE__", "description": { "ko": "루트 노드", "en": "Root node" } }
    ]
  }
}
"#;

// The tracked ESM entry — hand-written (no build step), the canonical minimal-plugin shape. Registers
// one content view that mounts a single operable root element wired via data-node (dataset.node) to
// the "__NODE__" address declared in plugin.json, plus a `hello` command. controller/commands is the
// SDK module shape the loader consumes; the view registration degrades gracefully without ui.
const PLUGIN_MAIN_JS: &str = r#"// __ID__ — a soksak plugin. One content view mounting an operable root node (C2: addressable via
// ui.tree / ui.input.click) plus a `hello` command. The SDK reminder-demo is the canonical author
// pattern; this seed is releasable as-is (release-files.json + .github/workflows).

// The view's operable root. Its data-node id is declared in plugin.json contributes.nodes and the
// conformance test asserts the two stay 1:1 (declared ≡ wired, both directions).
function mountView(container) {
  const root = document.createElement("div");
  root.dataset.node = "__NODE__";
  root.style.cssText = "display:flex;align-items:center;justify-content:center;height:100%;";
  root.textContent = "__ID__";
  container.replaceChildren(root);
  return () => container.replaceChildren();
}

export default {
  controller: {
    async activate(ctx) {
      const app = ctx.app;
      // Register the content view when the host exposes the ui surface (graceful without it).
      if (app.ui && app.ui.registerView) {
        const cleanups = new WeakMap();
        ctx.subscriptions.push(
          app.ui.registerView("main", {
            mount(container) {
              cleanups.set(container, mountView(container));
            },
            unmount(container) {
              const dispose = cleanups.get(container);
              if (dispose) dispose();
              cleanups.delete(container);
            },
          }),
        );
      }
    },
    async deactivate() {},
  },
  commands: {
    async hello() {
      return { ok: true };
    },
  },
};
"#;

// The unit's own declaration: the exact, ordered file set it ships (the archive input) AND the
// discovery marker build-release.mjs walks up to find. plugin.json + the tracked main.js entry.
const PLUGIN_RELEASE_FILES_JSON: &str = r#"["plugin.json", "main.js"]
"#;

// declared ≡ wired, both directions — mirrors soksak-plugin-activity's nodes conformance test, but the
// wiring source is the tracked entry (main.js) rather than a built bundle, since this plugin ships a
// hand-written main.js. Pure (reads files + string match); runs on vitest, no build step.
const PLUGIN_CONFORMANCE_TEST_TS: &str = r#"// C2 transparency — DOM axis. The view's operable nodes declared in plugin.json contributes.nodes
// must equal the data-node ids actually wired in the shipped entry (main.js), both directions.
// Neither side may lead: an undeclared data-node leaks a hidden control; a declared node with no
// wiring is a phantom. Precedent: soksak-plugin-activity.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(path.join(root, "plugin.json"), "utf8")) as {
  contributes?: { views?: unknown[]; nodes?: Array<{ id: string }> };
};
const entry = readFileSync(path.join(root, "main.js"), "utf8");

const declared = (manifest.contributes?.nodes ?? []).map((n) => n.id);
const wired = [...entry.matchAll(/dataset\.node\s*=\s*[`"']([a-z][a-z0-9-]*)/g)].map((m) => m[1]);
const NODE_ID = /^[a-z][a-z0-9-]*$/;

describe("C2 DOM axis — the view's operable elements are exposed as nodes", () => {
  it("has a view → contributes.nodes is non-empty (view-nodes rule)", () => {
    expect((manifest.contributes?.views ?? []).length).toBeGreaterThan(0);
    expect(declared.length).toBeGreaterThan(0);
  });

  it("declared ≡ wired — plugin.json nodes ↔ main.js dataset.node (both directions)", () => {
    expect([...new Set(wired)].sort()).toEqual([...new Set(declared)].sort());
  });

  it("node ids follow the nodeScan contract (lowercase, hyphen)", () => {
    for (const id of declared) expect(id).toMatch(NODE_ID);
  });
});
"#;

const PLUGIN_TSCONFIG_JSON: &str = r#"{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node"]
  },
  "include": ["src"]
}
"#;

const PLUGIN_README: &str = r#"# __ID__

A soksak plugin. One content view (an operable root node addressable via `ui.tree` / `ui.input.click`)
plus a `hello` command.

- `npm test` — the C2 node conformance test (declared ≡ wired).
- `npm run typecheck` — `tsc --noEmit`.
- `main.js` is the tracked ESM entry (hand-written; no build step).
- Release is driven by the single-source pipeline in `soksak-ai/soksak-spec`
  (`.github/workflows/release.yml` checks it out at the pin and runs it — this repo vendors zero
  release logic). Cut a release with the `release` workflow_dispatch on `main`.
"#;

const PLUGIN_GITIGNORE: &str = "node_modules/\ndist/\n.soksak.json\n*.log\n";

const PLUGIN_TEST_YML: &str = r#"name: test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - run: npm install
      - run: npm run typecheck
      - run: npm test
"#;

const PLUGIN_RELEASE_YML: &str = r#"# Release — the plugin is platform-agnostic (one "any" artifact), so there is no build matrix. This
# repo vendors NO release logic: it checks out soksak-ai/soksak-spec at the pinned commit and runs the
# single-source plugin release-template (build-release + publish) + the pinned public validator.
name: release
on:
  workflow_dispatch:
permissions:
  contents: read
concurrency:
  group: release-${{ github.repository }}
  cancel-in-progress: false
jobs:
  release:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    steps:
      - name: Check out the exact source
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          fetch-depth: 0
          persist-credentials: false
      - name: Check out the pinned single-source release pipeline
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          repository: soksak-ai/soksak-spec
          ref: __PIN__
          path: .pipeline
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: "22.12.0"
      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1
        with:
          version: "10.30.3"
      - name: Install and test the plugin
        run: |
          npm install
          npm run typecheck
          npm test
      - name: Build the pinned public validator
        working-directory: .pipeline
        run: |
          pnpm --config.node-linker=hoisted --config.symlink=false install --frozen-lockfile
          pnpm --filter @soksak-ai/plugin-spec build
      # The single-source scripts run at this checkout root and discover the unit by its
      # release-files.json marker — no --unit-root argument, no cwd guessing (DEPLOY §1).
      - name: Build + validate the release documents (single-source, unit discovered)
        run: |
          node .pipeline/packages/plugin-spec/release-template/build-release.mjs --commit "${{ github.sha }}" --out dist
          node .pipeline/packages/plugin-spec/bin/validate.mjs release dist/release.json
          node .pipeline/packages/plugin-spec/bin/validate.mjs conformance dist/conformance-release.json dist/conformance-plugin.json --release dist/release.json --plugin-manifest plugin.json
          node .pipeline/packages/plugin-spec/bin/validate.mjs plugin plugin.json
      - name: Mint a least-privilege installation token
        id: release-token
        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1
        with:
          client-id: ${{ vars.SOKSAK_RELEASE_CLIENT_ID }}
          private-key: ${{ secrets.SOKSAK_RELEASE_PRIVATE_KEY }}
          owner: ${{ github.repository_owner }}
          repositories: __ID__
          permission-administration: read
          permission-contents: write
      - name: Publish the verified owner manifest and assets (single-source)
        env:
          SOKSAK_RELEASE_TOKEN: ${{ steps.release-token.outputs.token }}
        run: >-
          node .pipeline/packages/plugin-spec/release-template/publish-release.mjs
          --repository "${{ github.repository }}"
          --commit "${{ github.sha }}"
          --artifacts "$GITHUB_WORKSPACE/dist"
          --manifest "$GITHUB_WORKSPACE/dist/release.json"
"#;

fn render_plugin(template: &str, id: &str, node: &str) -> String {
    template
        .replace("__ID__", id)
        .replace("__NODE__", node)
        .replace("__PIN__", SIDECAR_SPEC_PIN)
}

/// Validate an unprefixed plugin name (the id is `soksak-plugin-<name>`). Mirrors sanitize_sidecar_name.
fn sanitize_plugin_name(name: &str) -> Result<(), String> {
    let mut chars = name.chars();
    let head = chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let rest = chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if head && rest {
        Ok(())
    } else {
        Err(format!(
            "잘못된 플러그인 이름: {name:?} (소문자·숫자·- 만, 접두사 없이)"
        ))
    }
}

/// Scaffold a releasable plugin under `base` from an unprefixed name (id = soksak-plugin-<name>).
/// Mirrors sidecar_dev_new_in; the releasable emission itself lives in plugin_dev_new_in (shared with
/// the id-addressed dev scaffolder, so plugin.dev.create and plugin.new emit the identical shape).
fn plugin_dev_new2_in(base: &Path, name: &str) -> Result<PluginInstallResult, String> {
    sanitize_plugin_name(name)?;
    let id = format!("soksak-plugin-{name}");
    plugin_dev_new_in(base, &id)
}

#[tauri::command]
pub fn plugin_dev_new2(name: String) -> Result<PluginInstallResult, String> {
    let base = crate::home::soksak_home()
        .join("workspaces")
        .join("plugins");
    let result = plugin_dev_new2_in(&base, &name)?;
    let dir = PathBuf::from(&result.dir);
    if let Err(e) = crate::unit_dev::set_source("plugin", &result.dir_name, &dir) {
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
    fn sidecar_scaffold_shape() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let base = std::env::temp_dir().join(format!("sc-scaffold-{}-{nanos}", std::process::id()));
        let r = sidecar_dev_new_in(&base, "widget", None).expect("scaffold");
        assert_eq!(r.dir_name, "soksak-sidecar-widget");
        let dir = std::path::PathBuf::from(&r.dir);

        // IDENTITY: Cargo publish=false + bin name, NO build.rs (a service sidecar has no engine).
        let cargo = std::fs::read_to_string(dir.join("Cargo.toml")).unwrap();
        assert!(cargo.contains("publish = false"));
        assert!(cargo.contains("name = \"soksak-sidecar-widget\""));
        assert!(cargo.contains(SIDECAR_SPEC_PIN));
        assert!(!dir.join("build.rs").exists());

        // unit.json — releaseTag/repository derive from id, interface.version === version.
        let unit: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("release/unit.json")).unwrap()).unwrap();
        assert_eq!(unit["id"], "soksak-sidecar-widget");
        assert_eq!(unit["releaseTag"], "v0.0.1");
        assert_eq!(unit["repository"], "https://github.com/soksak-ai/soksak-sidecar-widget");
        assert_eq!(unit["interface"]["id"], "soksak-spec-sidecar-widget");
        assert_eq!(unit["interface"]["version"], "0.0.1");

        // STATIC pins present; spec-validator carries the shared commit.
        assert!(dir.join("release/targets.json").exists());
        let pin: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("validation/spec-validator.json")).unwrap()).unwrap();
        assert_eq!(pin["commit"], SIDECAR_SPEC_PIN);

        // git initialized; vendors ZERO release scripts (logic lives in soksak-spec).
        assert!(dir.join(".git").exists());
        assert!(!dir.join("scripts").exists());
        assert!(dir.join(".github/workflows/release.yml").exists());
        assert!(dir.join("src/service.rs").exists());

        // custom interface honored.
        let r2 = sidecar_dev_new_in(&base, "gauge", Some("soksak-spec-sidecar-metrics")).expect("scaffold2");
        let unit2: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(std::path::Path::new(&r2.dir).join("release/unit.json")).unwrap()).unwrap();
        assert_eq!(unit2["interface"]["id"], "soksak-spec-sidecar-metrics");

        // refusals: existing dir, bad name, interface outside the sidecar namespace.
        assert!(sidecar_dev_new_in(&base, "widget", None).is_err());
        assert!(sidecar_dev_new_in(&base, "Bad", None).is_err());
        assert!(sidecar_dev_new_in(&base, "ok", Some("soksak-browser-spec")).is_err());

        std::fs::remove_dir_all(&base).ok();
    }

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

    // Releasable plugin scaffold — mirrors sidecar_scaffold_shape. name-addressed (plugin.new) and
    // id-addressed (plugin.dev.create) emit the identical releasable shape; closed-key manifests, the
    // single-source discovery marker + THIN workflows, git init, and refusals.
    #[test]
    fn plugin_scaffold_shape() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let base = std::env::temp_dir().join(format!("pl-scaffold-{}-{nanos}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);

        // name-addressed (plugin.new): id = soksak-plugin-<name>.
        let r = plugin_dev_new2_in(&base, "widget").expect("scaffold");
        assert_eq!(r.dir_name, "soksak-plugin-widget");
        let dir = std::path::PathBuf::from(&r.dir);

        // package.json — the private product boundary the single-source build-release enforces.
        let pkg: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("package.json")).unwrap())
                .unwrap();
        assert_eq!(pkg["name"], "soksak-plugin-widget");
        assert_eq!(pkg["private"], true);
        assert_eq!(pkg["type"], "module");
        assert_eq!(pkg["license"], "Apache-2.0");
        assert_eq!(pkg["soksakRelease"]["kind"], "plugin");
        assert_eq!(pkg["soksakRelease"]["id"], "soksak-plugin-widget");
        assert_eq!(pkg["soksakRelease"]["manifest"], "release.json");
        assert_eq!(
            pkg["soksakRelease"]["repository"],
            "https://github.com/soksak-ai/soksak-plugin-widget"
        );
        // no publishConfig, no language-registry publish script (build-release forbids both).
        assert!(pkg.get("publishConfig").is_none());
        assert!(pkg["scripts"]
            .as_object()
            .unwrap()
            .keys()
            .all(|k| !k.to_lowercase().contains("publish")));

        // plugin.json — public plugin boundary + C2: a content view declares status (blocking rule),
        // a "ui"/"commands" permission pair, a hello command, and a wired <id>-root node.
        let plugin: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("plugin.json")).unwrap())
                .unwrap();
        assert_eq!(plugin["spec"], "soksak-spec-plugin@0.0.1");
        assert_eq!(plugin["id"], "soksak-plugin-widget");
        assert_eq!(plugin["version"], "0.0.1");
        assert_eq!(plugin["version"], pkg["version"]);
        assert_eq!(plugin["entry"], "main.js");
        assert!(plugin.get("repo").is_none());
        let perms: Vec<&str> = plugin["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap())
            .collect();
        assert!(perms.contains(&"ui") && perms.contains(&"commands"));
        assert_eq!(plugin["contributes"]["views"][0]["placements"][0], "content");
        // content-view-status (blocking) satisfied — status declared even if empty.
        assert!(plugin["contributes"]["views"][0]["status"].is_array());
        assert_eq!(plugin["contributes"]["commands"][0]["name"], "hello");
        assert_eq!(
            plugin["contributes"]["nodes"][0]["id"],
            "soksak-plugin-widget-root"
        );

        // release-files.json — discovery marker + declared shipped set; plugin.json + main.js present.
        let files: Vec<String> =
            serde_json::from_str(&std::fs::read_to_string(dir.join("release-files.json")).unwrap())
                .unwrap();
        assert!(
            files.contains(&"plugin.json".to_string()) && files.contains(&"main.js".to_string())
        );

        // declared ≡ wired — the node id declared in plugin.json is wired in the tracked entry (main.js),
        // and the SDK module shape (controller/commands, activate) survives.
        let main_js = std::fs::read_to_string(dir.join("main.js")).unwrap();
        assert!(
            main_js.contains("soksak-plugin-widget-root"),
            "node not wired in main.js: {main_js}"
        );
        assert!(main_js.contains("controller:") && main_js.contains("commands:"));
        assert!(main_js.contains("async activate("), "{main_js}");

        // conformance test + tsconfig ship; workflows are THIN single-source (vendor ZERO scripts).
        assert!(dir.join("src/conformance.test.ts").exists());
        assert!(dir.join("tsconfig.json").exists());
        assert!(!dir.join("scripts").exists());
        let rel = std::fs::read_to_string(dir.join(".github/workflows/release.yml")).unwrap();
        assert!(rel.contains(SIDECAR_SPEC_PIN), "release.yml pins soksak-spec");
        assert!(rel.contains("release-template/build-release.mjs"));
        assert!(rel.contains("release-template/publish-release.mjs"));
        assert!(dir.join(".github/workflows/test.yml").exists());

        // git initialized; the workspace carries no install marker (source lives in the identity
        // home's development-units.json, not inside the workspace).
        assert!(dir.join(".git").exists());
        assert!(!dir.join(".soksak.json").exists());

        // id-addressed dev scaffolder (plugin.dev.create) emits the SAME releasable shape.
        let r2 = plugin_dev_new_in(&base, "my-plugin").expect("id scaffold");
        let dir2 = std::path::Path::new(&r2.dir);
        assert!(dir2.join("package.json").exists() && dir2.join("release-files.json").exists());
        let plugin2: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir2.join("plugin.json")).unwrap())
                .unwrap();
        assert_eq!(plugin2["contributes"]["nodes"][0]["id"], "my-plugin-root");

        // refusals: existing dir, prefixed/uppercase/empty name, existing id, bad id.
        assert!(plugin_dev_new2_in(&base, "widget").is_err());
        assert!(plugin_dev_new2_in(&base, "Bad").is_err());
        assert!(plugin_dev_new2_in(&base, "-x").is_err());
        assert!(plugin_dev_new2_in(&base, "").is_err());
        assert!(plugin_dev_new_in(&base, "my-plugin").is_err());
        assert!(plugin_dev_new_in(&base, "Bad").is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

    // Acid test (opt-in — runs node): the emitted plugin actually passes the pinned public validator
    // and its own conformance test on vitest. Discovers the repo-root validator + vitest binary by a
    // declared rule (CARGO_MANIFEST_DIR's parent), never cwd guessing. Run explicitly:
    //   cargo test --lib "plugins::tests::plugin_scaffold_acid" -- --ignored
    #[test]
    #[ignore = "runs node: the pinned public validator + vitest against a real scaffold"]
    fn plugin_scaffold_acid() {
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let validator = repo.join("packages/plugin-spec/bin/validate.mjs");
        let vitest = repo.join("node_modules/.bin/vitest");
        assert!(validator.exists(), "validator missing: {}", validator.display());
        assert!(
            vitest.exists(),
            "vitest missing (run pnpm install at repo root): {}",
            vitest.display()
        );

        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let base = std::env::temp_dir().join(format!("pl-acid-{}-{nanos}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let r = plugin_dev_new2_in(&base, "widget").expect("scaffold");
        let dir = std::path::PathBuf::from(&r.dir);

        // ① the emitted manifest passes the pinned public validator (soksak-validate plugin).
        let v = std::process::Command::new("node")
            .arg(&validator)
            .arg("plugin")
            .arg(dir.join("plugin.json"))
            .output()
            .expect("run validator");
        assert!(
            v.status.success(),
            "validator rejected the scaffold:\nstdout: {}\nstderr: {}",
            String::from_utf8_lossy(&v.stdout),
            String::from_utf8_lossy(&v.stderr)
        );

        // ② the shipped conformance test (declared ≡ wired nodes) passes on vitest, run with the
        // scaffold as the vitest root so the repo's own vitest config does not bleed in.
        let t = std::process::Command::new(&vitest)
            .arg("run")
            .arg("--root")
            .arg(&dir)
            .env("CI", "1")
            .output()
            .expect("run vitest");
        assert!(
            t.status.success(),
            "conformance test failed:\nstdout: {}\nstderr: {}",
            String::from_utf8_lossy(&t.stdout),
            String::from_utf8_lossy(&t.stderr)
        );

        let _ = std::fs::remove_dir_all(&base);
    }
}
