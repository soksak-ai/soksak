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

// AI 세션 컨텍스트 env 정본 — 이걸 상속한 자식(claude 등)은 자기를 "에이전트 안의 에이전트"로
// 인식해 세션 식별이 비정상이 된다(트랜스크립트·중첩 가드). PTY(pty.rs)와 서브프로세스
// (scrub_ai_env)가 같은 목록을 쓴다 — 목록 추가는 여기 한 곳.
pub const AI_SESSION_ENV: [&str; 8] = [
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_VERSION",
    "CLAUDE_CODE_EXECPATH",
    "CODEX_COMPANION_SESSION_ID",
    "AI_AGENT",
];

struct ProcessSession {
    child: Arc<Mutex<Child>>, // kill(세션) + EOF 후 wait(reader) 공유
    stdin: Option<ChildStdin>,
    // 신규 프로세스 그룹으로 스폰됨(group 옵션) — kill 이 그룹 전체(-pgid)를 겨눈다.
    group: bool,
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
                kill_session(&sess);
            }
        }
    }
}

// 세션 종료 — group 스폰이면 그룹 전체(-pgid)를 먼저 겨눈다: 직계만 죽이면 손자(에이전트의
// Bash 자식 등)가 stdout 파이프를 물고 살아 EOF·exit 가 그들 수명만큼 지연된다(실측: stop 후
// CANCELLED 닫힘이 sleep 손자에 볼모). 직계 kill 은 폴백으로 항상 수행(멱등).
fn kill_session(sess: &ProcessSession) {
    #[cfg(unix)]
    if sess.group {
        if let Ok(c) = sess.child.lock() {
            unsafe {
                libc::killpg(c.id() as i32, libc::SIGKILL);
            }
        }
    }
    if let Ok(mut c) = sess.child.lock() {
        let _ = c.kill();
    }
}

// service 사이드카 이름 해석 — cmd "sidecar:{name}" → <identity 홈>/sidecars/soksak-sidecar-{name}/
// dist/soksak-sidecar-{name}. engine 모델(sidecar.rs module_path)과 대칭: 해석 경로는 identity 홈
// 하나뿐(A17 — env 바이너리 주입 없음), 이름은 traversal-safe 검증. 미존재는 spawn 전 명시 에러.
// "sidecar:" 아닌 cmd 는 그대로(일반 프로세스).
fn resolve_sidecar_cmd(cmd: &str) -> Result<String, String> {
    let Some(name) = cmd.strip_prefix("sidecar:") else {
        return Ok(cmd.to_string());
    };
    let valid = !name.is_empty()
        && name.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !valid {
        return Err(format!("sidecar 이름 불법({name:?}) — ^[a-z0-9][a-z0-9-]*$"));
    }
    let path = crate::home::soksak_home()
        .join("sidecars")
        .join(format!("soksak-sidecar-{name}"))
        .join("dist")
        .join(format!("soksak-sidecar-{name}"));
    if !path.is_file() {
        return Err(format!("sidecar 미설치: {} — identity 홈에 dist 스테이징 필요(stage.sh)", path.display()));
    }
    Ok(path.to_string_lossy().into_owned())
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

// pump 종료 사유 — EOF(자식이 stdout 닫음=종료 진행)와 Channel 죽음(뷰 unmount 등, 자식은 살아있을
// 수 있음)을 구분한다. 이 구분이 데드락 회피의 핵심(아래 reader 참조).
enum PumpEnd {
    Eof,
    Closed,
}

// stdout/stderr 한쪽을 raw 바이트로 Channel 스트리밍하는 reader 루프. 종료 사유를 반환한다.
fn pump<R: Read>(src: &mut R, ch: &Channel<InvokeResponseBody>) -> PumpEnd {
    // 64KB — macOS 파이프 용량과 동급이라 한 번 read 로 파이프를 통째 비운다. 8KB 였을 때 대용량
    // 스트림(OSR 프레임 4MB)이 프레임당 ~512개 Channel 메시지로 쪼개져 프론트 콜백이 폭주했다.
    // 64KB 면 프레임당 read 횟수·메시지 수가 8× 줄어 프론트 IPC 오버헤드가 크게 준다.
    let mut buf = vec![0u8; 65536];
    loop {
        match src.read(&mut buf) {
            Ok(0) => return PumpEnd::Eof, // 자식이 stdout 닫음 → 종료 진행
            Ok(n) => {
                if ch.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                    return PumpEnd::Closed; // Channel 죽음(뷰 unmount) — 자식은 아직 살아있을 수 있다
                }
            }
            Err(_) => return PumpEnd::Eof, // read 에러 = 파이프 끊김 → EOF 취급
        }
    }
}

