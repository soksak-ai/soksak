// 프로젝트 데몬 — Procfile 로 선언된 프로젝트 상시 프로세스(dev 서버·watcher·DB)의 수명 관리 싱글톤.
// 계약: 선언은 프로젝트의 Procfile(표준 규약), 정책(autostart·restart)은 프런트의 로컬 DB — 여기는
// 실행만 안다. 창=프로젝트 수명과 결속: 열림에 프런트가 start 를 부르고, 닫힘·앱 종료에 stop 이
// 트리 전체(프로세스 그룹)를 정리한다(잔존 프로세스 금지 — process.rs 와 같은 종료 기법). 로그는 파일 없이
// 메모리 링버퍼(데몬당 최근 N줄). 상태 변화는 app.emit("daemon") 브로드캐스트 — 폴링 없음.
// pid 는 프런트가 로컬 DB 에 기록해 두었다가, 비정상 종료 뒤 reap 으로 회수한다(명령줄 대조 후 종료).

use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, State};

/// 데몬당 링버퍼 상한(줄) — 넘치면 앞에서 버린다. 영속이 필요하면 사용자가 cmd 에서 리다이렉트한다.
const RING_CAP: usize = 500;
/// on-crash 재시작 상한 — 이 횟수를 넘으면 crashed 로 멈춘다(무한 재시작 금지).
const RESTART_CAP: u32 = 5;
/// 종료 유예(초) — SIGTERM 후 이 시간 안에 종료되지 않으면 그룹 SIGKILL.
const STOP_GRACE_SECS: u64 = 5;

fn key(root: &str, name: &str) -> String {
    format!("{root}\u{0}{name}")
}

/// 링버퍼에 한 줄 넣기 — 상한 유지(순수 로직, 테스트 대상).
fn ring_push(ring: &mut VecDeque<String>, line: String, cap: usize) {
    if ring.len() >= cap {
        ring.pop_front();
    }
    ring.push_back(line);
}

/// on-crash 백오프(초) — 지수(1,2,4,8,16), 상한 도달 여부는 호출자가 RESTART_CAP 으로 판정.
fn backoff_secs(restarts: u32) -> u64 {
    1u64 << restarts.min(4)
}

/// reap 안전 판정 — ps 명령줄이 선언 cmd 의 부분열을 담을 때만 종료한다(pid 재사용으로 다른 프로세스를 잘못 종료하는 일 방지).
fn reap_matches(ps_command: &str, declared_cmd: &str) -> bool {
    let needle = declared_cmd
        .split_whitespace()
        .next()
        .unwrap_or(declared_cmd);
    !needle.is_empty() && ps_command.contains(needle)
}

#[derive(Clone, Serialize)]
pub struct DaemonStatus {
    pub root: String,
    pub name: String,
    pub pid: u32,
    pub running: bool,
    /// 종료했다면 그 코드(신호 종료는 None 유지 + running=false).
    pub exit_code: Option<i32>,
    pub uptime_ms: u128,
    pub restarts: u32,
}

struct DaemonEntry {
    root: String,
    name: String,
    cmd: String,
    /// 이 데몬을 소유한 창 라벨(P6: 창=프로젝트) — 창 파괴 시 함께 정리한다.
    window: String,
    child: Arc<Mutex<Child>>,
    ring: Arc<Mutex<VecDeque<String>>>,
    started: Instant,
    restarts: u32,
    running: Arc<Mutex<(bool, Option<i32>)>>,
    /// stop 이 명시된 데몬은 wait 스레드가 on-crash 재시작을 하지 않는다.
    stopping: Arc<Mutex<bool>>,
}

#[derive(Default)]
pub struct DaemonManager {
    inner: Arc<Mutex<HashMap<String, DaemonEntry>>>,
}

impl DaemonManager {
    /// 앱 종료 시 전 데몬의 프로세스 그룹을 종료한다(잔존 방지) — ExitRequested 에서 호출.
    pub fn kill_all(&self) {
        let map = self.inner.lock().unwrap();
        for e in map.values() {
            *e.stopping.lock().unwrap() = true;
            kill_group(&e.child, true);
        }
    }

    /// 창 파괴 시 그 창이 소유한 데몬을 전부 종료한다 — 프로젝트 닫힘 = 데몬 수명 종료.
    pub fn kill_by_window(&self, label: &str) {
        let map = self.inner.lock().unwrap();
        for e in map.values() {
            if e.window == label {
                *e.stopping.lock().unwrap() = true;
                kill_group(&e.child, true);
            }
        }
    }
}

