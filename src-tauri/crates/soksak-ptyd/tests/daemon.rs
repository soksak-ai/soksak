// soksak-ptyd 통합 테스트 — 실제 데몬 바이너리를 격리 홈으로 띄워 계약을 검증한다:
// hello 게이트(버전·토큰), createOrAttach 스폰, stream 라이브 출력, 앱-사망 모사
// (연결 전부 드롭) 후 같은 셸 pid 재부착 + 링 재생, kill, shutdown.
//
// 소켓 경로는 /tmp 밑 짧은 경로를 쓴다 — macOS sun_path 는 104바이트 제한이라
// 긴 tempdir(스크래치패드 포함)로는 bind 자체가 실패한다.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use soksak_spec_pty as proto;

struct Daemon {
    child: Child,
    home: PathBuf,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

// 데몬 기동 + control 소켓 응답 대기. 재시도는 테스트 부트스트랩 한정(상한 5s,
// 성공 즉시 종료) — 런타임 감시가 아니다.
fn start_daemon(name: &str) -> Daemon {
    let home = PathBuf::from(format!("/tmp/sokptyd-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_soksak-ptyd"))
        .env("SOKSAK_HOME", &home)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn soksak-ptyd");
    let d = Daemon { child, home };
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if UnixStream::connect(proto::control_socket_path(&d.home)).is_ok() {
            return d;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("daemon did not serve its control socket in time");
}

fn token_of(home: &Path) -> String {
    std::fs::read_to_string(proto::token_path(home)).unwrap().trim().to_string()
}

struct Control {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Control {
    fn connect(home: &Path) -> Control {
        let conn = UnixStream::connect(proto::control_socket_path(home)).unwrap();
        conn.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let reader = BufReader::new(conn.try_clone().unwrap());
        let mut c = Control { reader, writer: conn };
        let hello = proto::Hello {
            version: Some(proto::PTYD_PROTOCOL_VERSION),
            token: token_of(home),
            client_id: "test".into(),
            session: None,
            from_seq: None,
            subscribe: false,
        };
        let reply = c.roundtrip(&serde_json::to_value(&hello).unwrap());
        assert_eq!(reply["ok"], true, "hello accepted: {reply}");
        c
    }

    fn roundtrip(&mut self, v: &Value) -> Value {
        writeln!(self.writer, "{v}").unwrap();
        let mut line = String::new();
        self.reader.read_line(&mut line).unwrap();
        serde_json::from_str(line.trim()).unwrap()
    }

    fn request(&mut self, req: &proto::Request) -> Value {
        self.roundtrip(&serde_json::to_value(req).unwrap())
    }
}

// stream 열기: hello 응답 줄까지 바이트 단위로 소비하고, 그 뒤(raw 또는 프레임)를
// 읽는 소켓을 돌려준다. from_seq/subscribe 로 attach·warm-handoff·tee 를 모두 연다.
fn open_stream(
    home: &Path,
    session: u64,
    from_seq: Option<u64>,
    subscribe: bool,
) -> (Value, UnixStream) {
    let conn = UnixStream::connect(proto::stream_socket_path(home)).unwrap();
    conn.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut w = conn.try_clone().unwrap();
    let hello = proto::Hello {
        version: Some(proto::PTYD_PROTOCOL_VERSION),
        token: token_of(home),
        client_id: "test-stream".into(),
        session: Some(session),
        from_seq,
        subscribe,
    };
    writeln!(w, "{}", serde_json::to_string(&hello).unwrap()).unwrap();
    // hello 응답 1줄만 바이트 단위로 소비 — 이후 재생/라이브/프레임을 잃지 않는다.
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    let mut r = conn.try_clone().unwrap();
    loop {
        r.read_exact(&mut byte).unwrap();
        if byte[0] == b'\n' {
            break;
        }
        line.push(byte[0]);
    }
    let reply: Value = serde_json::from_slice(&line).unwrap();
    (reply, conn)
}

fn attach_stream(home: &Path, session: u64) -> (Value, UnixStream) {
    open_stream(home, session, None, false)
}

// tee 프레임 하나를 읽는다: [kind u8][len u32 BE][payload]. (kind, payload) 반환.
fn read_tee_frame(stream: &mut UnixStream) -> (u8, Vec<u8>) {
    let mut head = [0u8; 5];
    stream.read_exact(&mut head).unwrap();
    let kind = head[0];
    let len = u32::from_be_bytes([head[1], head[2], head[3], head[4]]) as usize;
    let mut payload = vec![0u8; len];
    stream.read_exact(&mut payload).unwrap();
    (kind, payload)
}

// 스트림에서 패턴이 나올 때까지 누적 읽기(상한 5s).
fn read_until(stream: &mut UnixStream, pattern: &str) -> String {
    let mut acc = Vec::new();
    let mut buf = [0u8; 4096];
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                acc.extend_from_slice(&buf[..n]);
                if String::from_utf8_lossy(&acc).contains(pattern) {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&acc).to_string();
    assert!(text.contains(pattern), "expected {pattern:?} in stream, got: {text:?}");
    text
}

fn create(control: &mut Control, pane: &str) -> Value {
    control.request(&proto::Request::CreateOrAttach {
        pane_id: pane.into(),
        cols: 80,
        rows: 24,
        cwd: Some("/tmp".into()),
        shell: "/bin/sh".into(),
        env: vec![("TERM".into(), "dumb".into()), ("PS1".into(), "$ ".into())],
        env_remove: vec![],
        window_label: Some("w-test".into()),
        checkpoint_pk: None,
        checkpoint_key_id: None,
    })
}

fn write_line(control: &mut Control, session: u64, line: &str) {
    use base64::Engine as _;
    let w = proto::Request::Write {
        session,
        data_b64: base64::engine::general_purpose::STANDARD.encode(format!("{line}\n")),
    };
    assert_eq!(control.request(&w)["ok"], true);
}

// 조건 충족까지 유한 대기(테스트 부트스트랩 한정, 상한 명시) — 런타임 감시가 아니다.
fn wait_until(what: &str, deadline: Duration, mut f: impl FnMut() -> bool) {
    let end = Instant::now() + deadline;
    while Instant::now() < end {
        if f() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("timed out waiting for {what}");
}

// ── hello 게이트 ─────────────────────────────────────────────────────────────

#[test]
fn hello_gate_rejects_bad_token_and_missing_version() {
    let d = start_daemon("gate");
    // 토큰 불일치 → UNAUTHORIZED
    let conn = UnixStream::connect(proto::control_socket_path(&d.home)).unwrap();
    conn.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut w = conn.try_clone().unwrap();
    writeln!(w, "{}", json!({"version": 1, "token": "wrong", "clientId": "t"})).unwrap();
    let mut line = String::new();
    BufReader::new(conn).read_line(&mut line).unwrap();
    let reply: Value = serde_json::from_str(line.trim()).unwrap();
    assert_eq!(reply["code"], "UNAUTHORIZED", "{reply}");

    // 버전 부재(=0) → VERSION_SKEW (hello 는 1세대부터 의무)
    let conn = UnixStream::connect(proto::control_socket_path(&d.home)).unwrap();
    conn.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut w = conn.try_clone().unwrap();
    writeln!(w, "{}", json!({"token": token_of(&d.home), "clientId": "t"})).unwrap();
    let mut line = String::new();
    BufReader::new(conn).read_line(&mut line).unwrap();
    let reply: Value = serde_json::from_str(line.trim()).unwrap();
    assert_eq!(reply["code"], "VERSION_SKEW", "{reply}");
}

// ── 라이브 데몬 업그레이드: 셸이 SIGHUP 없이·같은 pid 로 새 데몬에게 넘어간다 ────
// HS1(무중단)+HS2(fd 소유 불변식)의 증명. 이전 데몬이 PrepareUpgrade 로 새 데몬을 스폰하고
// PTY master fd 를 상속시킨 뒤 exit 하면, 새 데몬이 소켓을 넘겨받고 셸은 살아 있어야 한다.
#[test]
fn daemon_upgrade_hands_off_live_sessions() {
    let mut d = start_daemon("handoff");
    let mut control = Control::connect(&d.home);

    let created = create(&mut control, "pane-h");
    assert_eq!(created["ok"], true, "{created}");
    let session = created["data"]["session"].as_u64().unwrap();
    let shell_pid = created["data"]["shellPid"].as_u64().unwrap();
    assert!(shell_pid > 0);

    // 업그레이드 전 라이브 출력 — 셸이 실제로 살아 있음.
    let (_r, mut stream) = attach_stream(&d.home, session);
    write_line(&mut control, session, "echo BEFORE_UPGRADE");
    read_until(&mut stream, "BEFORE_UPGRADE");
    drop(stream);

    // 라이브 업그레이드 트리거 — 같은 바이너리를 새 데몬으로. 이전 데몬은 응답 없이 exit 한다(write 만).
    let bin = env!("CARGO_BIN_EXE_soksak-ptyd").to_string();
    writeln!(
        control.writer,
        "{}",
        serde_json::to_value(&proto::Request::PrepareUpgrade { new_bin: bin }).unwrap()
    )
    .unwrap();

    // 이전 데몬(A)이 commit 후 exit 할 때까지 — handoff 성공의 필요조건.
    {
        let deadline = Instant::now() + Duration::from_secs(10);
        while d.child.try_wait().unwrap().is_none() {
            assert!(Instant::now() < deadline, "old daemon did not exit after handoff");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    // 새 데몬(B)이 control 소켓을 넘겨받을 때까지.
    wait_until("new daemon to serve control socket", Duration::from_secs(10), || {
        UnixStream::connect(proto::control_socket_path(&d.home)).is_ok()
    });

    // 새 데몬에 재연결 — 세션이 살아 있고 shell_pid 가 동일해야 한다(무손실·무재스폰).
    let mut c2 = Control::connect(&d.home);
    let list = c2.request(&proto::Request::ListSessions);
    let sessions = list["data"]["sessions"].as_array().unwrap();
    let found = sessions
        .iter()
        .find(|s| s["session"].as_u64() == Some(session))
        .expect("session survived the daemon upgrade");
    assert_eq!(
        found["shellPid"].as_u64(),
        Some(shell_pid),
        "same shell pid across upgrade — no SIGHUP, no respawn (HS2)"
    );

    // 셸이 실제로 살아 입력에 응답하는지 — 새 데몬 소켓으로 write + stream read.
    let (_r, mut stream2) = attach_stream(&d.home, session);
    write_line(&mut c2, session, "echo AFTER_UPGRADE");
    read_until(&mut stream2, "AFTER_UPGRADE");

    // 새 데몬(B) 정리 — Daemon::drop 은 이전 데몬(A, 이미 죽음)만 정리하므로 B 를 명시 종료.
    let _ = c2.request(&proto::Request::Shutdown);
}

// ── 생존 여정: 스폰 → 출력 → 앱 사망 모사 → 같은 pid 재부착 + 링 재생 ─────────

#[test]
fn shell_survives_client_death_and_reattaches_with_replay() {
    let d = start_daemon("journey");
    let mut control = Control::connect(&d.home);

    let created = create(&mut control, "pane-1");
    assert_eq!(created["ok"], true, "{created}");
    assert_eq!(created["data"]["attached"], false, "first contact spawns: {created}");
    let session = created["data"]["session"].as_u64().unwrap();
    let shell_pid = created["data"]["shellPid"].as_u64().unwrap();
    assert!(shell_pid > 0);

    let (reply, mut stream) = attach_stream(&d.home, session);
    assert_eq!(reply["ok"], true, "{reply}");

    // 라이브 출력: write → stream 도착.
    let marker = format!("mark-{}", std::process::id());
    let w = proto::Request::Write {
        session,
        data_b64: {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD.encode(format!("echo {marker}\n"))
        },
    };
    assert_eq!(control.request(&w)["ok"], true);
    read_until(&mut stream, &marker);

    // 앱 사망 모사: control + stream 연결 전부 드롭. 셸은 계속 산다.
    drop(control);
    drop(stream);
    std::thread::sleep(Duration::from_millis(200));
    // kill -0 로 셸 생존 확인.
    assert_eq!(
        unsafe { libc_kill(shell_pid as i32, 0) },
        0,
        "shell must survive client death"
    );

    // 재부착: 같은 pane → 같은 세션, 같은 셸 pid, attached=true.
    let mut control = Control::connect(&d.home);
    let again = create(&mut control, "pane-1");
    assert_eq!(again["data"]["attached"], true, "{again}");
    assert_eq!(again["data"]["session"].as_u64().unwrap(), session);
    assert_eq!(again["data"]["shellPid"].as_u64().unwrap(), shell_pid);

    // 링 재생: detach 전에 흘렀던 마커가 원시 링 재생(from_seq=0)에 들어 있다 — 미러
    // 방출 후 재부착 재생은 원시 링이 나른다(from_seq 없는 부착은 재생 없이 라이브).
    let (reply, mut stream) = open_stream(&d.home, session, Some(0), false);
    assert!(reply["data"]["replayBytes"].as_u64().unwrap() > 0, "{reply}");
    read_until(&mut stream, &marker);

    // kill: 세션 소멸 → 같은 pane 재요청은 새 셸(다른 pid).
    assert_eq!(control.request(&proto::Request::Kill { session })["ok"], true);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let re = create(&mut control, "pane-1");
        if re["data"]["attached"] == false {
            assert_ne!(re["data"]["shellPid"].as_u64().unwrap(), shell_pid);
            break;
        }
        assert!(Instant::now() < deadline, "killed session still serving attach");
        std::thread::sleep(Duration::from_millis(100));
    }

    // shutdown: 데몬 종료 확인.
    let bye = control.request(&proto::Request::Shutdown);
    assert_eq!(bye["ok"], true);
}

// ── 재부착 키 = (창, pane): pane id 는 창 안에서만 유일하다 ───────────────────
// 실측 근거: 창별 순차 뷰 id 라 여러 창이 각자 "v2" pane 을 가진다. pane 만으로
// 매칭하면 다른 창의 셸에 재부착한다(오부착 — 이 테스트가 그 회귀를 막는다).

#[test]
fn same_pane_id_in_two_windows_is_two_sessions() {
    let d = start_daemon("panekey");
    let mut control = Control::connect(&d.home);
    let mk = |control: &mut Control, window: &str| {
        control.request(&proto::Request::CreateOrAttach {
            pane_id: "v2".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: "/bin/sh".into(),
            env: vec![("PS1".into(), "$ ".into())],
            env_remove: vec![],
            window_label: Some(window.into()),
            checkpoint_pk: None,
            checkpoint_key_id: None,
        })
    };
    let a = mk(&mut control, "w-one");
    let b = mk(&mut control, "w-two");
    assert_eq!(a["data"]["attached"], false);
    assert_eq!(b["data"]["attached"], false, "second window spawns its own shell: {b}");
    assert_ne!(
        a["data"]["session"].as_u64().unwrap(),
        b["data"]["session"].as_u64().unwrap()
    );
    // 같은 (창, pane) 재요청만 재부착한다.
    let again = mk(&mut control, "w-one");
    assert_eq!(again["data"]["attached"], true, "{again}");
    assert_eq!(
        again["data"]["session"].as_u64().unwrap(),
        a["data"]["session"].as_u64().unwrap()
    );
}

// ── 창 폐기 reap: killByWindow 는 그 창의 세션만 죽인다 ──────────────────────

#[test]
fn kill_by_window_reaps_only_that_windows_sessions() {
    let d = start_daemon("reap");
    let mut control = Control::connect(&d.home);
    let a = control.request(&proto::Request::CreateOrAttach {
        pane_id: "pane-a".into(),
        cols: 80,
        rows: 24,
        cwd: None,
        shell: "/bin/sh".into(),
        env: vec![("PS1".into(), "$ ".into())],
        env_remove: vec![],
        window_label: Some("w-dead".into()),
        checkpoint_pk: None,
        checkpoint_key_id: None,
    });
    let b = control.request(&proto::Request::CreateOrAttach {
        pane_id: "pane-b".into(),
        cols: 80,
        rows: 24,
        cwd: None,
        shell: "/bin/sh".into(),
        env: vec![("PS1".into(), "$ ".into())],
        env_remove: vec![],
        window_label: Some("w-alive".into()),
        checkpoint_pk: None,
        checkpoint_key_id: None,
    });
    let pid_a = a["data"]["shellPid"].as_u64().unwrap() as i32;
    let pid_b = b["data"]["shellPid"].as_u64().unwrap() as i32;

    let r = control.request(&proto::Request::KillByWindow { window_label: "w-dead".into() });
    assert_eq!(r["data"]["killed"], 1, "{r}");
    let deadline = Instant::now() + Duration::from_secs(5);
    while unsafe { libc_kill(pid_a, 0) } == 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_ne!(unsafe { libc_kill(pid_a, 0) }, 0, "w-dead shell reaped");
    assert_eq!(unsafe { libc_kill(pid_b, 0) }, 0, "w-alive shell untouched");
}

// ── warm 핸드오프: Attach{from_seq} 는 원시 링을 재생한다 ─────────────────────
// from_seq 재생은 raw 바이트라 질의(DA1)를 그대로 싣는다 — from_seq 이후는 진짜
// 미응답 질의라 라이브 터미널이 답하는 게 옳다. 미러가 방출된 뒤 from_seq 없는 부착은
// 재생 없이 라이브만(replayBytes 0) — 화면 복원 페인트는 사이드카·플러그인 소유다.

#[test]
fn from_seq_attach_replays_the_raw_ring() {
    let d = start_daemon("fromseq");
    let mut control = Control::connect(&d.home);
    let created = create(&mut control, "pane-fs");
    let session = created["data"]["session"].as_u64().unwrap();

    // 라이브로 출력을 흘려 링을 채운다: DA1 질의(ESC [ c) + 마커.
    let (_r, mut live) = attach_stream(&d.home, session);
    write_line(&mut control, session, "printf '\\033[c'; echo RAWMARK");
    read_until(&mut live, "RAWMARK");
    drop(live);
    std::thread::sleep(Duration::from_millis(150));

    // from_seq=0 재부착 → 원시 링 재생. servedFromSeq=0, 질의 바이트가 실린다.
    let (reply, mut raw) = open_stream(&d.home, session, Some(0), false);
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["data"]["servedFromSeq"].as_u64().unwrap(), 0, "{reply}");
    assert!(reply["data"]["replayBytes"].as_u64().unwrap() > 0, "{reply}");
    assert!(reply["data"].get("gap").is_none(), "no eviction within cap: {reply}");
    let raw_replay = read_until(&mut raw, "RAWMARK");
    assert!(raw_replay.contains("\x1b[c"), "raw ring replay carries the DA1 query: {raw_replay:?}");
    drop(raw);
    std::thread::sleep(Duration::from_millis(150));

    // from_seq 없음 재부착 → 재생 없이 라이브만(미러 방출 — 복원 페인트는 소비자 소유).
    let (reply, _synth) = attach_stream(&d.home, session);
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["data"]["replayBytes"].as_u64().unwrap(), 0, "no mirror replay: {reply}");
    assert!(reply["data"].get("servedFromSeq").is_none(), "live attach carries no seq: {reply}");

    assert_eq!(control.request(&proto::Request::Shutdown)["ok"], true);
}

// ── tee 구독은 라이브를 막지 않는다: 굶주린 구독자가 있어도 라이브가 완주한다 ──
// 느린(전혀 안 읽는) tee 구독자를 붙인 채 대용량을 흘려도, ack 로 배수하는 라이브
// attach 는 DONE 까지 받는다. reader 는 tee 에 비차단 enqueue 만 하고(넘치면 gap
// 드롭), 소켓 I/O 는 구독자 자기 스레드가 소유하기 때문이다. tee 가 라이브를 막으면
// 이 테스트는 타임아웃한다(RED).

#[test]
fn a_starved_tee_subscriber_never_blocks_the_live_path() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    let d = start_daemon("teelive");
    let mut control = Control::connect(&d.home);
    let created = create(&mut control, "pane-tl");
    let session = created["data"]["session"].as_u64().unwrap();

    // 라이브 attach + 굶주린 tee 구독자(연결만 하고 절대 안 읽는다).
    let (_r, live) = attach_stream(&d.home, session);
    let (sub_reply, _starved) = open_stream(&d.home, session, None, true);
    assert_eq!(sub_reply["ok"], true, "{sub_reply}");
    assert_eq!(sub_reply["data"]["mode"], "subscribe", "{sub_reply}");

    // 배경 스레드: 라이브를 읽으며 ack 로 배수(플로우가 안 멈추게). DONE 관측 플래그.
    let saw_done = Arc::new(AtomicBool::new(false));
    let home = d.home.clone();
    let flag = saw_done.clone();
    let drainer = std::thread::spawn(move || {
        let mut ack = Control::connect(&home);
        let mut live = live;
        let mut acc = Vec::new();
        let mut buf = [0u8; 65536];
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            match live.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let _ = ack.request(&proto::Request::Ack { session, bytes: n as u64 });
                    acc.extend_from_slice(&buf[..n]);
                    if acc.windows(4).any(|w| w == b"DONE") {
                        flag.store(true, Ordering::SeqCst);
                        break;
                    }
                    if acc.len() > 8_000_000 {
                        acc.drain(..4_000_000); // 마커 경계는 남기고 메모리만 줄인다
                    }
                }
                Err(_) => break,
            }
        }
    });

    // 굶주린 tee 버퍼(1MB)를 넘기고도 남는 대용량을 흘린다. tee 는 gap 드롭, 라이브는 완주.
    write_line(
        &mut control,
        session,
        "head -c 1500000 /dev/zero | tr '\\0' x; echo DONE",
    );

    wait_until("live path completes despite a starved tee", Duration::from_secs(20), || {
        saw_done.load(Ordering::SeqCst)
    });
    let _ = drainer.join();
    assert_eq!(control.request(&proto::Request::Shutdown)["ok"], true);
}