// 남은 출력을 버리며 EOF 까지 읽는다. Channel 이 죽어 더는 스트리밍하지 않을 때, 자식 파이프가 가득
// 차서 자식이 write 에서 막히는 것(OSR sidecar 는 UI 스레드가 막혀 kill 도 안 먹는 상태)을 방지한다.
// child mutex 를 절대 잡지 않으므로, 이 함수가 (자식이 살아있어) 블록해도 process_kill 은 자유롭게 kill
// 할 수 있다 — kill 되면 자식이 죽어 EOF 가 오고 여기서 반환한다. 이것이 데드락 회피의 요체다.
fn drain<R: Read>(src: &mut R) {
    let mut buf = vec![0u8; 8192];
    loop {
        match src.read(&mut buf) {
            Ok(0) => break,     // EOF(자식 종료)
            Ok(_) => continue,  // 버림
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
    // true = AI 세션 컨텍스트 env 8종(AI_SESSION_ENV 정본, PTY 와 동일) 일괄 제거. 호출자가
    // 목록을 복제하지 않게 하는 스위치 — env_remove 와 합산 적용.
    scrub_ai_env: Option<bool>,
    // true = 신규 프로세스 그룹으로 스폰(Unix) — kill 이 자식 트리 전체를 회수한다. 손자를
    // 낳는 자식(에이전트 CLI 등)에 선언; 기존 소비자는 무영향(기본 false).
    group: Option<bool>,
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

    // service 사이드카 해석 — cmd "sidecar:{name}" 을 identity 홈의 dist 진입점으로 치환(engine 의
    // sidecar.rs 와 대칭: 경로 해석은 코어 단일진실 소유, 플러그인은 이름만 안다 — A17/SIDECARS.md).
    let cmd = resolve_sidecar_cmd(&cmd)?;

    let mut c = Command::new(&cmd);
    c.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // 앱 주입 컨텍스트(A17) — 플러그인 자식이 identity 홈을 파생할 유일한 상시 경로. PTY 의
    // SOKSAK_SOCKET 주입과 같은 계열(소스주입 env 아님 — 앱이 자기 단일진실을 자식에 전파).
    c.env("SOKSAK_HOME", crate::home::soksak_home());
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
    if scrub_ai_env.unwrap_or(false) {
        for k in AI_SESSION_ENV {
            c.env_remove(k);
        }
    }
    let group = group.unwrap_or(false);
    #[cfg(unix)]
    if group {
        use std::os::unix::process::CommandExt;
        c.process_group(0); // pgid = 자식 pid — kill_session 이 그룹 전체를 겨눌 수 있게
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

    // stderr reader — 스트리밍. Channel 죽으면 drain 으로 계속 비운다(자식 stderr 파이프가 차서
    // 자식이 write 에서 막히는 것 방지). child mutex 미접근.
    if let Some(mut err) = stderr {
        std::thread::spawn(move || {
            if let PumpEnd::Closed = pump(&mut err, &on_stderr) {
                drain(&mut err);
            }
        });
    }
    // stdout reader — 스트리밍 + 종료 후 reaping 으로 exit code.
    if let Some(mut out) = stdout {
        let child = child.clone();
        std::thread::spawn(move || {
            // Channel 이 죽어도(뷰 unmount) 자식은 살아있을 수 있다. 그때 child mutex 를 잡은 채 wait()
            // 로 블록하면 process_kill 이 같은 mutex 에서 영구 대기(데드락) → 좀비 자식(과거 32GB swap
            // 폭주의 원인). 그래서 Channel 죽음이면 mutex 없이 drain 으로 EOF(자식 종료)를 기다린 뒤에만
            // wait() 한다 — drain 중엔 lock 이 비어 process_kill 이 즉시 kill 하고, kill 되면 EOF 가 와서
            // drain 이 반환한다.
            if let PumpEnd::Closed = pump(&mut out, &on_stdout) {
                drain(&mut out);
            }
            // 여기 도달 = stdout EOF(자식 종료 진행) → wait() 는 즉시 반환(짧은 lock → kill 경합 없음).
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
        .insert(id, ProcessSession { child, stdin, group });
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
pub fn process_stdin_close(id: u32, manager: State<'_, ProcessManager>) -> Result<(), String> {
    // stdin 만 닫는다(자식은 계속) — take → drop → 파이프 닫힘 → 자식이 EOF 수신. stdin 을 read_to_end
    // 하는 자식(파이프 입력 CLI)은 이 호출 없이는 영원히 블록한다. 이미 닫혔으면 no-op(멱등).
    let mut sessions = manager.sessions.lock().unwrap();
    let session = sessions.get_mut(&id).ok_or("no such process")?;
    drop(session.stdin.take());
    Ok(())
}

#[tauri::command]
pub fn process_kill(id: u32, manager: State<'_, ProcessManager>) -> Result<(), String> {
    // 세션 제거 + 자식 kill(group 스폰이면 트리 전체). stdin 드롭 → stdin 닫힘. kill → stdout
    // EOF → reader 가 on_exit 발신.
    if let Some(session) = manager.sessions.lock().unwrap().remove(&id) {
        kill_session(&session);
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

    // service 사이드카 스킴 — 비스킴 통과 / 불법 이름 거부 / 미설치 명시 에러(경로 형태 포함).
    #[test]
    fn sidecar_scheme_resolution() {
        assert_eq!(resolve_sidecar_cmd("/bin/sh").unwrap(), "/bin/sh");
        assert_eq!(resolve_sidecar_cmd("claude").unwrap(), "claude");
        assert!(resolve_sidecar_cmd("sidecar:").is_err());
        assert!(resolve_sidecar_cmd("sidecar:../evil").is_err());
        assert!(resolve_sidecar_cmd("sidecar:UPPER").is_err());
        let e = resolve_sidecar_cmd("sidecar:definitely-not-installed-xyz").unwrap_err();
        assert!(e.contains("sidecars/soksak-sidecar-definitely-not-installed-xyz/dist/"), "{e}");
    }

    // 앱 주입 컨텍스트(A17) — process_spawn 과 동일 구성으로 자식이 SOKSAK_HOME 을 실제 수신하는지.
    // 플러그인 자식(사이드카 spawn 랩)이 identity 홈을 파생할 유일한 상시 경로의 실증.
    #[test]
    fn soksak_home_injected_into_child() {
        let mut c = Command::new("/bin/sh");
        c.args(["-c", "printf %s \"$SOKSAK_HOME\""]);
        c.env("SOKSAK_HOME", crate::home::soksak_home());
        let out = c.output().expect("spawn sh");
        assert_eq!(
            String::from_utf8_lossy(&out.stdout),
            crate::home::soksak_home().to_string_lossy()
        );
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

    // 데드락 회귀 — 스스로 끝나지 않고 stdout 을 계속 쏟는 자식(OSR sidecar 와 동형)을 reader 가 drain
    // 하는 동안(= Channel 죽음 이후 경로) 다른 스레드에서 child mutex 를 잠그고 kill 이 즉시 되는지.
    // 과거 버그: reader 가 child mutex 를 잡은 채 wait() 로 영구 블록 → process_kill 이 같은 mutex 에서
    // 영구 대기 → 좀비(32GB swap). drain 은 mutex 미보유이므로 kill 이 즉시 되어야 한다.
    #[test]
    fn kill_not_blocked_by_draining_reader() {
        use std::time::{Duration, Instant};

        let mut child = Command::new("/bin/sh")
            .args(["-c", "while true; do echo x; done"]) // 스스로 안 끝남
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut out = child.stdout.take().unwrap();
        let child = Arc::new(Mutex::new(child));

        // reader: Channel 죽음 이후처럼 drain 으로 EOF(자식 종료) 대기 — mutex 미보유.
        let reader_child = child.clone();
        let reader = std::thread::spawn(move || {
            drain(&mut out); // 자식이 죽어야 반환
            let _ = reader_child.lock().ok().and_then(|mut c| c.wait().ok());
        });

        std::thread::sleep(Duration::from_millis(50)); // reader 가 drain 에 진입

        // process_kill 과 동일 경로: child mutex 잠그고 kill. 데드락이면 여기서 영구 블록.
        let t0 = Instant::now();
        {
            let mut c = child.lock().unwrap();
            let _ = c.kill();
        }
        assert!(
            t0.elapsed() < Duration::from_secs(2),
            "kill 은 즉시 반환해야 한다(reader 가 drain 중 mutex 를 안 잡음)"
        );

        reader.join().unwrap();
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
