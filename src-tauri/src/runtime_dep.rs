// runtime_dep — 외부 런타임 의존성(4-tuple)의 IO 경계. TS 순수 결정(runtimeDep.ts)이 못 하는 디스크/네트워크:
//   binary_integrity: present/partial/broken 정밀 관찰(심링크 dangling·부분 설치 = 어제 EEXIST).
//   cleanup_stale:    화이트리스트 경로 안의 stale 만 안전 제거(PARTIAL/BROKEN reconcile 의 cleanup).
//   download_verify:  fetch reach — url 다운로드 후 sha256 무결성 검증 + 실행권한.
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

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
                BinaryIntegrity { present: true, partial: false, broken: false }
            } else {
                BinaryIntegrity { present: false, partial: false, broken: true } // dangling
            }
        }
        Ok(_) => BinaryIntegrity { present: true, partial: false, broken: false }, // 일반 파일
        Err(_) => BinaryIntegrity { present: false, partial: lib_exists, broken: false }, // bin 없음 → lib 있으면 partial
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
        Err(_) => ProbeResult { ok: false, stdout: String::new() },
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
    let body = reqwest::blocking::get(&url)
        .map_err(|e| e.to_string())?
        .bytes()
        .map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(&body);
    let got: String = hasher.finalize().iter().map(|b| format!("{:02x}", b)).collect();
    if got != sha256.to_lowercase() {
        return Err(format!("sha256 불일치: 기대={} 실제={}", sha256, got));
    }
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
    let mut hasher = Sha256::new();
    hasher.update(&body);
    let got: String = hasher.finalize().iter().map(|b| format!("{:02x}", b)).collect();
    if got != sha256.to_lowercase() {
        return Err(format!("sha256 불일치(vendor): 기대={} 실제={}", sha256, got));
    }
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
