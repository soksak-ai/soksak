// PTY 세션 관리 + ACK 플로우 컨트롤.
//
// 출력은 portable-pty 마스터에서 별도 reader 스레드로 읽어 Tauri Channel(raw 바이트)로
// 프론트에 스트리밍한다. 플로우 컨트롤은 editor FlowControlConstants를 그대로 따른다:
//   - 미확인(unacked) 바이트가 HIGH(100k) 이상이면 reader 일시정지
//   - 프론트가 보낸 ack 로 unacked 가 LOW(5k) 이하로 떨어지면 재개
// 프론트는 xterm.write 콜백(파싱 완료)에서 5k 바이트마다 ack 를 보낸다.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

const HIGH_WATERMARK: usize = 100_000;
const LOW_WATERMARK: usize = 5_000;

struct FlowState {
    unacked: usize,
    paused: bool,
}

pub struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    flow: Arc<(Mutex<FlowState>, Condvar)>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<u32, PtySession>>,
    next_id: Mutex<u32>,
}

fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

#[tauri::command]
pub fn spawn_terminal(
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    shell: Option<String>,
    on_output: Channel<InvokeResponseBody>,
    manager: State<'_, PtyManager>,
) -> Result<u32, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(shell.unwrap_or_else(default_shell));
    if let Some(cwd) = cwd {
        cmd.cwd(cwd);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;
    // slave 핸들은 더 이상 필요 없다. 닫아야 자식 종료 시 master 가 EOF 를 받는다.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let flow = Arc::new((
        Mutex::new(FlowState {
            unacked: 0,
            paused: false,
        }),
        Condvar::new(),
    ));

    // reader 스레드: blocking read 루프. paused 면 condvar 에서 대기.
    {
        let flow = flow.clone();
        let on_output = on_output.clone();
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 8192];
            loop {
                // 일시정지 상태면 ack 로 깨어날 때까지 대기.
                {
                    let (lock, cvar) = &*flow;
                    let mut st = lock.lock().unwrap();
                    while st.paused {
                        st = cvar.wait(st).unwrap();
                    }
                }
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF (셸 종료)
                    Ok(n) => {
                        if on_output
                            .send(InvokeResponseBody::Raw(buf[..n].to_vec()))
                            .is_err()
                        {
                            break;
                        }
                        let (lock, _) = &*flow;
                        let mut st = lock.lock().unwrap();
                        st.unacked += n;
                        if st.unacked >= HIGH_WATERMARK {
                            st.paused = true;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    let id = {
        let mut n = manager.next_id.lock().unwrap();
        *n += 1;
        *n
    };
    manager.sessions.lock().unwrap().insert(
        id,
        PtySession {
            writer,
            master: pair.master,
            child,
            flow,
        },
    );
    Ok(id)
}

#[tauri::command]
pub fn write_terminal(
    id: u32,
    data: String,
    manager: State<'_, PtyManager>,
) -> Result<(), String> {
    let mut sessions = manager.sessions.lock().unwrap();
    let session = sessions.get_mut(&id).ok_or("no such terminal")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn resize_terminal(
    id: u32,
    cols: u16,
    rows: u16,
    manager: State<'_, PtyManager>,
) -> Result<(), String> {
    let sessions = manager.sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or("no such terminal")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn ack_terminal(id: u32, bytes: usize, manager: State<'_, PtyManager>) -> Result<(), String> {
    let sessions = manager.sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or("no such terminal")?;
    let (lock, cvar) = &*session.flow;
    let mut st = lock.lock().unwrap();
    st.unacked = st.unacked.saturating_sub(bytes);
    if st.paused && st.unacked <= LOW_WATERMARK {
        st.paused = false;
        cvar.notify_all();
    }
    Ok(())
}

#[tauri::command]
pub fn close_terminal(id: u32, manager: State<'_, PtyManager>) -> Result<(), String> {
    if let Some(mut session) = manager.sessions.lock().unwrap().remove(&id) {
        // 일시정지된 reader 를 깨워 EOF 를 받고 종료하도록 한다.
        {
            let (lock, cvar) = &*session.flow;
            let mut st = lock.lock().unwrap();
            st.paused = false;
            cvar.notify_all();
        }
        let _ = session.child.kill();
        // session 드롭 → writer/master 닫힘 → reader EOF.
    }
    Ok(())
}
