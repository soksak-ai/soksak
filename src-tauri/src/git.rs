// 읽기 전용 git 조회(log/show/diff) — 예제 플러그인(git:read 권한)용. fs.rs git_status 와
// 동일한 서브프로세스 패턴. 쓰기 명령 없음 — 커밋 참조는 화이트리스트로 옵션 주입 차단.

use serde::Serialize;

// 커밋 참조 화이트리스트: hex 4~40자 / "HEAD" / "HEAD~N" / "HEAD^" 만. 그 외 전부
// 거부 — 특히 "-" 시작 값(옵션 주입)과 브랜치명 같은 자유 문자열을 받지 않는다.
fn sanitize_commit(c: &str) -> Result<(), String> {
    if (4..=40).contains(&c.len()) && c.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Ok(());
    }
    if c == "HEAD" || c == "HEAD^" {
        return Ok(());
    }
    if let Some(n) = c.strip_prefix("HEAD~") {
        if !n.is_empty() && n.chars().all(|ch| ch.is_ascii_digit()) {
            return Ok(());
        }
    }
    Err(format!("허용되지 않는 커밋 참조: {c:?}"))
}

// git 서브프로세스 1회 실행. 비정상 종료 → stderr 를 에러로(비 git 디렉토리 등 원인
// 그대로 노출 — 프론트가 에러에서 빈 상태를 렌더). stdout 은 lossy 문자열.
fn run_git(dir: &str, args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| format!("git 실행 실패: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[derive(Serialize, Clone)]
pub struct CommitEntry {
    hash: String,
    short: String,
    author: String,
    date: String,
    subject: String,
}

// 레코드 구분 \x1e, 필드 구분 \x1f — subject 의 임의 문자(쉼표/개행 제외 전부)와
// 충돌하지 않는 제어문자 포맷. 필드 부족 레코드는 건너뜀.
fn parse_log(stdout: &str) -> Vec<CommitEntry> {
    let mut out = Vec::new();
    for rec in stdout.split('\x1e') {
        let rec = rec.trim();
        if rec.is_empty() {
            continue;
        }
        let f: Vec<&str> = rec.splitn(5, '\x1f').collect();
        if f.len() != 5 {
            continue;
        }
        out.push(CommitEntry {
            hash: f[0].to_string(),
            short: f[1].to_string(),
            author: f[2].to_string(),
            date: f[3].to_string(),
            subject: f[4].to_string(),
        });
    }
    out
}

// %H 해시 %h 단축해시 %an 작성자 %ad 날짜 %s 제목. \x1e 레코드 종결.
const LOG_FORMAT: &str = "--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1e";
const META_FORMAT: &str = "--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s";

// 커밋 이력(최신순). limit 기본 50, 상한 500(IPC 폭주 방지). skip 으로 페이지네이션.
// 비 git 디렉토리는 Err — 프론트가 에러에서 빈 상태를 렌더.
#[tauri::command]
pub fn git_log(path: String, limit: Option<u32>, skip: Option<u32>) -> Result<Vec<CommitEntry>, String> {
    let limit = limit.unwrap_or(50).min(500).to_string();
    let skip = skip.unwrap_or(0).to_string();
    let stdout = run_git(
        &path,
        &["log", "--date=iso", LOG_FORMAT, "-n", &limit, "--skip", &skip],
    )?;
    Ok(parse_log(&stdout))
}

#[derive(Serialize)]
pub struct CommitFile {
    status: String,
    path: String,
}

#[derive(Serialize)]
pub struct CommitDetail {
    meta: CommitEntry,
    files: Vec<CommitFile>,
    patch: String,
}

// 커밋 1개 상세: 호출 1 = 메타 + 변경 파일 목록(--name-status), 호출 2 = 패치 전문.
#[tauri::command]
pub fn git_show(path: String, commit: String) -> Result<CommitDetail, String> {
    sanitize_commit(&commit)?;
    let head = run_git(&path, &["show", &commit, "--date=iso", META_FORMAT, "--name-status"])?;
    // 첫 비어있지 않은 줄 = 메타(\x1f 5필드), 나머지 = "STATUS\tPATH" 줄들.
    let mut lines = head.lines().filter(|l| !l.trim().is_empty());
    let meta_line = lines.next().ok_or("git show 출력 없음")?;
    let meta = parse_log(meta_line)
        .into_iter()
        .next()
        .ok_or("git show 메타 파싱 실패")?;
    let mut files = Vec::new();
    for line in lines {
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() < 2 {
            continue;
        }
        let Some(file_path) = cols.last() else { continue };
        // 이름변경 "R100\told\tnew" → status 는 첫 글자 "R", path 는 변경 후 경로(new).
        let status = cols[0].chars().next().map(String::from).unwrap_or_default();
        files.push(CommitFile {
            status,
            path: (*file_path).to_string(),
        });
    }
    let patch = run_git(&path, &["show", &commit, "--format=", "--patch"])?;
    Ok(CommitDetail { meta, files, patch })
}

// unified diff 원문. commit 지정 → 그 커밋의 패치, staged=true → index diff,
// 둘 다 없으면 작업트리 diff. file 은 "--" 뒤에 둬 경로로 고정(옵션 주입 차단).
#[tauri::command]
pub fn git_diff(
    path: String,
    file: Option<String>,
    commit: Option<String>,
    staged: Option<bool>,
) -> Result<String, String> {
    let mut args: Vec<&str> = Vec::new();
    if let Some(c) = commit.as_deref() {
        sanitize_commit(c)?;
        args.extend(["show", c, "--format=", "--patch"]);
    } else if staged == Some(true) {
        args.extend(["diff", "--cached"]);
    } else {
        args.push("diff");
    }
    if let Some(f) = file.as_deref() {
        args.extend(["--", f]);
    }
    run_git(&path, &args)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_commit_rules() {
        assert!(sanitize_commit("abc123").is_ok());
        assert!(sanitize_commit(&"a1b2c3d4".repeat(5)).is_ok()); // 40자 hex
        assert!(sanitize_commit("HEAD").is_ok());
        assert!(sanitize_commit("HEAD~3").is_ok());
        assert!(sanitize_commit("HEAD^").is_ok());
        assert!(sanitize_commit("--output=x").is_err());
        assert!(sanitize_commit("main; rm").is_err());
        assert!(sanitize_commit("").is_err());
        assert!(sanitize_commit("-x").is_err());
    }

    #[test]
    fn parse_log_records() {
        let s = "h1\x1fs1\x1f작성자\x1f2026-01-01\x1fsubject one\x1e\nh2\x1fs2\x1fa2\x1fd2\x1fsub two\x1e\n";
        let v = parse_log(s);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].hash, "h1");
        assert_eq!(v[0].short, "s1");
        assert_eq!(v[0].author, "작성자");
        assert_eq!(v[0].subject, "subject one");
        assert_eq!(v[1].date, "d2");
        // 필드 부족 레코드는 건너뜀.
        assert!(parse_log("broken\x1e").is_empty());
        assert!(parse_log("").is_empty());
    }

    // 테스트용 git 실행(전역 설정 비의존 — user/gpgsign 을 -c 로 고정).
    fn git_t(dir: &std::path::Path, args: &[&str]) {
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

    // 커밋 2개(두 번째가 파일 수정) 픽스처 레포.
    fn fixture_repo(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("soksak-gitro-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git_t(&dir, &["init"]);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git_t(&dir, &["add", "."]);
        git_t(&dir, &["commit", "-m", "first"]);
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        git_t(&dir, &["add", "."]);
        git_t(&dir, &["commit", "-m", "second"]);
        dir
    }

    #[test]
    fn fixture_log_show_diff() {
        let dir = fixture_repo("flow");
        let p = dir.to_string_lossy().to_string();

        // log: 최신순 2건, 전체 해시 40자.
        let log = git_log(p.clone(), None, None).unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].subject, "second");
        assert_eq!(log[1].subject, "first");
        assert_eq!(log[0].hash.len(), 40);

        // limit/skip 페이지네이션.
        let one = git_log(p.clone(), Some(1), None).unwrap();
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].subject, "second");
        let skipped = git_log(p.clone(), Some(1), Some(1)).unwrap();
        assert_eq!(skipped[0].subject, "first");

        // show: 변경 파일 목록("M a.txt") + diff 패치.
        let detail = git_show(p.clone(), log[0].hash.clone()).unwrap();
        assert_eq!(detail.meta.hash, log[0].hash);
        assert_eq!(detail.files.len(), 1);
        assert_eq!(detail.files[0].status, "M");
        assert_eq!(detail.files[0].path, "a.txt");
        assert!(detail.patch.contains("diff --git"));
        assert!(detail.patch.contains("+two"));

        // 깨끗한 트리 → 빈 diff.
        let clean = git_diff(p.clone(), None, None, None).unwrap();
        assert_eq!(clean.trim(), "");

        // 미커밋 수정 → 작업트리 diff 에 변경 내용 포함(file 인자 경로 고정 포함).
        std::fs::write(dir.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        let diff = git_diff(p.clone(), Some("a.txt".into()), None, None).unwrap();
        assert!(diff.contains("+three"));

        // add 후엔 작업트리 diff 가 아니라 staged(--cached) diff 에 잡힘.
        git_t(&dir, &["add", "."]);
        let staged = git_diff(p, None, None, Some(true)).unwrap();
        assert!(staged.contains("+three"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_log_non_repo_is_err() {
        let dir = std::env::temp_dir().join(format!("soksak-gitro-norepo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(git_log(dir.to_string_lossy().to_string(), None, None).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