/// 프로세스 그룹에 신호 — graceful=false 면 즉시 SIGKILL. 직계 kill 폴백 포함(멱등).
fn kill_group(child: &Arc<Mutex<Child>>, force: bool) {
    if let Ok(mut c) = child.lock() {
        #[cfg(unix)]
        unsafe {
            let sig = if force { libc::SIGKILL } else { libc::SIGTERM };
            libc::killpg(c.id() as i32, sig);
        }
        if force {
            let _ = c.kill();
        }
        #[cfg(not(unix))]
        {
            // 윈도우: 트리 종료는 taskkill /T — Job Object 도입 전의 표준 경로.
            let _ = Command::new("taskkill")
                .args([
                    "/PID",
                    &c.id().to_string(),
                    "/T",
                    if force { "/F" } else { "" },
                ])
                .output();
        }
    }
}

/// 플랫폼 셸로 스폰 — GUI PATH 함정 대응(로그인 셸 래핑, npm_global_dirs 와 동일 기법).
fn spawn_shell(root: &str, cmd: &str, env: Option<&HashMap<String, String>>) -> Result<Child, String> {
    #[cfg(unix)]
    let mut c = {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let mut c = Command::new(shell);
        c.args(["-lc", cmd]);
        c
    };
    #[cfg(not(unix))]
    let mut c = {
        let mut c = Command::new("cmd");
        c.args(["/C", cmd]);
        c
    };
    c.current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Caller-supplied env (e.g. GH_TOKEN for the publish gh child). Injected into the child's
    // environment — not this process's — so a token never lands in the parent or its trace.
    if let Some(vars) = env {
        c.envs(vars);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0); // pgid = 자식 pid — 그룹 신호가 트리 전체를 겨눈다.
    }
    c.spawn().map_err(|e| format!("데몬 스폰 실패: {e}"))
}

fn emit_daemon(app: &AppHandle, root: &str, name: &str, event: &str, code: Option<i32>) {
    let _ = app.emit(
        "daemon",
        serde_json::json!({ "root": root, "name": name, "event": event, "code": code }),
    );
}

fn pump_lines<R: std::io::Read + Send + 'static>(src: R, ring: Arc<Mutex<VecDeque<String>>>) {
    std::thread::spawn(move || {
        let reader = BufReader::new(src);
        for line in reader.lines() {
            match line {
                Ok(l) => ring_push(&mut ring.lock().unwrap(), l, RING_CAP),
                Err(_) => break,
            }
        }
    });
}

/// 데몬 하나를 실제로 띄우고 관찰 스레드를 붙인다 — start 와 on-crash 재시작이 공유하는 단일 경로.
fn launch(
    app: AppHandle,
    mgr: Arc<Mutex<HashMap<String, DaemonEntry>>>,
    root: String,
    name: String,
    cmd: String,
    window: String,
    restart_on_crash: bool,
    restarts: u32,
) -> Result<u32, String> {
    let mut child = spawn_shell(&root, &cmd, None)?;
    let pid = child.id();
    let ring: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    if let Some(out) = child.stdout.take() {
        pump_lines(out, ring.clone());
    }
    if let Some(err) = child.stderr.take() {
        pump_lines(err, ring.clone());
    }
    let child = Arc::new(Mutex::new(child));
    let running = Arc::new(Mutex::new((true, None::<i32>)));
    let stopping = Arc::new(Mutex::new(false));
    let entry = DaemonEntry {
        root: root.clone(),
        name: name.clone(),
        cmd: cmd.clone(),
        window: window.clone(),
        child: child.clone(),
        ring,
        started: Instant::now(),
        restarts,
        running: running.clone(),
        stopping: stopping.clone(),
    };
    mgr.lock().unwrap().insert(key(&root, &name), entry);
    emit_daemon(&app, &root, &name, "started", None);

    // 관찰 스레드 — wait 로 종료를 감지(폴링 없음), 필요 시 백오프 재시작.
    std::thread::spawn(move || {
        let code = loop {
            // wait 는 child mutex 를 잡지 않는 try_wait 루프가 아니라, 짧은 sleep 병행의 try_wait 다.
            // 이유: kill 경로(kill_group)가 같은 mutex 를 즉시 잡을 수 있어야 한다(process.rs 데드락 회피).
            {
                let mut c = child.lock().unwrap();
                match c.try_wait() {
                    Ok(Some(st)) => break st.code(),
                    Ok(None) => {}
                    Err(_) => break None,
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(300));
        };
        *running.lock().unwrap() = (false, code);
        emit_daemon(&app, &root, &name, "exited", code);
        let was_stopping = *stopping.lock().unwrap();
        let crashed = !was_stopping && code != Some(0);
        if restart_on_crash && crashed {
            if restarts + 1 > RESTART_CAP {
                emit_daemon(&app, &root, &name, "crashed", code);
                return;
            }
            std::thread::sleep(std::time::Duration::from_secs(backoff_secs(restarts)));
            // 재시작 사이에 stop 이 왔으면 접는다.
            if *stopping.lock().unwrap() {
                return;
            }
            let _ = launch(app, mgr, root, name, cmd, window, true, restarts + 1);
        }
    });
    Ok(pid)
}

#[tauri::command]
pub fn daemon_start(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, DaemonManager>,
    root: String,
    name: String,
    cmd: String,
    restart: Option<String>,
) -> Result<u32, String> {
    let k = key(&root, &name);
    {
        let map = state.inner.lock().unwrap();
        if let Some(e) = map.get(&k) {
            if e.running.lock().unwrap().0 {
                return Err(format!("이미 실행 중: {name}"));
            }
        }
    }
    launch(
        app,
        state.inner.clone(),
        root,
        name,
        cmd,
        window.label().to_string(),
        restart.as_deref() == Some("on-crash"),
        0,
    )
}

#[tauri::command]
pub fn daemon_stop(
    state: State<'_, DaemonManager>,
    root: String,
    name: Option<String>,
) -> Result<Vec<String>, String> {
    let map = state.inner.lock().unwrap();
    let mut stopped = Vec::new();
    for e in map.values() {
        if e.root != root {
            continue;
        }
        if let Some(n) = &name {
            if &e.name != n {
                continue;
            }
        }
        if !e.running.lock().unwrap().0 {
            continue;
        }
        *e.stopping.lock().unwrap() = true;
        kill_group(&e.child, false);
        stopped.push(e.name.clone());
        // 유예 후 강제 — 관찰 스레드가 종료를 감지하면 즉시 반영되고, 이 에스컬레이션은 무해(멱등).
        let child = e.child.clone();
        let running = e.running.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(STOP_GRACE_SECS));
            if running.lock().unwrap().0 {
                kill_group(&child, true);
            }
        });
    }
    Ok(stopped)
}

