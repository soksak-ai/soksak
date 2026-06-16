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
    on_stdout: Channel<InvokeResponseBody>,
    on_stderr: Channel<InvokeResponseBody>,
    on_exit: Channel<i32>,
    manager: State<'_, ProcessManager>,
) -> Result<u32, String> {
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
