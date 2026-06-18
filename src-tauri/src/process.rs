// 범용 서브프로세스 capability — 임의 외부 프로그램을 raw stdio 로 띄우고 양방향 통신한다.
// PTY(pty.rs)와 달리 line discipline·echo·signal 가공이 없는 순수 파이프 → JSON-RPC(LSP/MCP/ACP)·
// 임의 CLI 통합 플러그인이 쓰는 범용 인터페이스다(특정 도구 락인 0). 플러그인 권한 "process" 게이트.
//
// 출력은 stdout/stderr 를 각각 별도 reader 스레드로 읽어 Tauri Channel(raw 바이트)로 스트리밍한다.
// 종료 코드는 stdout EOF 시점에 child.wait() 로 reaping 해 on_exit Channel 로 보낸다(폴링 없음 —
// pty.rs 와 동형으로 reader EOF 가 종료 신호). kill 은 공유 child 핸들을 잠가 보낸다(평시 reader 는
// out.read() 에서 블록 중이라 child 잠금이 비어 있어 즉시 가능).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use crate::secrets::{self, SecretsState};

struct ProcessSession {
    child: Arc<Mutex<Child>>, // kill(세션) + EOF 후 wait(reader) 공유
    stdin: Option<ChildStdin>,
}

#[derive(Default)]
pub struct ProcessManager {
    sessions: Mutex<HashMap<u32, ProcessSession>>,
    next_id: Mutex<u32>,
}

impl ProcessManager {
    // 앱 종료 시: 모든 자식 kill(좀비 방지).
    pub fn kill_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, sess) in sessions.drain() {
                if let Ok(mut c) = sess.child.lock() {
                    let _ = c.kill();
                }
            }
        }
    }
}

// secret_env(envVar→secretKey)를 평문(envVar→평문)으로 해소 — spawn 전 일괄. 비어있으면 빈 벡터.
// 비어있지 않으면 ns 필수. 하나라도 잠김/미존재면 Err(미해소 시크릿이 자식으로 새지 않는다).
// 호출자가 결과를 Command env 로만 흘린다(평문은 Rust+자식 프로세스에만 — JS 반환 0, R2).
fn resolve_secret_env(
    secrets_state: &SecretsState,
    ns: Option<&str>,
    secret_env: &Option<HashMap<String, String>>,
) -> Result<Vec<(String, String)>, String> {
    match secret_env {
        Some(map) if !map.is_empty() => {
            let ns = ns.ok_or("secret_env 주입에는 ns 필수")?;
            let mut out = Vec::with_capacity(map.len());
            for (env_var, secret_key) in map {
                let plain = secrets::resolve(secrets_state, ns, secret_key)?;
                out.push((env_var.clone(), plain));
            }
            Ok(out)
        }
        _ => Ok(Vec::new()),
    }
}

// stdout/stderr 한쪽을 raw 바이트로 Channel 스트리밍하는 reader 루프.
fn pump<R: Read + Send + 'static>(mut src: R, ch: Channel<InvokeResponseBody>) {
    let mut buf = vec![0u8; 8192];
    loop {
        match src.read(&mut buf) {
            Ok(0) => break, // EOF
            Ok(n) => {
                if ch.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

#[tauri::command]
pub fn process_spawn(
    cmd: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    // 부모 env 에서 제거할 키(설정 아닌 제거). 예: ACP 자식 에이전트에서 호스트 중첩 가드(CLAUDECODE)
    // 를 떼어내 "에디터가 띄운 독립 에이전트"로 동작시킨다. 병합(env)으론 못 하는 unset 전용 경로.
    env_remove: Option<Vec<String>>,
    // 시크릿 주입 — ns(보통 플러그인 id) + secret_env(envVar→secretKey). 평문은 여기 Rust 경계에서만
    // 해소돼 자식 env 로 들어간다(JS·셸 args·ps 미노출 R2). secret_env 가 있으면 ns 필수. 잠김/미존재면
    // spawn 하지 않고 Err — 미해소 시크릿이 자식으로 새지 않는다.
    ns: Option<String>,
    secret_env: Option<HashMap<String, String>>,
    on_stdout: Channel<InvokeResponseBody>,
    on_stderr: Channel<InvokeResponseBody>,
    on_exit: Channel<i32>,
    manager: State<'_, ProcessManager>,
    secrets_state: State<'_, SecretsState>,
) -> Result<u32, String> {
    // 시크릿 평문 해소 — spawn 전에 전부 해소(하나라도 잠김/미존재면 spawn 0). Rust 경계에서만 평문 보유.
    let resolved_secrets = resolve_secret_env(&secrets_state, ns.as_deref(), &secret_env)?;

    let mut c = Command::new(&cmd);
    c.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        c.current_dir(cwd);
    }
    if let Some(env) = env {
        for (k, v) in env {
            c.env(k, v);
        }
    }
    if let Some(keys) = env_remove {
        for k in keys {
            c.env_remove(k);
        }
    }
    // 시크릿 평문은 일반 env 뒤에 주입(같은 키면 시크릿 우선). 평문은 이 Command env 와 자식에만 존재.
    for (k, v) in &resolved_secrets {
        c.env(k, v);
    }
    let mut child = c.spawn().map_err(|e| e.to_string())?;

    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));

    // stderr reader — 스트리밍만.
    if let Some(err) = stderr {
        std::thread::spawn(move || pump(err, on_stderr));
    }
    // stdout reader — 스트리밍 + EOF 후 reaping 으로 exit code.
    if let Some(out) = stdout {
        let child = child.clone();
        std::thread::spawn(move || {
            pump(out, on_stdout);
            // stdout EOF = 종료 진행 → wait() 가 곧 반환(블록 짧음 → kill 잠금 경합 없음).
            let code = child
                .lock()
                .ok()
                .and_then(|mut c| c.wait().ok())
                .and_then(|s| s.code())
                .unwrap_or(-1);
            let _ = on_exit.send(code);
        });
    }

    let id = {
        let mut n = manager.next_id.lock().unwrap();
        *n += 1;
        *n
    };
    manager
        .sessions
        .lock()
        .unwrap()
        .insert(id, ProcessSession { child, stdin });
    Ok(id)
}