#[tauri::command]
pub fn daemon_status(state: State<'_, DaemonManager>, root: Option<String>) -> Vec<DaemonStatus> {
    let map = state.inner.lock().unwrap();
    map.values()
        .filter(|e| root.as_deref().is_none_or(|r| e.root == r))
        .map(|e| {
            let (running, exit_code) = *e.running.lock().unwrap();
            DaemonStatus {
                root: e.root.clone(),
                name: e.name.clone(),
                pid: e.child.lock().unwrap().id(),
                running,
                exit_code,
                uptime_ms: e.started.elapsed().as_millis(),
                restarts: e.restarts,
            }
        })
        .collect()
}

#[tauri::command]
pub fn daemon_logs(
    state: State<'_, DaemonManager>,
    root: String,
    name: String,
    lines: Option<usize>,
) -> Result<Vec<String>, String> {
    let map = state.inner.lock().unwrap();
    let e = map
        .get(&key(&root, &name))
        .ok_or_else(|| format!("데몬 없음: {name}"))?;
    let ring = e.ring.lock().unwrap();
    let n = lines.unwrap_or(100).min(RING_CAP);
    Ok(ring.iter().rev().take(n).rev().cloned().collect())
}

/// 비정상 종료 뒤 잔존 회수 — 프런트가 로컬 DB 에 기록해 둔 (pid, cmd) 목록을 넘긴다.
/// pid 재사용으로 다른 프로세스를 잘못 종료하지 않도록, ps 명령줄이 선언 cmd 와 대조될 때만 그룹을 종료한다.
#[tauri::command]
pub fn daemon_reap(entries: Vec<(u32, String)>) -> Vec<u32> {
    let mut reaped = Vec::new();
    for (pid, cmd) in entries {
        #[cfg(unix)]
        {
            let out = Command::new("ps")
                .args(["-o", "command=", "-p", &pid.to_string()])
                .output();
            let alive_cmd = out
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_default();
            if !alive_cmd.is_empty() && reap_matches(&alive_cmd, &cmd) {
                unsafe {
                    libc::killpg(pid as i32, libc::SIGKILL);
                    libc::kill(pid as i32, libc::SIGKILL);
                }
                reaped.push(pid);
            }
        }
        #[cfg(not(unix))]
        {
            let _ = cmd;
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .output();
            reaped.push(pid);
        }
    }
    reaped
}

