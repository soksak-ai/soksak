// PTY 세션 관리 — daemon-first 라우터 + ACK 플로우 컨트롤.
//
// 세션 백엔드는 둘이다(app.pty 시그니처·명령명은 불변 — R7 seam):
//   Daemon  soksak-ptyd(코어 workspace 독립 바이너리)가 셸을 소유한다. 앱 종료·
//           재시작에도 셸과 자식이 같은 pid 로 생존하고, 같은 pane 재스폰은
//           createOrAttach 로 재부착되어 detach 동안의 출력(링)을 재생받는다.
//           플로우 컨트롤 워터마크는 데몬 쪽이 소유한다(ack 을 릴레이).
//   Local   기존 in-process 코드 그대로 — 데몬 확보 실패 시의 폴백 실체다.
//           폴백 진입은 activity 로 고지한다(무음 금지).
//
// 죽음 감지는 소켓 에러 이벤트다(폴링 0): 데몬이 죽으면 세션 stream 이 EOF/에러로
// 끊기고, control ping 한 번으로 "셸 정상 종료"와 "데몬 사망"을 가른 뒤 재스폰을
// 시도하고 고지한다.
//
// 플로우 컨트롤 워터마크는 soksak-pty-proto 가 단일진실이다(두 백엔드 공용):
//   - 미확인(unacked) 바이트가 HIGH 이상이면 reader 일시정지
//   - 프론트가 보낸 ack 로 unacked 가 LOW 이하로 떨어지면 재개
// 프론트는 xterm.write 콜백(파싱 완료)에서 5k 바이트마다 ack 를 보낸다.
// 값의 근거(윈도우=ack 루프 RTT 커버)는 proto 상수의 주석에 있다.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use soksak_pty_proto::{HIGH_WATERMARK, LOW_WATERMARK};

struct FlowState {
    unacked: usize,
    paused: bool,
}

// in-process 백엔드(로컬 폴백 실체) — 데몬 이전의 원 구현 그대로.
struct LocalSession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    flow: Arc<(Mutex<FlowState>, Condvar)>,
}

enum Backend {
    Local(LocalSession),
    #[cfg(unix)]
    Daemon {
        // soksak-ptyd 세션 id — write/resize/ack/kill 은 control 소켓으로 릴레이된다.
        session: u64,
    },
}

pub struct PtySession {
    backend: Backend,
    // [R2] 관찰 substrate 타깃 키 — pty_pane_pid 가 이 키로 master 의 foreground pgid 를 찾는다.
    pane_id: Option<String>,
    // 창 폐기 reap 키(kill_by_window) — 사용자의 개별 창 닫기(B1 폐기 의미론)가 그 창의
    // 세션만 거둬 데몬에 유령 셸이 남지 않게 한다.
    window_label: Option<String>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<u32, PtySession>>,
    next_id: Mutex<u32>,
    #[cfg(unix)]
    link: daemon::Link,
}

// spawn_terminal 결과. screen_restored = 이 스폰이 PTY 세션의 화면을 복원했는가
// (데몬 재부착 replay | cold 체크포인트 inject). 참이면 그 화면이 뷰포트 권위이므로
// 플러그인의 명령-블록 repaint(floor)가 그 위로 이력을 쌓아 복원 프레임을 밀어내면
// 안 된다 — 프론트 substrate 가 이 값을 pane 별로 보관해 app.pty.wasScreenRestored 로 노출한다.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOutcome {
    pub id: u32,
    pub screen_restored: bool,
}

impl PtyManager {
    // 앱 종료 시 호출(B1: 종료=보존): Daemon 세션은 detach 만 한다 — 셸과 자식은
    // soksak-ptyd 에서 계속 살고, 다음 부팅의 같은 pane 스폰이 재부착한다. Local
    // 세션(폴백)은 앱 프로세스가 소유하므로 kill 해 좀비를 막는다. Procfile 데몬·
    // process kill_all 은 이 함수 밖(불변 — 창 결속 계약).
    pub fn kill_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, session) in sessions.drain() {
                match session.backend {
                    Backend::Local(mut s) => {
                        let (lock, cvar) = &*s.flow;
                        if let Ok(mut st) = lock.lock() {
                            st.paused = false;
                            cvar.notify_all();
                        }
                        let _ = s.child.kill();
                    }
                    #[cfg(unix)]
                    Backend::Daemon { session } => {
                        // 명시 detach(예의) — 앱 소켓이 곧 닫히므로 데몬은 어차피 EOF 로
                        // 부착을 해제한다. 실패해도 생존에는 영향 없다.
                        let _ = self.link.request(
                            &soksak_pty_proto::Request::Detach { session },
                            false,
                        );
                    }
                }
            }
        }
    }

    // 사용자의 개별 창 닫기(폐기) — 그 창이 소유한 세션만 거둔다. 데몬 셸을 여기서
    // 죽이지 않으면 창은 사라졌는데 셸만 데몬에 남는 유령이 된다.
    pub fn kill_by_window(&self, label: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            let victims: Vec<u32> = sessions
                .iter()
                .filter(|(_, s)| s.window_label.as_deref() == Some(label))
                .map(|(id, _)| *id)
                .collect();
            for id in victims {
                if let Some(session) = sessions.remove(&id) {
                    match session.backend {
                        Backend::Local(mut s) => {
                            let (lock, cvar) = &*s.flow;
                            if let Ok(mut st) = lock.lock() {
                                st.paused = false;
                                cvar.notify_all();
                            }
                            let _ = s.child.kill();
                        }
                        #[cfg(unix)]
                        Backend::Daemon { .. } => {} // 아래 KillByWindow 일괄이 처리
                    }
                }
            }
        }
        // 데몬 쪽은 라벨로 일괄 reap — 이 앱이 부착하지 않았던(예: 이전 실행이 남긴)
        // 세션까지 같은 키로 거둔다.
        #[cfg(unix)]
        {
            let _ = self.link.request(
                &soksak_pty_proto::Request::KillByWindow { window_label: label.to_string() },
                false,
            );
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
// 실패해도 통합만 빠질 뿐 셸은 정상 동작하므로 빈 목록을 돌려준다(에러 비전파).
// env 쌍을 돌려주는 순수한 형태 — Local(CommandBuilder)과 Daemon(env 목록 전송)이
// 같은 소스를 쓴다(단일 진실).
fn zsh_integration_env(shell: &str) -> Vec<(String, String)> {
    let is_zsh = std::path::Path::new(shell)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n == "zsh")
        .unwrap_or(false);
    if !is_zsh {
        return Vec::new();
    }

    let dir = std::env::temp_dir().join("vsterm-zdotdir");
    if std::fs::create_dir_all(&dir).is_err() {
        return Vec::new();
    }
    let integ = dir.join("shell-integration.zsh");
    if std::fs::write(&integ, ZSH_INTEGRATION).is_err() {
        return Vec::new();
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
        return Vec::new();
    }

    vec![
        ("VSTERM_ORIG_ZDOTDIR".to_string(), orig),
        ("ZDOTDIR".to_string(), dir.to_string_lossy().to_string()),
    ]
}

