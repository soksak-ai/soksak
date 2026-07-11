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
use soksak_pty_proto as proto;

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

// stream 부착: hello 응답 줄까지 소비하고, 그 뒤 raw 바이트를 읽는 소켓을 돌려준다.
fn attach_stream(home: &Path, session: u64) -> (Value, UnixStream) {
    let conn = UnixStream::connect(proto::stream_socket_path(home)).unwrap();
    conn.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut w = conn.try_clone().unwrap();
    let hello = proto::Hello {
        version: Some(proto::PTYD_PROTOCOL_VERSION),
        token: token_of(home),
        client_id: "test-stream".into(),
        session: Some(session),
    };
    writeln!(w, "{}", serde_json::to_string(&hello).unwrap()).unwrap();
    // hello 응답 1줄만 바이트 단위로 소비 — 이후 raw 재생/라이브를 잃지 않는다.
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

    // 링 재생: detach 전에 흘렀던 마커가 새 부착의 선두 재생에 들어 있다.
    let (reply, mut stream) = attach_stream(&d.home, session);
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

// ── 재부착 재생 = 미러 직렬화: raw 꼬리가 아니라 그리드 합성물이다 ────────────
// 세션 출력에 질의(DA1)와 private mode 세트가 흘렀어도, 재생 바이트에는 질의가
// 실리지 않고(재응답 원천 차단) 모드는 재수화 시퀀스로 재현된다(플랜 §5.5 M2).

#[test]
fn reattach_replay_is_serialized_not_raw() {
    let d = start_daemon("serialized");
    let mut control = Control::connect(&d.home);
    let created = create(&mut control, "pane-s");
    let session = created["data"]["session"].as_u64().unwrap();
    let (reply, mut stream) = attach_stream(&d.home, session);
    assert_eq!(reply["ok"], true, "{reply}");

    // 셸이 bracketed paste 를 켜고 DA1 질의를 출력에 흘린 뒤 마커를 찍는다.
    let w = proto::Request::Write {
        session,
        data_b64: {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD
                .encode("printf '\\033[?2004h\\033[c'; echo SERIAL-MARK\n")
        },
    };
    assert_eq!(control.request(&w)["ok"], true);
    read_until(&mut stream, "SERIAL-MARK");

    // 앱 사망 모사 후 재부착 — 재생을 raw 로 수집한다.
    drop(stream);
    std::thread::sleep(Duration::from_millis(200));
    let (reply, mut stream) = attach_stream(&d.home, session);
    assert!(reply["data"]["replayBytes"].as_u64().unwrap() > 0, "{reply}");
    let replay = read_until(&mut stream, "SERIAL-MARK");

    // 질의 바이트(ESC [ c)는 재생에 실리지 않는다 — 프론트 xterm 재응답 차단.
    assert!(!replay.contains("\x1b[c"), "replay must not carry DA1: {replay:?}");
    // private mode 는 재수화 시퀀스로 재현된다.
    assert!(replay.contains("\x1b[?2004h"), "replay must rehydrate bracketed paste");

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

// ── 봉인 바이트 체크포인트(플랜 §5.5 M3): 디스크 평문 0, 개봉은 개인키만, 정상 종료 삭제 ──

#[test]
fn checkpoint_sealed_written_and_removed() {
    let d = start_daemon("ckpt");
    let (sk, pk) = soksak_seal::gen_asym_keypair();
    let pk_b64 = {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(pk)
    };
    let mut control = Control::connect(&d.home);
    let created = control.request(&proto::Request::CreateOrAttach {
        pane_id: "pane-c".into(),
        cols: 80,
        rows: 24,
        cwd: Some("/tmp".into()),
        shell: "/bin/sh".into(),
        env: vec![("TERM".into(), "dumb".into()), ("PS1".into(), "$ ".into())],
        env_remove: vec![],
        window_label: Some("w-test".into()),
        checkpoint_pk: Some(pk_b64),
        checkpoint_key_id: Some("k-test".into()),
    });
    assert_eq!(created["ok"], true, "{created}");
    let session = created["data"]["session"].as_u64().unwrap();

    // 비밀이 화면에 흐른다 — 체크포인트가 이 텍스트를 평문으로 디스크에 남기면 안 된다.
    let marker = format!("CKPT-SECRET-{}", std::process::id());
    write_line(&mut control, session, &format!("echo {marker}"));

    // 디바운스(idle 300ms) 후 체크포인트 파일이 나타난다.
    let path = proto::checkpoint_path(&d.home, "w-test", "pane-c");
    wait_until("checkpoint file", Duration::from_secs(10), || path.exists());

    // (a) 잠금 상태 디스크 평문 부재 — identity 홈 전체를 훑어 비밀 문자열이 없다.
    let mut hits = Vec::new();
    scan_for_plaintext(&d.home, marker.as_bytes(), &mut hits);
    assert!(hits.is_empty(), "plaintext screen bytes on disk: {hits:?}");

    // (b) 개인키 S + 정합 AAD 로만 열린다 — 열면 화면 페인트에 비밀이 들어 있다.
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(doc["v"], 1, "{doc}");
    assert_eq!(doc["keyId"], "k-test");
    let sealed: soksak_seal::SealedBox = serde_json::from_value(doc["sealed"].clone()).unwrap();
    let aad = proto::checkpoint_aad("w-test", "pane-c", "k-test");
    let paint = soksak_seal::open_sealed(&sk, &sealed, &aad).expect("unseal with S");
    let text = String::from_utf8_lossy(&paint);
    assert!(text.contains(&marker), "unsealed paint carries the screen: {text:?}");
    // 다른 pane 의 AAD 로는 열리지 않는다(재배치 거부).
    let wrong = proto::checkpoint_aad("w-test", "pane-x", "k-test");
    assert!(soksak_seal::open_sealed(&sk, &sealed, &wrong).is_err());

    // (c) 정상 종료(kill = pane 폐기) → 산출물 삭제.
    assert_eq!(control.request(&proto::Request::Kill { session })["ok"], true);
    wait_until("checkpoint removal", Duration::from_secs(10), || !path.exists());

    let bye = control.request(&proto::Request::Shutdown);
    assert_eq!(bye["ok"], true);
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
