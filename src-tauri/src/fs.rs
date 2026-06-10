// 사이드바 파일 트리(@pierre/trees)용 디렉토리 리스팅.
// 주어진 경로(없으면 HOME) 아래를 재귀적으로 훑어 root 상대 파일 경로('/' 구분)를
// 반환한다. .git / node_modules 는 건너뛰고, 폭주 방지로 총 개수를 캡한다.
// (트리 모양은 라이브러리가 경로 목록에서 추론하므로 파일 경로만 주면 된다.)

use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;

const MAX_ENTRIES: usize = 8000;

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

fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
    if out.len() >= MAX_ENTRIES {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut items: Vec<_> = entries.flatten().collect();
    items.sort_by_key(|e| e.file_name());
    for entry in items {
        if out.len() >= MAX_ENTRIES {
            return;
        }
        let ft = match entry.file_type() {
            Ok(f) => f,
            Err(_) => continue,
        };
        let path = entry.path();
        if ft.is_dir() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name == ".git" || name == "node_modules" {
                continue;
            }
            walk(root, &path, out);
        } else if ft.is_file() {
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
        // 심볼릭 링크(파일/디렉토리 어느 쪽도 아닌 것으로 분류)는 순환 방지로 건너뜀.
    }
}

// 한 번에 읽어 프론트로 보낼 텍스트 상한. 파일 크기로 막지 않는다 — 이보다 크면 앞부분만
// 읽고 truncated 로 알린다(거대 파일을 webview/IPC 로 통째 보내 멈추는 것 방지).
const TEXT_READ_LIMIT: u64 = 32_000_000;

#[derive(Serialize)]
pub struct TextData {
    content: String,
    truncated: bool,
    read_bytes: u64,
    total_bytes: u64,
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
    Ok(TextData {
        // 잘린 멀티바이트 문자/드문 비 UTF-8 바이트는 lossy 로 안전 처리.
        content: String::from_utf8_lossy(&buf).into_owned(),
        truncated: total > read_bytes,
        read_bytes,
        total_bytes: total,
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
    let mut paths = Vec::new();
    walk(&root, &root, &mut paths);
    let truncated = paths.len() >= MAX_ENTRIES;
    Ok(DirListing {
        root: root.to_string_lossy().to_string(),
        paths,
        truncated,
    })
}