// 세션 env 조립 — 두 백엔드의 단일 소스. 터미널은 신선한 셸 컨텍스트여야 한다:
// soksak 을 claude(Claude Code) 세션 안에서 띄우면 claude 가 주입한 세션 env 가
// PTY 로 새어 터미널의 claude 가 자기를 중첩 자식 세션으로 오인한다 — AI 세션
// 컨텍스트 env 를 제거해 항상 최상위 세션으로 시작하게 한다(목록 정본은
// process.rs AI_SESSION_ENV). SOKSAK_* 주입은 AI 명령 인터페이스 컨텍스트
// (tmux $TMUX_PANE 모델)다.
fn build_session_env(
    shell: &str,
    pane_id: &Option<String>,
    window_label: &Option<String>,
) -> (Vec<(String, String)>, Vec<String>) {
    let mut env: Vec<(String, String)> = vec![
        ("TERM".into(), "xterm-256color".into()),
        ("COLORTERM".into(), "truecolor".into()),
    ];
    if let Some(pane) = pane_id {
        env.push(("SOKSAK_PANE".into(), pane.clone()));
    }
    // 멀티윈도우: 내 창 label 주입(PANE 과 대칭) — 빈 문자열은 미주입.
    if let Some(w) = window_label.as_deref().filter(|w| !w.is_empty()) {
        env.push(("SOKSAK_WINDOW".into(), w.to_string()));
    }
    if let Some(sock) = crate::ipc::socket_path() {
        env.push(("SOKSAK_SOCKET".into(), sock.to_string()));
    }
    env.extend(zsh_integration_env(shell));
    let env_remove: Vec<String> =
        crate::process::AI_SESSION_ENV.iter().map(|k| k.to_string()).collect();
    (env, env_remove)
}

// 세션 등록 단일 진실 — id 발급 + 세션 맵 삽입. 데몬/로컬 백엔드가 같은 경로를 쓴다.
// lock 오염은 패닉 전파 대신 복구한다: 한 세션 스레드의 패닉이 매니저를 영구
// 잠그지 않게(카운터·맵은 오염돼도 유효한 값이다).
fn register_session(manager: &PtyManager, session: PtySession) -> u32 {
    let id = {
        let mut n = manager.next_id.lock().unwrap_or_else(|e| e.into_inner());
        *n += 1;
        *n
    };
    manager
        .sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id, session);
    id
}

#[tauri::command]
pub fn spawn_terminal(
    app: tauri::AppHandle,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    shell: Option<String>,
    pane_id: Option<String>,
    window_label: Option<String>,
    on_output: Channel<InvokeResponseBody>,
    manager: State<'_, PtyManager>,
) -> Result<SpawnOutcome, String> {
    let shell = shell.unwrap_or_else(default_shell);
    let (env, env_remove) = build_session_env(&shell, &pane_id, &window_label);

    // daemon-first: soksak-ptyd 가 셸을 소유하면 앱 재시작을 넘어 생존한다. 확보
    // 실패는 로컬 폴백으로 계속하되 activity 로 고지한다(무음 금지). pane 없는
    // 세션은 재부착 키가 없으므로 조용히 로컬이다(폴백 아님 — 고지 없음).
    #[cfg(unix)]
    if pane_id.is_some() {
        match daemon::spawn_via_daemon(
            &app,
            &manager.link,
            daemon::SpawnParams {
                pane_id: pane_id.clone(),
                window_label: window_label.clone(),
                cols,
                rows,
                cwd: cwd.clone(),
                shell: shell.clone(),
                env: env.clone(),
                env_remove: env_remove.clone(),
            },
            on_output.clone(),
        ) {
            Ok((session, screen_restored)) => {
                let id = register_session(
                    manager.inner(),
                    PtySession {
                        backend: Backend::Daemon { session },
                        pane_id,
                        window_label,
                    },
                );
                return Ok(SpawnOutcome { id, screen_restored });
            }
            Err(e) => daemon::notify_fallback(&app, &manager.link, &e),
        }
    }
    #[cfg(not(unix))]
    let _ = &app;

    // ── 로컬 폴백(in-process) — 원 구현 그대로 ─────────────────────────────
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(shell.clone());
    for k in &env_remove {
        cmd.env_remove(k);
    }
    for (k, v) in &env {
        cmd.env(k, v);
    }
    if let Some(cwd) = cwd {
        cmd.cwd(cwd);
    }

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

    let id = register_session(
        manager.inner(),
        PtySession {
            backend: Backend::Local(LocalSession {
                writer,
                master: pair.master,
                child,
                flow,
            }),
            pane_id,
            window_label,
        },
    );
    // 로컬 폴백(in-process) 은 신선 셸이다 — 복원한 화면이 없다.
    Ok(SpawnOutcome { id, screen_restored: false })
}

