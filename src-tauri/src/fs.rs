// 사이드바 파일 트리(@pierre/trees)용 디렉토리 리스팅.
// 주어진 경로(없으면 HOME) 아래를 .gitignore 를 존중해(ripgrep 의 ignore 크레이트) 훑어
// root 상대 파일 경로('/' 구분)를 반환한다. .git 과 gitignore 대상(node_modules/.cache/
// target/dist 등)은 자동 제외 → 거대 캐시 디렉토리가 목록을 잠식하지 않는다.
// (트리 모양은 라이브러리가 경로 목록에서 추론하므로 파일 경로만 주면 된다.)

use std::path::{Path, PathBuf};

use base64::Engine;
use ignore::WalkBuilder;
use serde::Serialize;

// gitignore 존중으로 트리가 작아지므로 캡은 안전 백스톱(거대 비-git 디렉토리 대비)으로만.
const MAX_ENTRIES: usize = 50_000;

#[derive(Serialize)]
pub struct DirListing {
    // 실제로 해석된 루트 절대경로(path 가 None 이면 HOME).
    root: String,
    // root 기준 상대 파일 경로 목록('/' 구분).
    paths: Vec<String>,
    // MAX_ENTRIES 에 걸려 일부만 담겼는지.
    truncated: bool,
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
#[tauri::command]
pub fn read_text_file(path: String) -> Result<TextData, String> {
    use std::io::Read;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("파일이 아님".to_string());
    }
    let total = meta.len();
    let f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
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
        truncated: total > read_bytes,
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

#[tauri::command]
pub fn list_dir(path: Option<String>) -> Result<DirListing, String> {
    let root: PathBuf = match path {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => home_dir(),
    };
    let root = root.canonicalize().unwrap_or(root);
    if !root.is_dir() {
        return Err(format!("디렉토리가 아님: {}", root.to_string_lossy()));
    }

    // ignore 크레이트로 .gitignore(+상위/글로벌/.git/info/exclude)를 존중해 훑는다.
    // gitignore 대상(.cache/node_modules/target/dist 등)은 진입조차 안 하므로 거대 캐시가
    // 목록을 잠식하지 않는다. .git 디렉토리는 명시적으로 진입 차단. 닷파일은 표시(hidden=false).
    let mut paths = Vec::new();
    let walker = WalkBuilder::new(&root)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        .filter_entry(|e| e.file_name() != ".git")
        .build();

    for result in walker {
        if paths.len() >= MAX_ENTRIES {
            break;
        }
        let entry = match result {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.depth() == 0 {
            continue; // root 자신
        }
        // 파일만 root 상대경로로(디렉토리는 트리가 경로에서 추론).
        if entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
            if let Ok(rel) = entry.path().strip_prefix(&root) {
                paths.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }

    let truncated = paths.len() >= MAX_ENTRIES;
    Ok(DirListing {
        root: root.to_string_lossy().to_string(),
        paths,
        truncated,
    })
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