/// 일회 실행 — 분리 실행형 데몬의 종료 명령(docker compose down 등)을 돌리고 끝을 기다린다.
/// 데몬 장부에 올리지 않으며, 상한 시간 안에 끝나지 않으면 트리를 종료하고 오류를 알린다.
#[tauri::command]
pub fn daemon_run_once(
    root: String,
    cmd: String,
    timeout_secs: Option<u64>,
    env: Option<HashMap<String, String>>,
) -> Result<serde_json::Value, String> {
    let mut child = spawn_shell(&root, &cmd, env.as_ref())?;
    let ring: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    if let Some(out) = child.stdout.take() {
        pump_lines(out, ring.clone());
    }
    if let Some(err) = child.stderr.take() {
        pump_lines(err, ring.clone());
    }
    let limit = std::time::Duration::from_secs(timeout_secs.unwrap_or(60));
    let started = Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st.code(),
            Ok(None) => {}
            Err(e) => return Err(format!("대기 실패: {e}")),
        }
        if started.elapsed() > limit {
            let shared = Arc::new(Mutex::new(child));
            kill_group(&shared, true);
            return Err(format!("시간 초과({}초): {cmd}", limit.as_secs()));
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    };
    let lines: Vec<String> = ring.lock().unwrap().iter().cloned().collect();
    Ok(serde_json::json!({ "code": code, "lines": lines }))
}

/// ExitRequested 정리 훅 — lib.rs 가 부른다.
pub fn kill_all(app: &AppHandle) {
    app.state::<DaemonManager>().kill_all();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 링버퍼는_상한을_넘으면_앞에서_버린다() {
        let mut r = VecDeque::new();
        for i in 0..10 {
            ring_push(&mut r, format!("l{i}"), 3);
        }
        assert_eq!(r.len(), 3);
        assert_eq!(r.front().unwrap(), "l7");
        assert_eq!(r.back().unwrap(), "l9");
    }

    #[test]
    fn 백오프는_지수이고_상한이_있다() {
        assert_eq!(backoff_secs(0), 1);
        assert_eq!(backoff_secs(1), 2);
        assert_eq!(backoff_secs(3), 8);
        assert_eq!(backoff_secs(4), 16);
        assert_eq!(backoff_secs(99), 16);
    }

    #[test]
    fn reap_은_명령줄이_대조될_때만_참이다() {
        assert!(reap_matches("node /x/y/vite dev", "node server.js"));
        assert!(!reap_matches("vim", "node server.js"));
        assert!(!reap_matches("", "node server.js"));
        assert!(reap_matches(
            "docker compose up postgres",
            "docker compose up postgres"
        ));
    }

    // S2 — daemon_run_once is the spawn bridge the core release commands ride: the release summary
    // is a multi-KB single line, and release.publish needs a token in the child env.
    #[cfg(unix)]
    #[test]
    fn 대용량_단일_라인은_온전히_캡처된다() {
        // BufRead::lines has no per-line cap; RING_CAP bounds line COUNT (keeps the last 500), so
        // the trailing summary line survives intact — no truncation of a multi-KB release.json.
        let out = daemon_run_once(
            "/tmp".into(),
            "head -c 50000 /dev/zero | tr '\\0' X".into(),
            Some(10),
            None,
        )
        .expect("run");
        let lines = out["lines"].as_array().expect("lines");
        assert!(
            lines.iter().any(|l| l
                .as_str()
                .map(|s| s.len() == 50000 && s.bytes().all(|b| b == b'X'))
                .unwrap_or(false)),
            "a 50000-char single line must be captured intact"
        );
    }

    #[cfg(unix)]
    #[test]
    fn env_는_자식에만_주입된다() {
        // release.publish's GH_TOKEN path — injected into the child, never the parent/trace.
        let mut env = HashMap::new();
        env.insert("SOKSAK_TEST_ENV".to_string(), "injected-marker-xyz".to_string());
        let out = daemon_run_once(
            "/tmp".into(),
            "printf %s \"$SOKSAK_TEST_ENV\"".into(),
            Some(10),
            Some(env),
        )
        .expect("run");
        let lines = out["lines"].as_array().expect("lines");
        assert!(
            lines
                .iter()
                .any(|l| l.as_str().map(|s| s.contains("injected-marker-xyz")).unwrap_or(false)),
            "the injected env var must reach the child"
        );
        assert!(std::env::var("SOKSAK_TEST_ENV").is_err(), "must not leak into the parent env");
    }

    #[cfg(unix)]
    #[test]
    fn 스폰_그룹킬_수명() {
        // 손자를 낳는 셸 명령 — 그룹 킬이 트리 전체를 회수하는지.
        let child = spawn_shell("/tmp", "sleep 30 & sleep 30", None).expect("spawn");
        let pid = child.id();
        let child = Arc::new(Mutex::new(child));
        std::thread::sleep(std::time::Duration::from_millis(200));
        kill_group(&child, true);
        std::thread::sleep(std::time::Duration::from_millis(300));
        let mut c = child.lock().unwrap();
        assert!(
            c.try_wait().expect("wait").is_some(),
            "본체가 종료되어야 한다"
        );
        // 그룹의 다른 구성원(sleep 손자)도 종료되었는지 — pgid 로 신호 0 확인.
        unsafe {
            assert_ne!(libc::killpg(pid as i32, 0), 0, "그룹이 비어야 한다");
        }
    }
}