// [R2] pane 의 foreground 프로세스 그룹 pid — 그 PTY 에서 지금 실행 중인 명령(claude/codex 등)의 pgid.
// command.started 직후 호출하면 막 시작한 명령의 pid 다(best-effort — exec 직전 레이스면 셸 pgid/None).
// AI 세션 추적의 sessionId 와 짝(command/pid/sessionId). 없으면 null.
#[tauri::command]
pub fn pty_pane_pid(pane_id: String, manager: State<'_, PtyManager>) -> Option<i32> {
    // 락을 쥔 채 데몬 요청을 보내지 않는다 — 백엔드 종류만 판별하고 락을 놓는다.
    let daemon_backed = {
        let sessions = manager.sessions.lock().ok()?;
        let mut daemon_backed = false;
        for s in sessions.values() {
            if s.pane_id.as_deref() == Some(pane_id.as_str()) {
                match &s.backend {
                    Backend::Local(l) => return l.master.process_group_leader(),
                    #[cfg(unix)]
                    Backend::Daemon { .. } => {
                        daemon_backed = true;
                        break;
                    }
                }
            }
        }
        daemon_backed
    };
    #[cfg(unix)]
    if daemon_backed {
        let v = manager
            .link
            .request(&soksak_pty_proto::Request::PanePid { pane_id }, false)
            .ok()?;
        return v.get("pid").and_then(|p| p.as_i64()).map(|p| p as i32);
    }
    #[cfg(not(unix))]
    let _ = daemon_backed;
    None
}

#[tauri::command]
pub fn write_terminal(
    id: u32,
    data: String,
    manager: State<'_, PtyManager>,
) -> Result<(), String> {
    let mut sessions = manager.sessions.lock().unwrap();
    let session = sessions.get_mut(&id).ok_or("no such terminal")?;
    match &mut session.backend {
        Backend::Local(s) => {
            s.writer
                .write_all(data.as_bytes())
                .map_err(|e| e.to_string())?;
            s.writer.flush().map_err(|e| e.to_string())?;
            Ok(())
        }
        #[cfg(unix)]
        Backend::Daemon { session } => {
            use base64::Engine as _;
            let req = soksak_pty_proto::Request::Write {
                session: *session,
                data_b64: base64::engine::general_purpose::STANDARD.encode(data.as_bytes()),
            };
            drop(sessions);
            manager.link.request(&req, false).map(|_| ())
        }
    }
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
    match &session.backend {
        Backend::Local(s) => s
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string()),
        #[cfg(unix)]
        Backend::Daemon { session } => {
            let req = soksak_pty_proto::Request::Resize { session: *session, cols, rows };
            drop(sessions);
            manager.link.request(&req, false).map(|_| ())
        }
    }
}

#[tauri::command]
pub fn ack_terminal(id: u32, bytes: usize, manager: State<'_, PtyManager>) -> Result<(), String> {
    let sessions = manager.sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or("no such terminal")?;
    match &session.backend {
        Backend::Local(s) => {
            let (lock, cvar) = &*s.flow;
            let mut st = lock.lock().unwrap();
            st.unacked = st.unacked.saturating_sub(bytes);
            if st.paused && st.unacked <= LOW_WATERMARK {
                st.paused = false;
                cvar.notify_all();
            }
            Ok(())
        }
        #[cfg(unix)]
        Backend::Daemon { session } => {
            let req = soksak_pty_proto::Request::Ack { session: *session, bytes: bytes as u64 };
            drop(sessions);
            manager.link.request(&req, false).map(|_| ())
        }
    }
}

#[tauri::command]
pub fn close_terminal(id: u32, manager: State<'_, PtyManager>) -> Result<(), String> {
    if let Some(session) = manager.sessions.lock().unwrap().remove(&id) {
        match session.backend {
            Backend::Local(mut s) => {
                // 일시정지된 reader 를 깨워 EOF 를 받고 종료하도록 한다.
                {
                    let (lock, cvar) = &*s.flow;
                    let mut st = lock.lock().unwrap();
                    st.paused = false;
                    cvar.notify_all();
                }
                let _ = s.child.kill();
                // session 드롭 → writer/master 닫힘 → reader EOF.
            }
            #[cfg(unix)]
            Backend::Daemon { session } => {
                // pane 닫기 = 폐기(B1) — 데몬 셸을 죽인다. 링크가 죽어 있으면 best-effort
                // (데몬도 함께 죽었다면 세션도 없다).
                let _ = manager
                    .link
                    .request(&soksak_pty_proto::Request::Kill { session }, false);
            }
        }
    }
    Ok(())
}