// tee 구독 ack 는 그 시점의 링 head 를 startSeq 로 싣는다 — mid-session 구독자의 정확한
// consumed_seq 앵커(warm 핸드오프 좌표). 링이 전진한 뒤 구독하면 startSeq 도 그만큼 앞선다.
// 이게 없으면 소비자가 0 기점으로 세어 데몬 링과 어긋나고 warm 재부착이 최근 출력을 이중
// 재생한다(무음 시프트). RED: startSeq 부재면 as_u64 가 None → expect 패닉.
#[test]
fn a_tee_subscribe_ack_reports_the_ring_head_as_its_start_seq() {
    let d = start_daemon("teeseq");
    let mut control = Control::connect(&d.home);
    let created = create(&mut control, "pane-ts");
    let session = created["data"]["session"].as_u64().unwrap();

    // 첫 구독 — 그 시점 링 head 를 startSeq 로 받는다.
    let (first_ack, mut first_sub) = open_stream(&d.home, session, None, true);
    assert_eq!(first_ack["ok"], true, "{first_ack}");
    let first_start = first_ack["data"]["startSeq"].as_u64().expect("startSeq present in subscribe ack");

    // 마커를 흘려 링을 전진시키고 첫 구독자로 관측(에코 도착 = 링 head 전진).
    write_line(&mut control, session, "echo MARK-SEQ");
    let mut seen = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline && !String::from_utf8_lossy(&seen).contains("MARK-SEQ") {
        let (kind, payload) = read_tee_frame(&mut first_sub);
        if kind == proto::TEE_FRAME_DATA {
            seen.extend_from_slice(&payload);
        }
    }
    assert!(String::from_utf8_lossy(&seen).contains("MARK-SEQ"), "tee carried the marker");

    // 두 번째 구독 — 그 사이 흐른 바이트만큼 startSeq 가 앞선다(링 head 추종, 총 배출 바이트).
    let (second_ack, _s2) = open_stream(&d.home, session, None, true);
    let second_start = second_ack["data"]["startSeq"].as_u64().expect("startSeq present in subscribe ack");
    assert!(
        second_start >= first_start + seen.len() as u64,
        "startSeq tracks total emitted bytes: {second_start} vs {first_start}+{}",
        seen.len()
    );
    assert_eq!(control.request(&proto::Request::Shutdown)["ok"], true);
}

