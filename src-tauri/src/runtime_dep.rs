// runtime_dep — 외부 런타임 의존성(4-tuple)의 IO 경계. TS 순수 결정(runtimeDep.ts)이 못 하는 디스크/네트워크:
//   binary_integrity: present/partial/broken 정밀 관찰(심링크 dangling·부분 설치 = 어제 EEXIST).
//   cleanup_stale:    화이트리스트 경로 안의 stale 만 안전 제거(PARTIAL/BROKEN reconcile 의 cleanup).
//   download_verify:  fetch reach — url 다운로드 후 sha256 무결성 검증 + 실행권한.
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

const SHA256_HEX_LEN: usize = 64;

pub(crate) fn sha256_hex(body: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(body);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn verify_sha256(body: &[u8], expected: &str) -> Result<(), String> {
    if expected.len() != SHA256_HEX_LEN
        || !expected
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("sha256 핀은 정확한 64자리 lowercase hex여야 합니다".into());
    }
    let actual = sha256_hex(body);
    if actual != expected {
        return Err(format!("sha256 불일치: 기대={expected} 실제={actual}"));
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct BinaryIntegrity {
    pub present: bool, // bin 이 존재 + 유효(dangling 아님)
    pub partial: bool, // lib 디렉터리 존재하나 bin 부재(어제 EEXIST 의 상태)
    pub broken: bool,  // bin 심링크가 dangling
}

// bin_path = <npm prefix>/bin/<bin>, lib_path = <npm prefix>/lib/node_modules/<pkg>.
// "존재 == 작동" 폐기 — 심링크 무결성과 부분 설치를 구분한다.
#[tauri::command]
pub fn binary_integrity(bin_path: String, lib_path: String) -> BinaryIntegrity {
    let bin = Path::new(&bin_path);
    let lib_exists = Path::new(&lib_path).exists();
    match fs::symlink_metadata(bin) {
        Ok(m) if m.file_type().is_symlink() => {
            // 심링크 — 대상 존재 여부(exists 는 심링크를 따라간다).
            if bin.exists() {
                BinaryIntegrity {
                    present: true,
                    partial: false,
                    broken: false,
                }
            } else {
                BinaryIntegrity {
                    present: false,
                    partial: false,
                    broken: true,
                } // dangling
            }
        }
        Ok(_) => BinaryIntegrity {
            present: true,
            partial: false,
            broken: false,
        }, // 일반 파일
        Err(_) => BinaryIntegrity {
            present: false,
            partial: lib_exists,
            broken: false,
        }, // bin 없음 → lib 있으면 partial
    }
}

#[derive(serde::Serialize)]
pub struct ProbeResult {
    pub ok: bool,       // probe argv 가 exit 0 (실제 작동)
    pub stdout: String, // 버전 추출용 — TS 가 observe.versionRe 로 파싱
}

// observe.probe — bin 을 실제 실행해 작동을 관찰한다. "PATH 존재"가 아니라 "exit 0 = 작동".
// bin 이 절대경로면 그대로, 이름이면 Command 가 PATH 탐색. 실행 자체 실패(부재)도 ok=false.
#[tauri::command]
pub fn probe_binary(bin: String, args: Vec<String>) -> ProbeResult {
    match std::process::Command::new(&bin).args(&args).output() {
        Ok(o) => ProbeResult {
            ok: o.status.success(),
            stdout: String::from_utf8_lossy(&o.stdout).to_string(),
        },
        Err(_) => ProbeResult {
            ok: false,
            stdout: String::new(),
        },
    }
}

// 화이트리스트 루트(npm prefix·~/.soksak 등) 안의 경로만 제거. 그 밖은 거부(안전).
#[tauri::command]
pub fn cleanup_stale(path: String, allowed_roots: Vec<String>) -> Result<bool, String> {
    let p = Path::new(&path);
    let ok = allowed_roots.iter().any(|r| p.starts_with(r));
    if !ok {
        return Err(format!("화이트리스트 밖 경로 거부: {path}"));
    }
    match fs::symlink_metadata(p) {
        Ok(m) if m.file_type().is_symlink() || m.is_file() => {
            fs::remove_file(p).map_err(|e| e.to_string())?;
            Ok(true)
        }
        Ok(_) => {
            fs::remove_dir_all(p).map_err(|e| e.to_string())?;
            Ok(true)
        }
        Err(_) => Ok(false), // 이미 없음(멱등)
    }
}

// fetch reach — url 다운로드 후 sha256 검증. 불일치/실패 시 dest 를 쓰지 않고 Err(무결성 우선).
#[tauri::command]
pub fn download_verify(url: String, dest: String, sha256: String) -> Result<(), String> {
    let body = crate::mediaproxy::honest_get_bytes(&url)?;
    verify_sha256(&body, &sha256)?;
    fs::write(&dest, &body).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dest, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct NpmDirs {
    pub bin_dir: String,
    pub lib_dir: String,
}

// npm 글로벌 prefix → bin/lib 디렉터리(binary_integrity 의 경로 계산용). 로그인 셸로 PATH 보존.
#[tauri::command]
pub fn npm_global_dirs() -> Result<NpmDirs, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let out = std::process::Command::new(&shell)
        .args(["-lc", "npm prefix -g"])
        .output()
        .map_err(|e| e.to_string())?;
    let prefix = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if prefix.is_empty() {
        return Err("npm prefix 미해소".into());
    }
    Ok(NpmDirs {
        bin_dir: format!("{prefix}/bin"),
        lib_dir: format!("{prefix}/lib"),
    })
}

// vendor reach — 저자 번들 파일 sha256 검증 후 dest 에 복사 + 실행권한. 불일치 시 dest 안 건드리고 Err.
#[tauri::command]
pub fn verify_and_link(src: String, dest: String, sha256: String) -> Result<(), String> {
    let body = fs::read(&src).map_err(|e| e.to_string())?;
    verify_sha256(&body, &sha256).map_err(|e| format!("vendor {e}"))?;
    let _ = fs::remove_file(&dest);
    fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dest, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn tmp() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("rtdep-{}", std::process::id()));
        let _ = fs::create_dir_all(&d);
        d
    }

    #[test]
    fn integrity_absent_partial_broken_present() {
        let d = tmp();
        let bin = d.join("bin-x");
        let lib = d.join("lib-x");
        // ABSENT: 둘 다 없음
        let r = binary_integrity(bin.to_string_lossy().into(), lib.to_string_lossy().into());
        assert!(!r.present && !r.partial && !r.broken);
        // PARTIAL: lib 만 존재
        fs::create_dir_all(&lib).unwrap();
        let r = binary_integrity(bin.to_string_lossy().into(), lib.to_string_lossy().into());
        assert!(r.partial && !r.present);
        // BROKEN: bin 이 dangling 심링크
        let _ = symlink(d.join("nonexistent"), &bin);
        let r = binary_integrity(bin.to_string_lossy().into(), lib.to_string_lossy().into());
        assert!(r.broken && !r.present);
        // PRESENT: 심링크 대상 존재
        let target = d.join("real");
        fs::write(&target, b"x").unwrap();
        let _ = fs::remove_file(&bin);
        let _ = symlink(&target, &bin);
        let r = binary_integrity(bin.to_string_lossy().into(), lib.to_string_lossy().into());
        assert!(r.present && !r.broken && !r.partial);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn cleanup_rejects_outside_whitelist() {
        assert!(cleanup_stale("/etc/passwd".into(), vec!["/tmp".into()]).is_err());
    }

    #[test]
    fn probe_reports_exit_and_stdout() {
        // 작동: echo 는 exit 0 + stdout
        let r = probe_binary("echo".into(), vec!["hello".into()]);
        assert!(r.ok && r.stdout.contains("hello"));
        // 존재하나 작동 실패: false 는 exit 1 (present != working)
        let r = probe_binary("false".into(), vec![]);
        assert!(!r.ok);
        // 부재: 없는 bin → 실행 실패 → ok=false
        let r = probe_binary("definitely-no-such-bin-xyz".into(), vec![]);
        assert!(!r.ok);
    }
}

// ── 사이드카 아카이브 설치(fetch reach) ──────────────────────────────────────────────────────
// tmp 다운로드 → sha256 핀 → tar 해제 → entry 존재 확인 → 원자적 rename. 실패는 어느 단계든
// 목적지에 아무것도 남기지 않는다(download_verify 와 같은 무결성 우선 규칙).

pub fn download_unpack_verify(
    url: &str,
    sha256: &str,
    dest_dir: &Path,
    entry: &str,
) -> Result<(), String> {
    let body = download_verified_bytes(url, sha256)?;
    unpack_verify_install(&body, sha256, dest_dir, entry)
}

pub(crate) fn download_verified_bytes(url: &str, sha256: &str) -> Result<Vec<u8>, String> {
    let body = crate::mediaproxy::honest_get_bytes(url)?;
    if body.len() > MAX_ARCHIVE_BYTES {
        return Err(format!("archive 압축 크기 한도 초과: {MAX_ARCHIVE_BYTES}"));
    }
    verify_sha256(&body, sha256)?;
    Ok(body)
}

const MAX_ARCHIVE_BYTES: usize = 512 * 1024 * 1024;
const MAX_ARCHIVE_FILES: usize = 20_000;
const MAX_ARCHIVE_FILE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_PATH_BYTES: usize = 512;

fn windows_reserved_name(segment: &str) -> bool {
    let stem = segment.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

/// One portable spelling for every archive path. No host normalization or filesystem lookup is
/// allowed to reinterpret an owner-provided name.
pub(crate) fn validate_archive_path(path: &str) -> Result<PathBuf, String> {
    if path.is_empty()
        || path.len() > MAX_ARCHIVE_PATH_BYTES
        || path.starts_with('/')
        || path.starts_with('\\')
        || !path.is_ascii()
    {
        return Err(format!(
            "archive path가 portable relative ASCII 경로가 아닙니다: {path:?}"
        ));
    }
    let mut result = PathBuf::new();
    for segment in path.split('/') {
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.len() > 255
            || segment.ends_with(' ')
            || segment.ends_with('.')
            || windows_reserved_name(segment)
            || segment
                .bytes()
                .any(|byte| byte < 0x20 || byte == 0x7f || b"<>:\"\\|?*".contains(&byte))
        {
            return Err(format!("안전하지 않은 archive path segment: {segment:?}"));
        }
        result.push(segment);
    }
    if result.components().any(|component| {
        matches!(
            component,
            Component::Prefix(_) | Component::RootDir | Component::ParentDir | Component::CurDir
        )
    }) {
        return Err(format!("archive path traversal 거부: {path:?}"));
    }
    Ok(result)
}

fn set_installed_mode(path: &Path, source_mode: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if source_mode & 0o111 == 0 {
            0o644
        } else {
            0o755
        };
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    let _ = (path, source_mode);
    Ok(())
}

fn extract_regular_archive(body: &[u8], destination: &Path) -> Result<(), String> {
    let decoder = flate2::read::GzDecoder::new(std::io::Cursor::new(body));
    let mut archive = tar::Archive::new(decoder);
    let mut paths = HashSet::new();
    let mut files = 0usize;
    let mut total_bytes = 0u64;

    let entries = archive
        .entries()
        .map_err(|e| format!("tar index 읽기 실패: {e}"))?;
    for item in entries {
        let mut entry = item.map_err(|e| format!("tar entry 읽기 실패: {e}"))?;
        let entry_type = entry.header().entry_type();
        // 디렉토리 엔트리는 구조 메타데이터다(관례적 tar 가 항상 싣는다) — 내용이 아니므로
        // 건너뛴다. 파일 경로 검증이 상위 디렉토리를 만들 때 동일 규칙을 이미 강제한다.
        // 심링크·하드링크·디바이스 등은 여전히 거부(정규 파일만 실체화).
        if entry_type.is_dir() {
            continue;
        }
        if !entry_type.is_file() {
            let label = if entry_type.is_symlink() {
                "symlink"
            } else if entry_type.is_hard_link() {
                "hardlink"
            } else {
                "non-regular"
            };
            return Err(format!("archive {label} entry는 금지됩니다"));
        }
        files += 1;
        if files > MAX_ARCHIVE_FILES {
            return Err(format!("archive file 수 한도 초과: {MAX_ARCHIVE_FILES}"));
        }

        let raw_path = entry.path_bytes();
        let path_text = std::str::from_utf8(raw_path.as_ref())
            .map_err(|_| "archive path는 UTF-8이어야 합니다".to_string())?
            .to_owned();
        // 관례적 tar 는 엔트리를 "./name" 으로 싣는다 — 선두 "./" 는 구조 표기라 벗긴다.
        // 이후 검증은 그대로("."·".." 세그먼트·절대경로 전부 거부).
        let path_text = path_text
            .strip_prefix("./")
            .map(str::to_owned)
            .unwrap_or(path_text);
        let relative = validate_archive_path(&path_text)?;
        let portable_key = path_text.to_ascii_lowercase();
        if !paths.insert(portable_key) {
            return Err(format!("archive 중복/portable collision: {path_text}"));
        }

        let declared_size = entry.size();
        if declared_size > MAX_ARCHIVE_FILE_BYTES {
            return Err(format!("archive file 크기 한도 초과: {path_text}"));
        }
        total_bytes = total_bytes
            .checked_add(declared_size)
            .ok_or_else(|| "archive 전체 크기 overflow".to_string())?;
        if total_bytes > MAX_ARCHIVE_TOTAL_BYTES {
            return Err(format!(
                "archive 전체 크기 한도 초과: {MAX_ARCHIVE_TOTAL_BYTES}"
            ));
        }

        let output = destination.join(&relative);
        let parent = output
            .parent()
            .ok_or_else(|| format!("archive entry 상위 경로 없음: {path_text}"))?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        crate::path_security::reject_symlink_components(parent)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)
            .map_err(|e| format!("archive entry 생성 실패 {path_text}: {e}"))?;
        let copied = std::io::copy(&mut entry, &mut file)
            .map_err(|e| format!("archive entry 쓰기 실패 {path_text}: {e}"))?;
        file.flush().map_err(|e| e.to_string())?;
        if copied != declared_size {
            return Err(format!(
                "archive entry 크기 불일치 {path_text}: 선언={declared_size} 실제={copied}"
            ));
        }
        let mode = entry.header().mode().map_err(|e| e.to_string())?;
        set_installed_mode(&output, mode)?;
    }
    if files == 0 {
        return Err("archive에 regular file이 없습니다".into());
    }
    Ok(())
}

// 순수부(네트워크 분리 — 유닛테스트 대상). dest_dir 이 이미 있으면 거부(멱등은 호출자가 entry
// 존재로 판정). tmp 는 dest 형제(같은 파일시스템 = rename 원자성 보장).
pub fn unpack_verify_install(
    body: &[u8],
    sha256: &str,
    dest_dir: &Path,
    entry: &str,
) -> Result<(), String> {
    unpack_verify_install_entries(body, sha256, dest_dir, &[entry.to_string()])
}

pub(crate) fn unpack_verify_install_entries(
    body: &[u8],
    sha256: &str,
    dest_dir: &Path,
    entries: &[String],
) -> Result<(), String> {
    if body.len() > MAX_ARCHIVE_BYTES {
        return Err(format!("archive 압축 크기 한도 초과: {MAX_ARCHIVE_BYTES}"));
    }
    verify_sha256(body, sha256)?;
    if !dest_dir.is_absolute() {
        return Err(format!(
            "설치 목적지는 절대경로여야 합니다: {}",
            dest_dir.display()
        ));
    }
    if fs::symlink_metadata(dest_dir).is_ok() {
        return Err(format!("목적지 이미 존재: {}", dest_dir.display()));
    }
    let parent = dest_dir.parent().ok_or("목적지 부모 없음")?;
    crate::path_security::reject_symlink_components(parent)?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    crate::path_security::reject_symlink_components(parent)?;
    if entries.is_empty() {
        return Err("최소 한 개의 선언 entrypoint가 필요합니다".into());
    }
    let expected_entries = entries
        .iter()
        .map(|entry| validate_archive_path(entry))
        .collect::<Result<Vec<_>, _>>()?;
    if expected_entries.iter().collect::<HashSet<_>>().len() != expected_entries.len() {
        return Err("중복 선언 entrypoint는 금지됩니다".into());
    }
    let tmp_dir = parent.join(format!(".unpack-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&tmp_dir).map_err(|e| format!("임시 설치 디렉터리 생성 실패: {e}"))?;
    let extracted = extract_regular_archive(body, &tmp_dir).and_then(|()| {
        for (entry, expected_entry) in entries.iter().zip(expected_entries.iter()) {
            let installed_entry = tmp_dir.join(expected_entry);
            let metadata = fs::symlink_metadata(&installed_entry)
                .map_err(|_| format!("아카이브에 entry 없음: {entry}"))?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(format!("아카이브 entry가 regular file이 아닙니다: {entry}"));
            }
        }
        Ok(())
    });
    if let Err(error) = extracted {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err(error);
    }
    if let Err(error) = fs::rename(&tmp_dir, dest_dir) {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err(format!("설치 rename 실패: {error}"));
    }
    Ok(())
}

#[cfg(test)]
mod unpack_tests {
    use super::*;
    use std::io::Cursor;

    fn tmp_root(name: &str) -> std::path::PathBuf {
        // macOS의 /var는 /private/var symlink다. 제품 경계를 낮추지 않고 fixture만 물리 경로에 둔다.
        let temp = std::env::temp_dir()
            .canonicalize()
            .unwrap_or_else(|_| std::env::temp_dir());
        let d = temp.join(format!("soksak-unpack-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    // dest 내용물(top-level entry) 구조의 canonical tar.gz 바이트 — 테스트도 host tar에 기대지 않는다.
    fn make_archive(_root: &std::path::Path) -> Vec<u8> {
        archive_with_raw_entries(&[("mod.dylib", tar::EntryType::Regular, b"fake")])
    }

    fn sha_of(b: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(b);
        h.finalize().iter().map(|x| format!("{:02x}", x)).collect()
    }

    fn archive_with_link(entry_type: tar::EntryType) -> Vec<u8> {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut builder = tar::Builder::new(encoder);

        let target = b"real sidecar bytes";
        let mut target_header = tar::Header::new_gnu();
        target_header.set_size(target.len() as u64);
        target_header.set_mode(0o755);
        target_header.set_entry_type(tar::EntryType::Regular);
        target_header.set_cksum();
        builder
            .append_data(&mut target_header, "real-binary", Cursor::new(target))
            .unwrap();

        let mut link_header = tar::Header::new_gnu();
        link_header.set_size(0);
        link_header.set_mode(0o755);
        link_header.set_entry_type(entry_type);
        link_header.set_link_name("real-binary").unwrap();
        link_header.set_cksum();
        builder
            .append_data(&mut link_header, "mod.dylib", Cursor::new([]))
            .unwrap();

        builder.into_inner().unwrap().finish().unwrap()
    }

    fn archive_with_raw_entries(entries: &[(&str, tar::EntryType, &[u8])]) -> Vec<u8> {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut builder = tar::Builder::new(encoder);
        for (path, entry_type, bytes) in entries {
            assert!(
                path.len() < 100,
                "test helper only writes the ustar name field"
            );
            let mut header = tar::Header::new_gnu();
            header.as_mut_bytes()[..path.len()].copy_from_slice(path.as_bytes());
            header.set_size(bytes.len() as u64);
            header.set_mode(0o755);
            header.set_entry_type(*entry_type);
            header.set_cksum();
            builder.append(&header, Cursor::new(*bytes)).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn sha_mismatch_writes_nothing() {
        let root = tmp_root("sha");
        let body = make_archive(&root);
        let dest = root.join("installed");
        let err = unpack_verify_install(&body, &"0".repeat(64), &dest, "mod.dylib").unwrap_err();
        assert!(err.contains("sha256 불일치"));
        assert!(!dest.exists());
    }

    #[test]
    fn valid_archive_installs_atomically() {
        let root = tmp_root("ok");
        let body = make_archive(&root);
        let dest = root.join("installed");
        unpack_verify_install(&body, &sha_of(&body), &dest, "mod.dylib").unwrap();
        assert!(dest.join("mod.dylib").is_file());
        // 재설치는 목적지 존재로 거부(멱등 판정은 호출자가 entry 존재로 — sidecar_ensure)
        let err = unpack_verify_install(&body, &sha_of(&body), &dest, "mod.dylib").unwrap_err();
        assert!(err.contains("이미 존재"));
    }

    #[test]
    fn missing_entry_writes_nothing() {
        let root = tmp_root("entry");
        let body = make_archive(&root);
        let dest = root.join("installed");
        let err = unpack_verify_install(&body, &sha_of(&body), &dest, "other.dylib").unwrap_err();
        assert!(err.contains("entry 없음"));
        assert!(!dest.exists());
    }

    #[test]
    fn symlink_entry_is_rejected_without_installing_anything() {
        let root = tmp_root("symlink-entry");
        let body = archive_with_link(tar::EntryType::Symlink);
        let dest = root.join("installed");
        let err = unpack_verify_install(&body, &sha_of(&body), &dest, "mod.dylib")
            .expect_err("archive symlink must never become an installed sidecar");
        assert!(err.contains("symlink") || err.contains("링크"), "{err}");
        assert!(!dest.exists());
    }

    #[test]
    fn hardlink_entry_is_rejected_without_installing_anything() {
        let root = tmp_root("hardlink-entry");
        let body = archive_with_link(tar::EntryType::Link);
        let dest = root.join("installed");
        let err = unpack_verify_install(&body, &sha_of(&body), &dest, "mod.dylib")
            .expect_err("archive hardlink must never become an installed sidecar");
        assert!(err.contains("hardlink") || err.contains("링크"), "{err}");
        assert!(!dest.exists());
    }

    #[test]
    fn digest_pin_must_be_exact_lowercase_sha256() {
        let root = tmp_root("sha-shape");
        let body = make_archive(&root);
        for invalid in [
            "deadbeef".to_string(),
            "A".repeat(64),
            format!("{} ", sha_of(&body)),
        ] {
            let dest = root.join(format!("installed-{}", invalid.len()));
            let err = unpack_verify_install(&body, &invalid, &dest, "mod.dylib")
                .expect_err("non-canonical digest pin must be rejected before installation");
            assert!(err.contains("sha256"), "{err}");
            assert!(!dest.exists());
        }
    }

    #[test]
    fn traversal_absolute_and_non_regular_paths_are_rejected() {
        for (name, path, entry_type) in [
            ("parent", "../escape", tar::EntryType::Regular),
            ("absolute", "/absolute", tar::EntryType::Regular),
        ] {
            let root = tmp_root(name);
            let body = archive_with_raw_entries(&[(path, entry_type, b"x")]);
            let dest = root.join("installed");
            let err = unpack_verify_install(&body, &sha_of(&body), &dest, path)
                .expect_err("unsafe/non-regular archive entry must be rejected");
            assert!(
                err.contains("archive path")
                    || err.contains("segment")
                    || err.contains("non-regular"),
                "{err}"
            );
            assert!(!dest.exists());
            assert!(!root.join("escape").exists());
        }
    }

    #[test]
    fn directory_entries_are_structural_and_skipped() {
        // 관례적 tar 는 디렉토리 엔트리를 싣는다 — 내용이 아니므로 건너뛰고 설치는 성공한다.
        let root = tmp_root("dir-skip");
        let body = archive_with_raw_entries(&[
            ("./", tar::EntryType::Directory, b""),
            ("./bin", tar::EntryType::Directory, b""),
            ("./bin/tool", tar::EntryType::Regular, b"x"),
        ]);
        let dest = root.join("installed");
        unpack_verify_install(&body, &sha_of(&body), &dest, "bin/tool")
            .expect("directory entries must not fail a lawful archive");
        assert!(dest.join("bin/tool").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn duplicate_and_case_colliding_paths_are_rejected() {
        for (name, second) in [("duplicate", "mod.dylib"), ("case", "MOD.DYLIB")] {
            let root = tmp_root(name);
            let body = archive_with_raw_entries(&[
                ("mod.dylib", tar::EntryType::Regular, b"one"),
                (second, tar::EntryType::Regular, b"two"),
            ]);
            let dest = root.join("installed");
            let err = unpack_verify_install(&body, &sha_of(&body), &dest, "mod.dylib")
                .expect_err("portable path collision must reject the whole archive");
            assert!(err.contains("collision") || err.contains("중복"), "{err}");
            assert!(!dest.exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn destination_with_symlink_ancestor_is_rejected() {
        use std::os::unix::fs::symlink;

        let root = tmp_root("destination-symlink");
        let physical = root.join("physical");
        let linked = root.join("linked");
        fs::create_dir_all(&physical).unwrap();
        symlink(&physical, &linked).unwrap();
        let body = archive_with_raw_entries(&[("mod.dylib", tar::EntryType::Regular, b"sidecar")]);
        let dest = linked.join("installed");
        let err = unpack_verify_install(&body, &sha_of(&body), &dest, "mod.dylib")
            .expect_err("destination symlink ancestor must not be canonicalized through");
        assert!(err.contains("symlink") || err.contains("junction"), "{err}");
        assert!(!physical.join("installed").exists());
    }
}