// ── PTY 세션 데몬 관측·재기동 — command registry(pty.daemon.*)의 실행기 ────────
// 관측(status)은 데몬을 새로 띄우지 않는다(spawn_if_needed=false — 조회가 데몬을
// 부풀리지 않는다). 재기동(restart)은 파괴적이다: 데몬 소유 셸과 그 자식 전부가
// 죽는다 — 카탈로그의 danger 게이트 뒤에만 노출된다.

#[tauri::command]
pub fn pty_daemon_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(unix)]
    {
        use serde_json::json;
        let manager = tauri::Manager::state::<PtyManager>(&app);
        let home = crate::home::soksak_home();
        let staged = soksak_pty_proto::staged_bin_path(&home);
        let (running, pid, sessions) =
            match manager.link.request(&soksak_pty_proto::Request::Ping, false) {
                Ok(v) => (true, v["pid"].as_u64(), v["sessions"].as_u64()),
                Err(_) => (false, None, None),
            };
        Ok(json!({
            "running": running,
            "pid": pid,
            "sessions": sessions,
            "protocol": soksak_pty_proto::PTYD_PROTOCOL_VERSION,
            "staged": staged.exists(),
            "stagedPath": staged.to_string_lossy(),
        }))
    }
    #[cfg(not(unix))]
    {
        let _ = app;
        Ok(serde_json::json!({
            "running": false,
            "supported": false,
            "protocol": soksak_pty_proto::PTYD_PROTOCOL_VERSION,
        }))
    }
}

#[tauri::command]
pub fn pty_daemon_restart(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(unix)]
    {
        use serde_json::json;
        let manager = tauri::Manager::state::<PtyManager>(&app);
        // 살아 있으면 종료(전 세션 kill — 파괴적임을 카탈로그가 게이트한다).
        let killed = manager
            .link
            .request(&soksak_pty_proto::Request::Shutdown, false)
            .ok()
            .and_then(|v| v["killed"].as_u64())
            .unwrap_or(0);
        // 옛 데몬의 종료 유예(응답 후 150ms)를 넘겨 싱글턴 프로브 오인을 피한다 —
        // 재기동 1회 한정의 유한 대기(상시 감시 아님).
        std::thread::sleep(std::time::Duration::from_millis(400));
        let v = manager.link.request(&soksak_pty_proto::Request::Ping, true)?;
        Ok(json!({ "killed": killed, "pid": v["pid"] }))
    }
    #[cfg(not(unix))]
    {
        let _ = app;
        Err("the PTY daemon is unix-only in this generation".to_string())
    }
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

// ── soksak-ptyd 클라이언트(전송) — 계약은 soksak-pty-proto 가 정본 ────────────
#[cfg(unix)]
mod daemon {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::net::UnixStream;
    use std::os::unix::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    use serde_json::{json, Value};
    use soksak_pty_proto as proto;
    use tauri::ipc::{Channel, InvokeResponseBody};

    // control 연결 1본(요청-응답 직렬) — 명령 빈도가 낮아(입력·리사이즈·ack) 충분하다.
    struct Control {
        reader: BufReader<UnixStream>,
        writer: UnixStream,
    }

    impl Control {
        fn request(&mut self, req: &proto::Request) -> Result<Value, LinkError> {
            let line = serde_json::to_string(req).map_err(|e| LinkError::Io(e.to_string()))?;
            writeln!(self.writer, "{line}").map_err(|e| LinkError::Io(e.to_string()))?;
            let mut reply = String::new();
            self.reader
                .read_line(&mut reply)
                .map_err(|e| LinkError::Io(e.to_string()))?;
            if reply.trim().is_empty() {
                return Err(LinkError::Io("daemon closed the control socket".into()));
            }
            let v: Value =
                serde_json::from_str(reply.trim()).map_err(|e| LinkError::Io(e.to_string()))?;
            if v["ok"] == true {
                Ok(v.get("data").cloned().unwrap_or(Value::Null))
            } else {
                Err(LinkError::Remote {
                    code: v["code"].as_str().unwrap_or("ERROR").to_string(),
                    message: v["message"].as_str().unwrap_or_default().to_string(),
                })
            }
        }
    }

    enum LinkError {
        // 소켓/프레이밍 — 링크 자체가 죽었다(재연결 대상).
        Io(String),
        // 데몬의 논리 거절(NOT_FOUND 등) — 링크는 산다.
        Remote { code: String, message: String },
    }