// ── 봉인-블롭 저장소(StoreBlob/FetchSealed): 내용 불가지, cold_paint 없이 임의 바이트 ──

#[test]
fn store_blob_seals_arbitrary_bytes_and_fetch_sealed_returns_them() {
    use base64::Engine as _;
    let d = start_daemon("blob");
    let (sk, pk) = soksak_seal::gen_asym_keypair();
    let pk_b64 = base64::engine::general_purpose::STANDARD.encode(pk);
    let mut control = Control::connect(&d.home);

    // 키 없는 세션 → StoreBlob 은 fail closed.
    let no_key = create(&mut control, "pane-nokey");
    let _ = no_key["data"]["session"].as_u64().unwrap();
    let r = control.request(&proto::Request::StoreBlob {
        window_label: Some("w-test".into()),
        pane_id: "pane-nokey".into(),
        bytes_b64: base64::engine::general_purpose::STANDARD.encode("x"),
    });
    assert_eq!(r["code"], "NO_CHECKPOINT_KEY", "no key → fail closed: {r}");

    // 키 있는 세션 → 임의 바이트를 봉인해 저장. 미러 cold_paint 를 거치지 않는다.
    let created = control.request(&proto::Request::CreateOrAttach {
        pane_id: "pane-blob".into(),
        cols: 80,
        rows: 24,
        cwd: Some("/tmp".into()),
        shell: "/bin/sh".into(),
        env: vec![("PS1".into(), "$ ".into())],
        env_remove: vec![],
        window_label: Some("w-test".into()),
        checkpoint_pk: Some(pk_b64),
        checkpoint_key_id: Some("k-blob".into()),
    });
    assert_eq!(created["ok"], true, "{created}");

    let payload = format!("SIDECAR-PAINT-{}", std::process::id());
    let r = control.request(&proto::Request::StoreBlob {
        window_label: Some("w-test".into()),
        pane_id: "pane-blob".into(),
        bytes_b64: base64::engine::general_purpose::STANDARD.encode(&payload),
    });
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(r["data"]["stored"].as_u64().unwrap(), payload.len() as u64);

    // FetchSealed 로 봉인 문서를 받는다 — 내용 불가지 봉투(altActive 없음).
    let f = control.request(&proto::Request::FetchSealed {
        window_label: Some("w-test".into()),
        pane_id: "pane-blob".into(),
    });
    assert_eq!(f["ok"], true, "{f}");
    let doc = &f["data"]["sealed"];
    assert_eq!(doc["v"], 1, "{doc}");
    assert_eq!(doc["keyId"], "k-blob");
    assert!(doc.get("altActive").is_none(), "content-agnostic envelope: {doc}");

    // 개인키 + 정합 AAD 로 개봉하면 넣은 바이트가 그대로 나온다.
    let sealed: soksak_seal::SealedBox = serde_json::from_value(doc["sealed"].clone()).unwrap();
    let aad = proto::checkpoint_aad("w-test", "pane-blob", "k-blob");
    let out = soksak_seal::open_sealed(&sk, &sealed, &aad).expect("unseal blob");
    assert_eq!(String::from_utf8_lossy(&out), payload, "stored bytes round-trip");

    // 정상 종료(kill = pane 폐기) → 봉인-블롭 산출물 삭제. 파일이 남는 경우는 데몬
    // 자신의 죽음뿐이고 그것이 cold restore 입력이다.
    let path = proto::checkpoint_path(&d.home, "w-test", "pane-blob");
    assert!(path.exists(), "sealed blob present before clean end");
    let session = created["data"]["session"].as_u64().unwrap();
    assert_eq!(control.request(&proto::Request::Kill { session })["ok"], true);
    wait_until("sealed blob removal", Duration::from_secs(10), || !path.exists());

    assert_eq!(control.request(&proto::Request::Shutdown)["ok"], true);
}

// 홈 아래 전 파일에서 평문 바이트 검색(재귀) — 소켓 등 특수 파일은 건너뛴다.
fn scan_for_plaintext(dir: &Path, needle: &[u8], hits: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            scan_for_plaintext(&p, needle, hits);
        } else if ft.is_file() {
            if let Ok(bytes) = std::fs::read(&p) {
                if bytes.windows(needle.len()).any(|w| w == needle) {
                    hits.push(p);
                }
            }
        }
    }
}

extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, sig: i32) -> i32;
}