#[tauri::command]
pub fn process_write(
    id: u32,
    data: String,
    manager: State<'_, ProcessManager>,
) -> Result<(), String> {
    let mut sessions = manager.sessions.lock().unwrap();
    let session = sessions.get_mut(&id).ok_or("no such process")?;
    let stdin = session.stdin.as_mut().ok_or("stdin closed")?;
    stdin.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn process_kill(id: u32, manager: State<'_, ProcessManager>) -> Result<(), String> {
    // 세션 제거 + 자식 kill. stdin 드롭 → stdin 닫힘. kill → stdout EOF → reader 가 on_exit 발신.
    if let Some(session) = manager.sessions.lock().unwrap().remove(&id) {
        if let Ok(mut c) = session.child.lock() {
            let _ = c.kill();
        }
    }
    Ok(())
}

// ── 테스트(secret_env 주입 실증) ─────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::{test_state_with_secret, SecretsState};

    fn tmp_vault_path(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "soksak-proc-secret-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("secrets.vault")
    }

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    // resolve_secret_env + 실제 spawn — secret_env{SOKSAK_SECRET_0:apiKey} 를 자식 env 로 주입하고
    // /bin/sh -c 'printf %s "$SOKSAK_SECRET_0"' 의 stdout 을 캡처해 평문 일치 확인(자식 env 실주입).
    #[test]
    fn secret_env_injected_into_child() {
        let path = tmp_vault_path("inject");
        let state = test_state_with_secret(path.clone(), "pw", "plugin-a", "apiKey", "sk-real-9z");

        let secret_env = Some(map(&[("SOKSAK_SECRET_0", "apiKey")]));
        let resolved = resolve_secret_env(&state, Some("plugin-a"), &secret_env).unwrap();

        // process_spawn 과 동일하게 Command env 로만 주입(평문은 여기서만).
        let mut c = Command::new("/bin/sh");
        c.args(["-c", "printf %s \"$SOKSAK_SECRET_0\""]);
        for (k, v) in &resolved {
            c.env(k, v);
        }
        let out = c.output().expect("spawn sh");
        assert_eq!(String::from_utf8_lossy(&out.stdout), "sk-real-9z");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    // 빈/None secret_env → 빈 벡터(주입 없음), ns 불요.
    #[test]
    fn no_secret_env_is_empty() {
        let state = SecretsState::default();
        assert!(resolve_secret_env(&state, None, &None).unwrap().is_empty());
        assert!(resolve_secret_env(&state, None, &Some(HashMap::new())).unwrap().is_empty());
    }

    // secret_env 있는데 ns 없음 → Err(주입 0).
    #[test]
    fn secret_env_without_ns_rejected() {
        let path = tmp_vault_path("no-ns");
        let state = test_state_with_secret(path.clone(), "pw", "plugin-a", "apiKey", "v");
        let secret_env = Some(map(&[("SOKSAK_SECRET_0", "apiKey")]));
        assert!(resolve_secret_env(&state, None, &secret_env).is_err());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    // 잠긴 볼트 → Err(spawn 0). 미존재 key → Err.
    #[test]
    fn locked_or_missing_rejected() {
        // 잠김 — unlock 안 한 기본 상태.
        let locked = SecretsState::default();
        let se = Some(map(&[("SOKSAK_SECRET_0", "apiKey")]));
        assert!(resolve_secret_env(&locked, Some("plugin-a"), &se).is_err());

        // 미존재 key.
        let path = tmp_vault_path("missing");
        let state = test_state_with_secret(path.clone(), "pw", "plugin-a", "apiKey", "v");
        let bad = Some(map(&[("SOKSAK_SECRET_0", "nope")]));
        assert!(resolve_secret_env(&state, Some("plugin-a"), &bad).is_err());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