    impl std::fmt::Display for LinkError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                LinkError::Io(e) => write!(f, "link: {e}"),
                LinkError::Remote { code, message } => write!(f, "{code}: {message}"),
            }
        }
    }

    #[derive(Default)]
    pub struct Link {
        control: Mutex<Option<Control>>,
        // 폴백 고지 1회 게이트(스폰 폭주 시 도배 방지) — 데몬 스폰 성공이 리셋한다.
        fallback_notified: AtomicBool,
        // 데몬 사망 고지 1회 게이트 — 재확보 성공이 리셋한다.
        lost_notified: AtomicBool,
    }

    impl Link {
        // 요청 실행. spawn_if_needed=true 면 미연결 시 스테이징+데몬 스폰까지 시도한다
        // (false 면 살아있는 데몬에 연결만 — pane pid 조회 같은 관찰 경로가 데몬을
        // 부풀리지 않게). Io 에러는 링크를 버리고 1회 재확보 후 재시도한다 — 이
        // "소켓 에러 → 재확보" 가 죽음 감지다(폴링 0).
        pub fn request(
            &self,
            req: &proto::Request,
            spawn_if_needed: bool,
        ) -> Result<Value, String> {
            let home = crate::home::soksak_home();
            let mut guard = self.control.lock().unwrap_or_else(|e| e.into_inner());
            if guard.is_none() {
                *guard = Some(if spawn_if_needed {
                    ensure_daemon(&home).map_err(|e| e.to_string())?
                } else {
                    connect(&home).map_err(|e| e.to_string())?
                });
            }
            let conn = match guard.as_mut() {
                Some(c) => c,
                // 바로 위에서 Some 을 넣었으므로 도달 불가 — 패닉 대신 명시 에러.
                None => return Err("pty link: control missing after connect".to_string()),
            };
            match conn.request(req) {
                Ok(v) => Ok(v),
                Err(LinkError::Remote { code, message }) => Err(format!("{code}: {message}")),
                Err(LinkError::Io(_)) => {
                    // 링크 사망 — 재확보 1회 후 재시도. 실패는 호출자에게(폴백 판단).
                    *guard = None;
                    let mut fresh = if spawn_if_needed {
                        ensure_daemon(&home).map_err(|e| e.to_string())?
                    } else {
                        connect(&home).map_err(|e| e.to_string())?
                    };
                    let out = fresh.request(req).map_err(|e| e.to_string());
                    *guard = Some(fresh);
                    out
                }
            }
        }
    }

    pub struct SpawnParams {
        pub pane_id: Option<String>,
        pub window_label: Option<String>,
        pub cols: u16,
        pub rows: u16,
        pub cwd: Option<String>,
        pub shell: String,
        pub env: Vec<(String, String)>,
        pub env_remove: Vec<String>,
    }

    // ── 봉인 체크포인트 수신 키(restore 사다리 3단, docs/RESTORE.md) ─────────
    // 봉인은 공개키만 필요하다 — P 는 평문 캐시(<home>/pty/checkpoint.pub, 공개값),
    // S 는 vault 에만(put_data_key). 캐시가 없고 vault 도 잠겨 있으면 None — 데몬은
    // 체크포인트를 쓰지 않는다(fail closed: 화면 바이트 평문 저장 경로는 존재하지 않는다).
    // 동시 스폰 경쟁은 (a) 프로세스 내 뮤텍스 직렬화 (b) keyId 에 랜덤을 넣고 rename
    // 승자의 파일을 재독해 채택 — S/P 짝이 항상 파일이 가리키는 쌍으로 정렬된다.
    static CKPT_KEY_GATE: Mutex<()> = Mutex::new(());

    pub fn checkpoint_recipient(app: &tauri::AppHandle) -> (Option<String>, Option<String>) {
        let home = crate::home::soksak_home();
        let path = proto::checkpoint_pubkey_path(&home);
        let read = |p: &Path| -> Option<(String, String)> {
            let v: Value = serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()?;
            Some((v["publicKey"].as_str()?.to_string(), v["keyId"].as_str()?.to_string()))
        };
        let _gate = CKPT_KEY_GATE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((pk, key_id)) = read(&path) {
            return (Some(pk), Some(key_id));
        }
        let secrets = tauri::Manager::state::<crate::secrets::SecretsState>(app);
        if !secrets.is_unlocked() {
            return (None, None); // 잠김 + 캐시 없음 — 이번 세션은 체크포인트 없이
        }
        let (s, p) = crate::secrets::gen_asym_keypair();
        let key_id = format!("ptyk-{}", uuid::Uuid::new_v4());
        if let Err(e) = secrets.put_data_key(&key_id, &s) {
            eprintln!("[pty] checkpoint key store failed: {e}");
            return (None, None);
        }
        let pk_b64 = {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD.encode(p)
        };
        let doc = json!({ "keyId": key_id, "publicKey": pk_b64 });
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
            let tmp = dir.join(format!(".ckpt-pub-{}", std::process::id()));
            if std::fs::write(&tmp, doc.to_string()).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            }
        }
        // rename 승자의 쌍을 채택(교차 프로세스 경쟁 정렬) — 내 쌍이 졌으면 파일 쌍으로.
        match read(&path) {
            Some((pk, key_id)) => (Some(pk), Some(key_id)),
            None => (Some(pk_b64), Some(key_id)),
        }
    }

    // 데몬 경유 스폰: createOrAttach → stream 부착 → reader 스레드(재생+라이브 →
    // Channel). 반환 = 데몬 세션 id. 재부착이면 데몬 미러의 직렬화 시퀀스(화면 상태
    // 재현)가 라이브에 앞서 도착한다 — 전부 그리드 합성물이라 재생분에 질의(DA1/DSR)가
    // 실릴 수 없고, 프론트 xterm 의 재응답도 원천 차단된다(플랜 §5.5 M2 —
    // docs/RESTORE.md 사다리 2단).
    // 반환 = (데몬 세션 id, screen_restored). screen_restored 는 이 스폰이 화면을 복원했는가
    // = 데몬 재부착(attached, 미러 replay) 또는 cold 체크포인트 inject 성공(injected).
    pub fn spawn_via_daemon(
        app: &tauri::AppHandle,
        link: &Link,
        p: SpawnParams,
        on_output: Channel<InvokeResponseBody>,
    ) -> Result<(u64, bool), String> {
        // pane 없는 세션은 재부착 키가 없다 — 데몬에 실을 이유가 없어 로컬로 보낸다.
        let pane_id = p.pane_id.clone().ok_or("no pane id: local session")?;
        let home = crate::home::soksak_home();
        let window = p.window_label.clone().unwrap_or_default();
        // cold 후보는 createOrAttach 전에 읽는다 — 파일이 남아 있다는 것 자체가 데몬
        // 사망의 유산이고(정상 종료는 삭제한다), 새 세션의 첫 체크포인트가 같은 자리를
        // 덮어쓰기 전의 안정 창이다.
        let cold = read_checkpoint(&home, &window, &pane_id);
        let (checkpoint_pk, checkpoint_key_id) = checkpoint_recipient(app);
        let data = link.request(
            &proto::Request::CreateOrAttach {
                pane_id: pane_id.clone(),
                cols: p.cols,
                rows: p.rows,
                cwd: p.cwd,
                shell: p.shell,
                env: p.env,
                env_remove: p.env_remove,
                window_label: p.window_label,
                checkpoint_pk,
                checkpoint_key_id,
            },
            true,
        )?;
        let session = data["session"].as_u64().ok_or("daemon reply missing session id")?;
        let attached = data["attached"] == true;

        // cold byte restore(복원 사다리 3단, docs/RESTORE.md): 데몬이 죽어 재부착이
        // 불가능했고(attached=false) 봉인 체크포인트가 남아 있으면, unlock 된 vault 의
        // 개인키로 열어 화면 기록을 다시 그리고 live 자식 소실을 명시 고지한다(무음 금지).
        // 잠금이면 파일을 남기고 blocks repaint 폴백에 맡긴다 — 평문 우회 경로는 없다.
        let mut injected = false;
        if !attached {
            if let Some(ck) = cold {
                match open_cold_checkpoint(app, &ck, &window, &pane_id) {
                    Ok(paint) => {
                        let lang = crate::i18n::app_language(app);
                        let notice = format!(
                            "\x1b[2m{}\x1b[0m\r\n",
                            crate::i18n::cold_restore_notice(lang)
                        );
                        let mut bytes = paint;
                        bytes.extend_from_slice(notice.as_bytes());
                        let mut sent = true;
                        for chunk in bytes.chunks(256 * 1024) {
                            if on_output.send(InvokeResponseBody::Raw(chunk.to_vec())).is_err() {
                                sent = false;
                                break;
                            }
                        }
                        if sent {
                            let _ = std::fs::remove_file(&ck.path);
                            injected = true;
                            crate::activity::publish(
                                app,
                                "pty.cold.restored",
                                "core",
                                json!({
                                    "window": window,
                                    "pane": pane_id,
                                    "altActive": ck.alt_active,
                                }),
                            );
                        }
                    }
                    Err(reason) => {
                        crate::activity::publish(
                            app,
                            "pty.cold.blocked",
                            "core",
                            json!({
                                "window": window,
                                "pane": pane_id,
                                "reason": reason,
                                "note": "a sealed checkpoint exists but cannot be opened; blocks repaint is the floor",
                            }),
                        );
                    }
                }
            }
        }

        let (mut stream, replay_len) = attach_stream(&home, session)?;
        if injected {
            // 주입된 cold 페인트 위에 신선 세션의 절대주소(CUP) repaint 를 겹치면 화면이
            // 어긋난다 — 신선 세션의 재생(프롬프트 한 줄 상당)은 버리고, 개행 하나로
            // 새 프롬프트를 고지 아래에 다시 그리게 한다.
            discard_exact(&mut stream, replay_len)?;
            use base64::Engine as _;
            let _ = link.request(
                &proto::Request::Write {
                    session,
                    data_b64: base64::engine::general_purpose::STANDARD.encode("\n"),
                },
                false,
            );
        }

        // 세션 stream reader — 소켓 EOF/에러가 곧 이벤트다: 셸 종료(데몬이 닫음)거나
        // 데몬 사망. control ping 한 번으로 갈라 후자만 고지+재확보한다.
        {
            let app = app.clone();
            std::thread::spawn(move || {
                let mut buf = vec![0u8; 8192];
                loop {
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if on_output
                                .send(InvokeResponseBody::Raw(buf[..n].to_vec()))
                                .is_err()
                            {
                                break; // 프론트 사라짐(창 리로드 등) — 데몬은 계속 산다
                            }
                        }
                    }
                }
                on_stream_end(&app);
            });
        }

        // 데몬 경로 성공 — 이후 폴백이 다시 일어나면 새 사건으로 고지한다.
        link.fallback_notified.store(false, Ordering::SeqCst);
        // 화면 복원 여부: 재부착 replay(attached) 또는 cold inject(injected). 둘 다면 화면이
        // 이미 PTY 로 채워졌으니 플러그인 blocks-repaint 는 floor 로 겹쳐선 안 된다.
        Ok((session, attached || injected))
    }

    // stream 종료의 원인 판별: control ping 이 살아 있으면 셸의 정상 종료다(프론트는
    // Channel 종료로 이미 안다). ping 까지 죽었으면 데몬 사망 — 고지하고 재확보를
    // 시도한다(성공 시 다음 스폰부터 데몬 경로 복귀. 죽은 데몬의 세션은 소실 —
    // 골격의 한계로 고지에 싣는다).
    fn on_stream_end(app: &tauri::AppHandle) {
        let manager = tauri::Manager::state::<crate::pty::PtyManager>(app);
        let link = &manager.link;
        if link.request(&proto::Request::Ping, false).is_ok() {
            return; // 셸 정상 종료
        }
        let home = crate::home::soksak_home();
        let respawned = ensure_daemon(&home).is_ok();
        if respawned {
            link.lost_notified.store(false, Ordering::SeqCst);
        }
        if !link.lost_notified.swap(true, Ordering::SeqCst) || respawned {
            crate::activity::publish(
                app,
                "pty.daemon.lost",
                "core",
                json!({
                    "respawned": respawned,
                    "note": "live daemon sessions are lost; new terminals reattach to the respawned daemon",
                }),
            );
        }
    }

    // 폴백 고지(무음 금지) — 스폰 폭주 도배 방지로 1회 게이트.
    pub fn notify_fallback(app: &tauri::AppHandle, link: &Link, error: &str) {
        if link.fallback_notified.swap(true, Ordering::SeqCst) {
            return;
        }
        eprintln!("[pty] daemon unavailable, in-process fallback: {error}");
        crate::activity::publish(
            app,
            "pty.daemon.fallback",
            "core",
            json!({
                "error": error,
                "note": "terminals run in-process and will not survive an app restart",
            }),
        );
    }

    // ── 확보: 연결 → (실패 시) 스테이징 + 스폰 + 재연결 ─────────────────────

    fn connect(home: &Path) -> Result<Control, LinkError> {
        let token = std::fs::read_to_string(proto::token_path(home))
            .map_err(|e| LinkError::Io(format!("token: {e}")))?
            .trim()
            .to_string();
        let conn = UnixStream::connect(proto::control_socket_path(home))
            .map_err(|e| LinkError::Io(format!("connect: {e}")))?;
        let reader = BufReader::new(
            conn.try_clone().map_err(|e| LinkError::Io(e.to_string()))?,
        );
        let mut c = Control { reader, writer: conn };
        let hello = proto::Hello {
            version: Some(proto::PTYD_PROTOCOL_VERSION),
            token,
            client_id: format!("app-{}", std::process::id()),
            session: None,
        };
        let line = serde_json::to_string(&hello).map_err(|e| LinkError::Io(e.to_string()))?;
        writeln!(c.writer, "{line}").map_err(|e| LinkError::Io(e.to_string()))?;
        let mut reply = String::new();
        c.reader
            .read_line(&mut reply)
            .map_err(|e| LinkError::Io(e.to_string()))?;
        let v: Value =
            serde_json::from_str(reply.trim()).map_err(|e| LinkError::Io(e.to_string()))?;
        if v["ok"] != true {
            return Err(LinkError::Remote {
                code: v["code"].as_str().unwrap_or("ERROR").to_string(),
                message: v["message"].as_str().unwrap_or_default().to_string(),
            });
        }
        Ok(c)
    }

    fn ensure_daemon(home: &Path) -> Result<Control, LinkError> {
        if let Ok(c) = connect(home) {
            return Ok(c);
        }
        let staged = stage_binary(home).map_err(LinkError::Io)?;
        // run/ 은 데몬도 부트에 만들지만, 로그 파일은 스폰 전에 앱이 먼저 연다 — 앱이 보장한다.
        std::fs::create_dir_all(proto::run_dir(home))
            .map_err(|e| LinkError::Io(format!("run dir: {e}")))?;
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(proto::log_path(home))
            .map_err(|e| LinkError::Io(format!("log: {e}")))?;
        let log2 = log.try_clone().map_err(|e| LinkError::Io(e.to_string()))?;
        let mut cmd = std::process::Command::new(&staged);
        cmd.env("SOKSAK_HOME", home)
            .stdin(std::process::Stdio::null())
            .stdout(log)
            .stderr(log2);
        // detach: 새 세션 리더로 — 앱이 죽어도 데몬과 그 셸들이 살아남는다.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        cmd.spawn().map_err(|e| LinkError::Io(format!("spawn ptyd: {e}")))?;
        // 부트스트랩 핸드셰이크 대기 한정의 유한 재시도(성공/2s 상한 종료) — 상시
        // 감시가 아니다(감시는 소켓 에러 이벤트가 담당).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            match connect(home) {
                Ok(c) => return Ok(c),
                Err(e) => {
                    if std::time::Instant::now() >= deadline {
                        return Err(e);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            }
        }
    }

    // 홈 bin/ 설치 계약: 데몬 실행물은 앱 번들 밖 identity 홈 bin/ 에 프로토콜-키
    // 이름으로 놓인다 — 번들은 업데이터의 원자 교체 단위라 번들 내 장수 프로세스는
    // 세션 수명을 번들 수명에 강결합시킨다(R7). 배치는 staging → rename 원자
    // (실행 중 mach-o in-place 덮어쓰기는 서명 무효화로 SIGKILL — stage.sh 선례).
    fn stage_binary(home: &Path) -> Result<PathBuf, String> {
        let staged = proto::staged_bin_path(home);
        let source = resolve_source_binary();
        let Some(source) = source else {
            if staged.exists() {
                return Ok(staged); // 소스 부재 — 이전에 스테이징된 판으로 계속
            }
            return Err(
                "ptyd binary not found (SOKSAK_PTYD_BIN or a soksak-ptyd next to the app binary)"
                    .into(),
            );
        };
        if staged.exists() && same_content(&source, &staged) {
            return Ok(staged);
        }
        let bin_dir = staged.parent().ok_or("staged path has no parent")?;
        std::fs::create_dir_all(bin_dir).map_err(|e| e.to_string())?;
        let tmp = bin_dir.join(format!(".ptyd-staging-{}", std::process::id()));
        std::fs::copy(&source, &tmp).map_err(|e| format!("stage copy: {e}"))?;
        #[allow(clippy::permissions_set_readonly_false)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
        }
        std::fs::rename(&tmp, &staged).map_err(|e| format!("stage rename: {e}"))?;
        Ok(staged)
    }

    // 소스 해석: SOKSAK_PTYD_BIN(오픈 테스트 메커니즘 — SOKSAK_VAULT_PATH 와 동형)
    // > 앱 실행 파일 형제 soksak-ptyd(dev cargo 산출·번들 동봉 공통 규칙).
    fn resolve_source_binary() -> Option<PathBuf> {
        if let Ok(p) = std::env::var("SOKSAK_PTYD_BIN") {
            if !p.is_empty() {
                let p = PathBuf::from(p);
                if p.exists() {
                    return Some(p);
                }
            }
        }
        let exe = std::env::current_exe().ok()?;
        let sibling = exe.parent()?.join("soksak-ptyd");
        sibling.exists().then_some(sibling)
    }

    fn same_content(a: &Path, b: &Path) -> bool {
        use sha2::{Digest, Sha256};
        let hash = |p: &Path| -> Option<[u8; 32]> {
            let mut f = std::fs::File::open(p).ok()?;
            let mut h = Sha256::new();
            std::io::copy(&mut f, &mut h).ok()?;
            Some(h.finalize().into())
        };
        matches!((hash(a), hash(b)), (Some(x), Some(y)) if x == y)
    }

    // 디스크의 봉인 체크포인트 헤더 — cold restore 의 입력(개봉 전 메타).
    struct ColdCheckpoint {
        path: PathBuf,
        key_id: String,
        alt_active: bool,
        sealed: soksak_seal::SealedBox,
    }

    fn read_checkpoint(home: &Path, window: &str, pane: &str) -> Option<ColdCheckpoint> {
        let path = proto::checkpoint_path(home, window, pane);
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).ok()?).ok()?;
        if doc["v"] != 1 {
            return None; // 미래 판 — 이 세대는 열지 않는다(손대지 않고 남긴다)
        }
        Some(ColdCheckpoint {
            path,
            key_id: doc["keyId"].as_str()?.to_string(),
            alt_active: doc["altActive"] == true,
            sealed: serde_json::from_value(doc["sealed"].clone()).ok()?,
        })
    }

    // 개봉 — unlock 된 vault 의 개인키 + 정합 AAD 만 연다. 실패 사유는 고지에 실린다.
    fn open_cold_checkpoint(
        app: &tauri::AppHandle,
        ck: &ColdCheckpoint,
        window: &str,
        pane: &str,
    ) -> Result<Vec<u8>, String> {
        let secrets = tauri::Manager::state::<crate::secrets::SecretsState>(app);
        if !secrets.is_unlocked() {
            return Err("vault locked".into());
        }
        let sk = secrets
            .get_data_key(&ck.key_id)?
            .ok_or_else(|| format!("checkpoint key {} not in vault", ck.key_id))?;
        let aad = proto::checkpoint_aad(window, pane, &ck.key_id);
        crate::secrets::open_sealed(&sk, &ck.sealed, &aad)
    }

    // 정확히 n 바이트를 읽어 버린다 — cold 주입 후 신선 세션의 재생을 건너뛴다.
    fn discard_exact(stream: &mut UnixStream, mut n: u64) -> Result<(), String> {
        let mut buf = [0u8; 8192];
        while n > 0 {
            let want = (buf.len() as u64).min(n) as usize;
            let got = stream.read(&mut buf[..want]).map_err(|e| e.to_string())?;
            if got == 0 {
                return Err("stream closed during replay discard".into());
            }
            n -= got as u64;
        }
        Ok(())
    }

    // stream 부착: hello 1줄 교환 후 raw 전환. hello 응답 줄만 바이트 단위로 소비해
    // 뒤따르는 재생/라이브 바이트를 잃지 않는다. 반환 = (소켓, 재생 바이트 수).
    fn attach_stream(home: &Path, session: u64) -> Result<(UnixStream, u64), String> {
        let token = std::fs::read_to_string(proto::token_path(home))
            .map_err(|e| format!("token: {e}"))?
            .trim()
            .to_string();
        let conn = UnixStream::connect(proto::stream_socket_path(home))
            .map_err(|e| format!("stream connect: {e}"))?;
        let mut w = conn.try_clone().map_err(|e| e.to_string())?;
        let hello = proto::Hello {
            version: Some(proto::PTYD_PROTOCOL_VERSION),
            token,
            client_id: format!("app-{}", std::process::id()),
            session: Some(session),
        };
        let line = serde_json::to_string(&hello).map_err(|e| e.to_string())?;
        writeln!(w, "{line}").map_err(|e| e.to_string())?;
        let mut r = conn.try_clone().map_err(|e| e.to_string())?;
        let mut reply = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            r.read_exact(&mut byte).map_err(|e| format!("stream hello: {e}"))?;
            if byte[0] == b'\n' {
                break;
            }
            reply.push(byte[0]);
            if reply.len() > 64 * 1024 {
                return Err("stream hello reply too long".into());
            }
        }
        let v: Value = serde_json::from_slice(&reply).map_err(|e| e.to_string())?;
        if v["ok"] != true {
            return Err(format!(
                "{}: {}",
                v["code"].as_str().unwrap_or("ERROR"),
                v["message"].as_str().unwrap_or_default()
            ));
        }
        let replay_len = v["data"]["replayBytes"].as_u64().unwrap_or(0);
        Ok((conn, replay_len))
    }
}
