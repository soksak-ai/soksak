// 사이드바 파일 트리(@pierre/trees)용 디렉토리 리스팅.
// 한 디렉토리의 "직속 자식"만(재귀 X) 돌려준다 → lazy loading. 거대 디렉토리(Library,
// .cache 등)도 펼치기 전엔 한 read_dir 만 하므로 폭주하지 않는다(프론트가 펼침 시 그 폴더를
// 다시 요청). 모든 항목 표시(editor 처럼 gitignore 로 숨기지 않음 — 거대 폴더는 접힌 채).

use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;

#[derive(Serialize)]
pub struct ChildListing {
    // 실제로 해석된 절대경로(path 가 None 이면 HOME).
    root: String,
    children: Vec<Child>,
}

#[derive(Serialize)]
pub struct Child {
    name: String,
    dir: bool,
    // 수정시각(unix 초). meta=true 일 때만 채운다(평상시 트리는 stat 회피 — TCC).
    #[serde(skip_serializing_if = "Option::is_none")]
    modified: Option<u64>,
}

fn home_dir() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
    }
}

// 선행 "~" 를 홈으로 확장(범용 — 플러그인이 ~/.claude 등 홈 하위를 절대경로 없이 가리키게).
// "~" 단독 / "~/..." 만 처리(다른 사용자 "~user" 는 미지원 — 셸이 아니다).
fn expand_path(path: &str) -> PathBuf {
    if path == "~" {
        home_dir()
    } else if let Some(rest) = path.strip_prefix("~/") {
        home_dir().join(rest)
    } else {
        PathBuf::from(path)
    }
}

// 텍스트 로드 상한. editor 의 LARGE_FILE_HEAP_OPERATION_THRESHOLD(256MiB, ~512MB 메모리)와
// 같은 숫자. editor 처럼 크기로 "열기"를 막지 않고 전체를 보되, 이 안전 상한을 넘으면
// 앞부분만 읽고 truncated 로 알린다(webview/IPC OOM 방지).
const TEXT_READ_LIMIT: u64 = 256 * 1024 * 1024;

#[derive(Serialize)]
pub struct TextData {
    content: String,
    truncated: bool,
    read_bytes: u64,
    total_bytes: u64,
    // 읽은 구간의 줄 수(editor 의 30만 줄 토큰화 임계 판단용). Rust 에서 세 효율적.
    line_count: u64,
}

// 파일을 텍스트로 읽는다. 큰 파일은 앞 TEXT_READ_LIMIT 바이트만(truncated=true). 바이너리는
// NUL 바이트 유무로 판정(텍스트엔 NUL 이 없다) 후 에러 → 프론트가 폴백 분기.
// offset(범용): 지정 시 그 바이트부터 끝까지만 읽는다 — 증가하는 로그/JSONL 의 증분 tail.
//   total_bytes 를 다음 offset 으로 추적하면 델타만 읽는다(폴링 아님 + O(delta)). offset 이
//   현재 크기보다 크면(파일 축소·교체) 빈 내용 + 실제 total 을 돌려 프론트가 전체 재독 판단.
#[tauri::command]
pub fn read_text_file(path: String, offset: Option<u64>) -> Result<TextData, String> {
    use std::io::{Read, Seek, SeekFrom};
    let real = expand_path(&path);
    let meta = std::fs::metadata(&real).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("파일이 아님".to_string());
    }
    let total = meta.len();
    let start = offset.unwrap_or(0).min(total);
    let mut f = std::fs::File::open(&real).map_err(|e| e.to_string())?;
    if start > 0 {
        f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    }
    let mut buf = Vec::new();
    f.take(TEXT_READ_LIMIT)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    if buf.contains(&0) {
        return Err("바이너리 파일".to_string());
    }
    let read_bytes = buf.len() as u64;
    let line_count = buf.iter().filter(|&&b| b == b'\n').count() as u64;
    Ok(TextData {
        // 잘린 멀티바이트 문자/드문 비 UTF-8 바이트는 lossy 로 안전 처리.
        content: String::from_utf8_lossy(&buf).into_owned(),
        truncated: total > start + read_bytes,
        read_bytes,
        total_bytes: total,
        line_count,
    })
}

// 바이너리 프리뷰(이미지/PDF/비디오/오디오) 최대 크기. 초과하면 메모리/IPC 부담 방지로 에러.
const MAX_PREVIEW_BYTES: u64 = 40_000_000;

#[derive(Serialize)]
pub struct FileData {
    mime: String,
    base64: String,
}

