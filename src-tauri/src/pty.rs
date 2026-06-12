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

impl PtyManager {
    // 앱 종료 시 호출: 모든 세션의 자식 프로세스를 kill 하고 reader 를 깨워 정리한다.
    // 호출하지 않으면 종료가 force-quit 등으로 일어날 때 셸/자식이 좀비로 남을 수 있다.
    pub fn kill_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, mut session) in sessions.drain() {
                let (lock, cvar) = &*session.flow;
                if let Ok(mut st) = lock.lock() {
                    st.paused = false;
                    cvar.notify_all();
                }
                let _ = session.child.kill();
            }
        }
    }
}

fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

// 셸 통합 스크립트를 바이너리에 임베드.
const ZSH_INTEGRATION: &str = include_str!("../scripts/shell-integration.zsh");

// zsh 일 때 OSC 133/7 셸 통합을 주입한다. 임시 ZDOTDIR 에 .zshenv/.zshrc 를 써서
// 사용자 원본 설정을 먼저 source 한 뒤 통합 스크립트를 로드한다(사용자 설정 보존).
// 실패해도 통합만 빠질 뿐 셸은 정상 동작하므로 에러를 전파하지 않는다.
fn setup_zsh_integration(cmd: &mut CommandBuilder, shell: &str) {
    let is_zsh = std::path::Path::new(shell)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n == "zsh")
        .unwrap_or(false);
    if !is_zsh {
        return;
    }

    let dir = std::env::temp_dir().join("vsterm-zdotdir");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let integ = dir.join("shell-integration.zsh");
    if std::fs::write(&integ, ZSH_INTEGRATION).is_err() {
        return;
    }

    let orig = std::env::var("ZDOTDIR")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_default();

    let zshenv = "[[ -f \"$VSTERM_ORIG_ZDOTDIR/.zshenv\" ]] && \
         source \"$VSTERM_ORIG_ZDOTDIR/.zshenv\"\n";
    let zshrc = format!(
        "[[ -f \"$VSTERM_ORIG_ZDOTDIR/.zshrc\" ]] && \
         source \"$VSTERM_ORIG_ZDOTDIR/.zshrc\"\n\
         ZDOTDIR=\"$VSTERM_ORIG_ZDOTDIR\"\n\
         source {:?}\n",
        integ.to_string_lossy()
    );
    if std::fs::write(dir.join(".zshenv"), zshenv).is_err()
        || std::fs::write(dir.join(".zshrc"), zshrc).is_err()
    {
        return;
    }

    cmd.env("VSTERM_ORIG_ZDOTDIR", orig);
    cmd.env("ZDOTDIR", dir.to_string_lossy().to_string());
}

#[tauri::command]
pub fn spawn_terminal(
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    shell: Option<String>,
    pane_id: Option<String>,
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

    let shell = shell.unwrap_or_else(default_shell);
    let mut cmd = CommandBuilder::new(shell.clone());
    if let Some(cwd) = cwd {
        cmd.cwd(cwd);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // AI 명령 인터페이스 컨텍스트(tmux 의 $TMUX_PANE 모델): 셸 안의 도구가 자기 pane 과
    // 제어 소켓을 알 수 있게 주입 — sok CLI 가 이걸로 "내 위치" 기본 타기팅을 한다.
    if let Some(pane) = &pane_id {
        cmd.env("SOKSAK_PANE", pane);
    }
    if let Some(sock) = crate::ipc::socket_path() {
        cmd.env("SOKSAK_SOCKET", sock);
    }
    setup_zsh_integration(&mut cmd, &shell);

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

// 사용자 로그인 셸 PATH 기준 바이너리 존재 확인 — GUI 앱의 좁은 PATH 로는
// 사용자가 쓰는 CLI 를 못 찾는다(설치 판정의 단일 기준 = 사용자 셸).
// 플러그인 프로그램 ensure(§2.6)가 활성화 시점에 호출한다.
#[tauri::command]
pub fn shell_which(bin: String) -> bool {
    // 셸 한 줄에 끼워 넣으므로 바이너리 이름 문자만 허용(주입 차단).
    if bin.is_empty()
        || !bin
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return false;
    }
    let shell = default_shell();
    if cfg!(windows) {
        std::process::Command::new(&shell)
            .args(["-Command", &format!("Get-Command {bin}")])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    } else {
        // -l: 로그인 셸 — 사용자의 rc/profile 이 구성한 PATH 그대로.
        std::process::Command::new(&shell)
            .args(["-lc", &format!("command -v {bin}")])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}