// 확장자 → MIME. 미리보기 가능한 바이너리 위주. 미지정은 octet-stream.
fn mime_for(path: &str) -> String {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let m = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "apng" => "image/apng",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "m4v" => "video/x-m4v",
        "mkv" => "video/x-matroska",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        _ => "application/octet-stream",
    };
    m.to_string()
}

// 파일을 읽어 base64 + MIME 로 반환(프론트가 data URL 로 렌더). asset 프로토콜 스코프/
// 재시작 변수에 의존하지 않는 IPC 경로 — 미리보기를 신뢰성 있게 보장한다.
#[tauri::command]
pub fn read_file_base64(path: String) -> Result<FileData, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("파일이 아님".to_string());
    }
    if meta.len() > MAX_PREVIEW_BYTES {
        return Err(format!("미리보기 한도 초과: {} bytes", meta.len()));
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(FileData {
        mime: mime_for(&path),
        base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
    })
}

// 파일 저장(에디터 편집 내용). 텍스트를 그대로 덮어쓴다.
#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[cfg(test)]
mod write_tests {
    use super::*;

    // 저장(쓰기)이 디스크에 정확히 반영되고, 재저장 시 덮어쓰는지 검증.
    #[test]
    fn write_text_file_roundtrip_and_overwrite() {
        let dir = std::env::temp_dir().join(format!("soksak-write-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("edit.txt");
        let fp = f.to_string_lossy().to_string();

        write_text_file(fp.clone(), "first\nedit".into()).unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "first\nedit");

        // 재저장(편집 후 ⌘S 재호출 시나리오) → 이전 내용 완전 대체.
        write_text_file(fp, "replaced".into()).unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "replaced");

        let _ = std::fs::remove_dir_all(&dir);
    }
}

// 한 디렉토리의 직속 자식만(재귀 X). path 가 None/빈값이면 HOME. lazy 트리의 단위.
// meta=Some(true): 각 자식의 수정시각(unix 초)도 함께(여러 .jsonl 중 최신 세션 고르기 등).
//   기본(None/false)은 stat 회피(TCC) — 트리 기본 동작 유지.
#[tauri::command]
pub fn list_children(
    path: Option<String>,
    meta: Option<bool>,
) -> Result<ChildListing, String> {
    let root: PathBuf = match path {
        Some(p) if !p.is_empty() => expand_path(&p),
        _ => home_dir(),
    };
    let root = root.canonicalize().unwrap_or(root);
    if !root.is_dir() {
        return Err(format!("디렉토리가 아님: {}", root.to_string_lossy()));
    }
    let want_meta = meta.unwrap_or(false);

    let mut children = Vec::new();
    for entry in std::fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        // dirent 의 file_type 사용(stat 없음) → 보호 폴더(다운로드/데스크탑/문서)를 건드리지
        // 않아 TCC 프롬프트가 불필요하게 뜨지 않는다. 심링크만 대상 종류 확인차 stat.
        let dir = match entry.file_type() {
            Ok(ft) if ft.is_symlink() => entry
                .path()
                .metadata()
                .map(|m| m.is_dir())
                .unwrap_or(false),
            Ok(ft) => ft.is_dir(),
            Err(_) => false,
        };
        // mtime 은 명시 요청 시에만(stat 1회). unix epoch 초.
        let modified = if want_meta {
            entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
        } else {
            None
        };
        children.push(Child {
            name,
            dir,
            modified,
        });
    }
    // 폴더 먼저, 그 다음 이름순(대소문자 무시).
    children.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(ChildListing {
        root: root.to_string_lossy().to_string(),
        children,
    })
}

// ── 외부 테마(플러그인 모델) ─────────────────────────────────────────────────
// 테마는 외부에서 만들어져 ~/.soksak/themes/*.json 으로 들어온다. 검증은 프론트
// 테마 엔진(단일 진실)이 담당 — 여기는 파일 입출력만.

fn themes_dir() -> Result<PathBuf, String> {
    let dir = crate::home::soksak_home().join("themes");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[derive(Serialize)]
pub struct ThemeFile {
    file: String,
    content: String,
}

// 외부 테마 디렉토리의 *.json 전부(내용 포함).
#[tauri::command]
pub fn themes_scan() -> Result<Vec<ThemeFile>, String> {
    let dir = themes_dir()?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "json") {
            if let Ok(content) = std::fs::read_to_string(&path) {
                out.push(ThemeFile {
                    file: path.to_string_lossy().to_string(),
                    content,
                });
            }
        }
    }
    out.sort_by(|a, b| a.file.cmp(&b.file));
    Ok(out)
}

// 테마 파일 설치(외부 경로 → ~/.soksak/themes/). 동명 파일은 덮어쓴다(갱신).
#[tauri::command]
pub fn theme_install(path: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    if src.extension().is_none_or(|e| e != "json") {
        return Err("테마 파일은 .json 이어야 함".into());
    }
    let name = src
        .file_name()
        .ok_or("파일명 없음")?
        .to_string_lossy()
        .to_string();
    let dst = themes_dir()?.join(&name);
    std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
    Ok(dst.to_string_lossy().to_string())
}

// 파일 트리 git 상태 데코레이션용. @pierre/trees 의 GitStatus 와 동일한 문자열.
#[derive(Serialize)]
pub struct GitEntry {
    path: String,
    status: String,
}

// git status --porcelain 의 XY 코드 → GitStatus 한 가지로 분류(우선순위).
fn classify_git(x: u8, y: u8) -> &'static str {
    if x == b'?' && y == b'?' {
        return "untracked";
    }
    if x == b'D' || y == b'D' {
        return "deleted";
    }
    if x == b'R' || y == b'R' || x == b'C' || y == b'C' {
        return "renamed";
    }
    if x == b'A' || y == b'A' {
        return "added";
    }
    "modified"
}

// 디렉토리의 git 변경 상태(트리 root 상대 경로). git repo 가 아니거나 git 실패면 빈 목록.
#[tauri::command]
pub fn git_status(path: String) -> Result<Vec<GitEntry>, String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(&path)
        .args(["status", "--porcelain", "-z"])
        .output();
    let output = match output {
        Ok(o) if o.status.success() => o,
        _ => return Ok(Vec::new()),
    };
    let mut entries = Vec::new();
    let mut iter = output.stdout.split(|&b| b == 0);
    while let Some(rec) = iter.next() {
        if rec.len() < 4 {
            continue; // "XY path" 최소 길이
        }
        let (x, y) = (rec[0], rec[1]);
        // untracked 디렉토리는 git 이 'dir/' 로 보고 → 트리 노드(슬래시 없음)와 매칭되게 제거.
        let rel = String::from_utf8_lossy(&rec[3..])
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_string();
        // 이름변경/복사(R/C)는 다음 NUL 레코드가 원본 경로 → 소비.
        if x == b'R' || y == b'R' || x == b'C' || y == b'C' {
            iter.next();
        }
        entries.push(GitEntry {
            path: rel,
            status: classify_git(x, y).to_string(),
        });
    }
    Ok(entries)
}

// 자동 지정 루트(~/.soksak/projects/<폴더명>) 생성 — 새 프로젝트에서 폴더를
// 지정하지 않은 경우(P3). 앱이 만든 폴더는 앱 관리 영역(~/.soksak)에 둔다.
// folder 는 디렉토리명 계약 — 슬러그만 허용(탈출/주입 차단).
#[tauri::command]
pub fn ensure_workspace_dir(folder: String) -> Result<String, String> {
    let valid = !folder.is_empty()
        && folder
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !folder.starts_with('-');
    if !valid {
        return Err(format!(
            "폴더명 형식 위반: \"{folder}\" — ^[a-z0-9][a-z0-9-]*$"
        ));
    }
    let dir = crate::home::soksak_home().join("projects").join(&folder);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

// 프로젝트 루트 검증(P1/P2) — 존재하는 디렉토리이고, 홈(~)과 파일시스템 루트
// (/)가 아니어야 한다(루트 초기화 정책 플러그인이 루트 전체를 대상으로 동작
// 하므로). 통과 시 정규화(canonicalize) 경로 반환 — 중복 비교(P5)의 기준.
#[tauri::command]
pub fn validate_project_root(path: String) -> Result<String, String> {
    let dir = std::path::Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("디렉토리 아님: {path}"));
    }
    let canon = dir
        .canonicalize()
        .map_err(|e| format!("경로 정규화 실패: {e}"))?;
    let home = home_dir().canonicalize().unwrap_or_else(|_| home_dir());
    if canon == home {
        return Err("홈 디렉토리(~)는 프로젝트 루트가 될 수 없음".to_string());
    }
    if canon.parent().is_none() {
        return Err("파일시스템 루트(/)는 프로젝트 루트가 될 수 없음".to_string());
    }
    Ok(canon.to_string_lossy().to_string())
}
