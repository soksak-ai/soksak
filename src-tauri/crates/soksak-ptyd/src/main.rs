// soksak-ptyd — PTY 세션 데몬. 셸과 그 자식 프로세스를 앱 프로세스 밖에서 소유해
// 앱 종료·재시작·크래시에도 같은 pid 로 생존시키고, 재부착 시 detach 동안의 출력
// (스크롤백 링)을 재생한다. 프로세스 분리 3사유 중 "생존"(플랜 §2 축1).
//
// 경계 지불(축1): ① 버전 협상 = NDJSON hello(soksak-spec-pty judge_client)
// ② 죽음 감지 = 소켓 에러 이벤트(클라이언트/데몬 어느 쪽이 죽어도 상대 소켓이
//    EOF/에러로 즉시 안다 — 폴링 0)
// ③ 폴백+고지 = 앱 쪽 pty.rs 라우터가 소유(로컬 in-process 폴백 + activity 고지).
//
// 제어 표면 아님: 이 소켓은 PTY 데이터 평면 전용이다. 명령 표면은 코어 command
// registry 한 경로가 불변이다(플랜 §2 축1 — 수기 RPC 이중 제어 표면 금지).
//
// 소켓 2본(프로토콜별 경로, soksak-spec-pty 가 정본):
//   control  <home>/run/ptyd-p<N>.sock         NDJSON 요청/응답(hello 선행)
//   stream   <home>/run/ptyd-p<N>-stream.sock  hello 1줄 교환 후 raw PTY 출력
// 인증: <home>/run/ptyd-p<N>.token (0600) 공유 토큰 — hello 에 실어 보낸다.
//
// 재부착 재생 = 원시 출력 링(RawRing)을 from_seq 좌표부터 재생한다 — VT 해석은 코어
// 밖(사이드카)이 소유하므로 데몬은 바이트만 나른다. 화면 상태 복원(스크롤백·alt·모드)은
// 사이드카가 tee 를 소비해 미러링하고, 봉인-블롭 저장소(StoreBlob)로 체크포인트한다.
//
// 이 판의 정직한 한계 — 후속 레인 소유:
//   - Windows(named pipe/ConPTY)만 후속(M5·운명 3분기 b). 데몬 업그레이드 drain 은
//     PrepareUpgrade 로 구현됐다: 새 데몬을 fd 상속(stdio dup)으로 스폰해 PTY master 를 넘기고,
//     이전 데몬이 exit 해도 master 의 kernel refcount 가 새 데몬 dup 으로 남아 slave(셸)에
//     SIGHUP 이 가지 않는다 — 무중단(HS1/HS2).

// Pure plumbing substrate — platform-independent, unit-tested here. The unix
// daemon body wires these into the reader/stream paths.
mod ring;
mod tee;

fn main() {
    #[cfg(not(unix))]
    {
        eprintln!("soksak-ptyd: unix only in this generation (Windows lands with plan §5.5 M5)");
        std::process::exit(1);
    }
    #[cfg(unix)]
    unix::run();
}

#[cfg(unix)]
mod unix {
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::fs::File;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::io::{AsRawFd, FromRawFd, RawFd};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Condvar, Mutex};

    use base64::Engine as _;
    use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
    use serde_json::{json, Value};
    use soksak_spec_pty as proto;

    use crate::ring::RawRing;
    use crate::tee::{TeeBuf, TeeFrame};

    // Raw ring retained per session — covers the warm-handoff window (the
    // sidecar's last-consumed sequence to the plugin's attach). Kilobytes
    // suffice; a burst past it surfaces as a loud gap on the attach reply, never
    // a silent shift.
    const RING_CAP: usize = 256 * 1024;
    // Per tee-subscriber buffer — a slow subscriber past this loses data as a
    // gap, never blocking the live path.
    const TEE_BUF_CAP: usize = 1_000_000;

    static NEXT_SUB_ID: AtomicU64 = AtomicU64::new(0);

    // A tee subscriber — a framed raw copy of one session's output. Its own
    // writer thread drains `buf` to the socket; the output reader only enqueues
    // (bounded, non-blocking), so a slow subscriber never stalls the live path.
    struct TeeSub {
        id: u64,
        buf: Mutex<TeeBuf>,
        cv: Condvar,
    }

    // ── 세션 ─────────────────────────────────────────────────────────────────

    struct SessState {
        // 부착된 stream 소켓(마지막 승자). None = detached.
        attached: Option<UnixStream>,
        // attach 세대 — stream 사망 감지 스레드가 자기 세대의 부착만 해제한다
        // (새 attach 가 이미 이어받았으면 no-op).
        attach_seq: u64,
        // 플로우 컨트롤(부착 중에만 유효) — pty.rs 와 같은 워터마크.
        unacked: usize,
        paused: bool,
        closed: bool,
        // 봉인-블롭 설정 — None 이면 이 세션은 봉인 키가 없어 StoreBlob 이 fail closed
        // (데몬은 화면 바이트를 평문으로 디스크에 남기지 않는다). 봉인 정책(언제·무엇)은
        // 사이드카 소유다 — 데몬은 StoreBlob 으로 받은 바이트만 봉인·저장한다.
        ckpt: Option<CkptCfg>,
        // 원시 출력 링 + 단조 seq — warm 핸드오프 substrate. Attach{from_seq} 와 tee
        // 구독 씨앗이 이 링에서 재생한다.
        ring: RawRing,
        // tee 구독자 — 세션 출력의 프레임 사본 소비자. reader 는 여기에 비차단
        // enqueue 만 한다(느린 구독자가 라이브를 못 막는다).
        subscribers: Vec<Arc<TeeSub>>,
    }

    // 체크포인트 봉인 설정 — 수신 공개키·볼트 키 id·경로·AAD(전부 soksak-spec-pty 규약).
    #[derive(Clone)]
    struct CkptCfg {
        pk: [u8; 32],
        key_id: String,
        window: String,
        pane: String,
        path: PathBuf,
        aad: Vec<u8>,
    }

    fn make_ckpt_cfg(
        home: &std::path::Path,
        window_label: &Option<String>,
        pane_id: &str,
        pk_b64: &Option<String>,
        key_id: &Option<String>,
    ) -> Option<CkptCfg> {
        let (pk_b64, key_id) = match (pk_b64, key_id) {
            (Some(p), Some(k)) => (p, k),
            _ => return None,
        };
        let raw = base64::engine::general_purpose::STANDARD.decode(pk_b64.as_bytes()).ok()?;
        let pk: [u8; 32] = raw.try_into().ok()?;
        let window = window_label.clone().unwrap_or_default();
        Some(CkptCfg {
            pk,
            key_id: key_id.clone(),
            window: window.clone(),
            pane: pane_id.to_string(),
            path: proto::checkpoint_path(home, &window, pane_id),
            aad: proto::checkpoint_aad(&window, pane_id, key_id),
        })
    }

    fn ckpt_ts_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    // 봉인 문서 tmp+rename 원자 쓰기 — 찢어진 파일이 정본 자리를 차지하지 못한다.
    // write_checkpoint(미러 페인트)·store_sealed_blob(임의 바이트) 공통 하부.
    fn write_sealed_doc_atomic(path: &std::path::Path, session_id: u64, doc: &Value) -> Result<(), String> {
        let dir = path.parent().ok_or("sealed-blob path has no parent")?;
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        let tmp = dir.join(format!(".ckpt-tmp-{}-{session_id}", std::process::id()));
        let body = serde_json::to_vec(doc).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())
    }

    // 내용 불가지 봉인-블롭 쓰기 — 호출자가 준 임의 바이트를 봉인해 저장한다. 바이트의
    // 의미는 호출자(사이드카)의 것이고, 데몬은 봉인·원자쓰기만 소유한다(터미널 메타는
    // 기록하지 않는다). 받은 바이트를 그대로 봉인한다(StoreBlob).
    fn store_sealed_blob(cfg: &CkptCfg, session_id: u64, bytes: &[u8]) -> Result<(), String> {
        let sealed = soksak_seal::seal_to(&cfg.pk, bytes, &cfg.aad)?;
        let doc = json!({
            "v": 1,
            "keyId": cfg.key_id,
            "window": cfg.window,
            "pane": cfg.pane,
            "ts": ckpt_ts_ms(),
            "sealed": sealed,
        });
        write_sealed_doc_atomic(&cfg.path, session_id, &doc)
    }

    // A session's PTY master — owned (this daemon opened it via openpty) or
    // adopted (inherited raw fd from a predecessor during a live handoff). The
    // adopted arm reimplements the master ops directly on the raw fd, because
    // portable_pty can't wrap an existing fd (it only forkpty's its own). HS2:
    // the adopted fd IS the same kernel fd the predecessor held (an inherited
    // dup), so the shell never sees a hangup across the daemon upgrade.
    enum MasterHandle {
        Owned(Box<dyn MasterPty + Send>),
        Adopted(File),
    }

    impl MasterHandle {
        fn resize(&self, size: PtySize) -> Result<(), String> {
            match self {
                MasterHandle::Owned(m) => m.resize(size).map_err(|e| e.to_string()),
                MasterHandle::Adopted(f) => {
                    let ws = libc::winsize {
                        ws_row: size.rows,
                        ws_col: size.cols,
                        ws_xpixel: size.pixel_width,
                        ws_ypixel: size.pixel_height,
                    };
                    let r = unsafe { libc::ioctl(f.as_raw_fd(), libc::TIOCSWINSZ, &ws) };
                    if r == 0 { Ok(()) } else { Err(std::io::Error::last_os_error().to_string()) }
                }
            }
        }
        fn process_group_leader(&self) -> Option<libc::pid_t> {
            match self {
                MasterHandle::Owned(m) => m.process_group_leader(),
                MasterHandle::Adopted(f) => {
                    let pg = unsafe { libc::tcgetpgrp(f.as_raw_fd()) };
                    if pg >= 0 { Some(pg) } else { None }
                }
            }
        }
        fn as_raw_fd(&self) -> Option<RawFd> {
            match self {
                MasterHandle::Owned(m) => m.as_raw_fd(),
                MasterHandle::Adopted(f) => Some(f.as_raw_fd()),
            }
        }
    }

    // A session's child — owned (we spawned it; wait() reaps the zombie) or
    // adopted (the shell was detached under init before this daemon existed, so
    // this process is NOT its parent and can only observe liveness by pid).
    enum ChildHandle {
        Owned(Box<dyn Child + Send + Sync>),
        Adopted(u32),
    }

    impl ChildHandle {
        fn kill(&mut self) -> std::io::Result<()> {
            match self {
                ChildHandle::Owned(c) => c.kill(),
                ChildHandle::Adopted(pid) => {
                    let r = unsafe { libc::kill(*pid as libc::pid_t, libc::SIGKILL) };
                    if r == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
                }
            }
        }
        // Reap/observe exit. Owned reaps the zombie; adopted polls pid liveness
        // (the reader already saw EOF, so the shell is gone — returns promptly).
        // Neither path's return value is consumed by callers.
        fn wait(&mut self) {
            match self {
                ChildHandle::Owned(c) => {
                    let _ = c.wait();
                }
                ChildHandle::Adopted(pid) => {
                    while unsafe { libc::kill(*pid as libc::pid_t, 0) } == 0 {
                        std::thread::sleep(std::time::Duration::from_millis(20));
                    }
                }
            }
        }
    }

    struct Session {
        id: u64,
        pane_id: String,
        window_label: Option<String>,
        generation: u64,
        shell_pid: u32,
        master: Mutex<MasterHandle>,
        writer: Mutex<Box<dyn Write + Send>>,
        child: Mutex<ChildHandle>,
        st: Mutex<SessState>,
        cv: Condvar,
    }

    impl Session {
        fn info(&self) -> proto::SessionInfo {
            proto::SessionInfo {
                session: self.id,
                pane_id: self.pane_id.clone(),
                shell_pid: self.shell_pid,
                generation: self.generation,
                window_label: self.window_label.clone(),
            }
        }

        // detach(명시·stream 사망 공통): 부착 해제 + 플로우 해제. 링은 계속 쌓인다.
        fn detach(&self) {
            let mut st = self.st.lock().unwrap();
            st.attached = None;
            st.unacked = 0;
            st.paused = false;
            self.cv.notify_all();
        }
    }

    struct Registry {
        sessions: Mutex<HashMap<u64, Arc<Session>>>,
        next_id: AtomicU64,
        next_gen: AtomicU64,
        // identity 홈 — 체크포인트 경로 파생(proto 규약)의 입력.
        home: PathBuf,
        // 라이브 업그레이드(PrepareUpgrade) 진행 중 — mutation 요청을 거부해
        // 새 데몬에 넘길 세션 집합을 고정한다(commit 전 rollback 가능).
        handoff: AtomicBool,
    }

    impl Registry {
        // 재부착 키 = (window_label, pane_id). pane id 는 창 안에서만 유일하다(창별
        // 순차 뷰 id — 실측: 여러 창이 각자 v2 를 가진다). 창 라벨이 네임스페이스다.
        fn by_pane(&self, window: Option<&str>, pane: &str) -> Option<Arc<Session>> {
            self.sessions
                .lock()
                .unwrap()
                .values()
                .find(|s| {
                    s.pane_id == pane
                        && s.window_label.as_deref() == window
                        && !s.st.lock().unwrap().closed
                })
                .cloned()
        }
        fn get(&self, id: u64) -> Option<Arc<Session>> {
            self.sessions.lock().unwrap().get(&id).cloned()
        }
        fn remove(&self, id: u64) {
            self.sessions.lock().unwrap().remove(&id);
        }
    }

    // ── 부트 ─────────────────────────────────────────────────────────────────

    pub fn run() {
        // 라이브 업그레이드 새 데몬 진입 — 이전 데몬이 `--handoff <snapshot>` 로 스폰했다. 상속받은
        // PTY master fd 로 세션을 adopt 하고, 이전 데몬의 exit 를 기다린 뒤 소켓을 넘겨받는다(§ do_handoff).
        let args: Vec<String> = std::env::args().collect();
        if args.get(1).map(|s| s == "--handoff").unwrap_or(false) {
            run_handoff_adopt(args.get(2).map(|s| s.as_str()).unwrap_or(""));
            return;
        }

        // identity 홈은 스폰한 앱이 명시한다 — 데몬이 identity 를 추측하지 않는다.
        let home = match std::env::var("SOKSAK_HOME") {
            Ok(h) if !h.is_empty() => PathBuf::from(h),
            _ => {
                eprintln!("soksak-ptyd: SOKSAK_HOME required (the app supplies it on spawn)");
                std::process::exit(2);
            }
        };
        let run_dir = proto::run_dir(&home);
        if let Err(e) = std::fs::create_dir_all(&run_dir) {
            eprintln!("soksak-ptyd: cannot create {run_dir:?}: {e}");
            std::process::exit(2);
        }
        let _ = std::fs::set_permissions(&run_dir, std::fs::Permissions::from_mode(0o700));

        let token = load_or_create_token(&home);
        let control_path = proto::control_socket_path(&home);
        let stream_path = proto::stream_socket_path(&home);

        // 싱글턴: control 소켓에 살아있는 응답자가 있으면 물러난다(연결 프로브).
        if UnixStream::connect(&control_path).is_ok() {
            eprintln!("soksak-ptyd: another daemon serves {control_path:?}; exiting");
            std::process::exit(0);
        }

        let reg = Arc::new(Registry {
            sessions: Mutex::new(HashMap::new()),
            handoff: AtomicBool::new(false),
            next_id: AtomicU64::new(0),
            next_gen: AtomicU64::new(0),
            home,
        });
        serve(reg, token, control_path, stream_path);
    }

    // 소켓 bind + accept 루프 — normal 부트와 handoff 새 데몬이 공유한다. 호출 전에 이전 데몬이
    // 없음이 보장돼야 한다(normal=싱글턴 프로브, handoff=이전 데몬 exit 대기).
    fn serve(reg: Arc<Registry>, token: String, control_path: PathBuf, stream_path: PathBuf) {
        let _ = std::fs::remove_file(&control_path);
        let _ = std::fs::remove_file(&stream_path);
        let control = match UnixListener::bind(&control_path) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("soksak-ptyd: bind {control_path:?} failed: {e}");
                std::process::exit(2);
            }
        };
        let stream = match UnixListener::bind(&stream_path) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("soksak-ptyd: bind {stream_path:?} failed: {e}");
                std::process::exit(2);
            }
        };
        for p in [&control_path, &stream_path] {
            let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600));
        }
        eprintln!(
            "soksak-ptyd: protocol {} pid {} serving {:?}",
            proto::PTYD_PROTOCOL_VERSION,
            std::process::id(),
            control_path.parent().unwrap_or(&control_path)
        );

        // stream accept 루프(부착) — 별도 스레드.
        {
            let reg = reg.clone();
            let token = token.clone();
            std::thread::spawn(move || {
                for conn in stream.incoming().flatten() {
                    let reg = reg.clone();
                    let token = token.clone();
                    std::thread::spawn(move || handle_stream(conn, &reg, &token));
                }
            });
        }
        // control accept 루프 — 메인 스레드.
        for conn in control.incoming().flatten() {
            let reg = reg.clone();
            let token = token.clone();
            std::thread::spawn(move || handle_control(conn, &reg, &token));
        }
    }

    // 라이브 업그레이드 새 데몬 진입점(§ do_handoff 의 상대). 이전 데몬이 상속시킨 PTY master
    // fd(4..N)로 세션을 adopt 하고, IPC(fd 3)로 adopt-ack 를 보낸 뒤 이전 데몬의 exit(control 소켓
    // 소멸)를 기다렸다가 소켓을 넘겨받는다. adopted 세션의 child 는 이 데몬의 자식이 아니므로 pid
    // liveness 로 관찰한다(ChildHandle::Adopted). ring 은 새로 시작하고 앱 재부착의 warm gap 이 흡수한다.
    fn run_handoff_adopt(snap_path: &str) {
        let home = match std::env::var("SOKSAK_HOME") {
            Ok(h) if !h.is_empty() => PathBuf::from(h),
            _ => std::process::exit(2),
        };
        let doc = match std::fs::read(snap_path) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("soksak-ptyd: handoff snapshot read {snap_path}: {e}");
                std::process::exit(2);
            }
        };
        let snap: proto::HandoffSnapshot = match serde_json::from_slice(&doc) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("soksak-ptyd: handoff snapshot parse: {e}");
                std::process::exit(2);
            }
        };
        let max_id = snap.sessions.iter().map(|s| s.id).max().unwrap_or(0);
        let max_gen = snap.sessions.iter().map(|s| s.generation).max().unwrap_or(0);
        let reg = Arc::new(Registry {
            sessions: Mutex::new(HashMap::new()),
            handoff: AtomicBool::new(false),
            next_id: AtomicU64::new(max_id),
            next_gen: AtomicU64::new(max_gen),
            home: home.clone(),
        });
        for hs in &snap.sessions {
            // 상속받은 master fd 를 adopt — 이전 데몬이 가졌던 그 kernel fd(inherited dup)라 셸의
            // slave 측은 master fd 소유자가 바뀐 것에 영향받지 않는다(HS2).
            let master_file = unsafe { File::from_raw_fd(hs.fd_index as RawFd) };
            let reader: Box<dyn Read + Send> = match master_file.try_clone() {
                Ok(f) => Box::new(f),
                Err(e) => {
                    eprintln!("soksak-ptyd: adopt fd {} reader: {e}", hs.fd_index);
                    continue;
                }
            };
            let writer: Box<dyn Write + Send> = match master_file.try_clone() {
                Ok(f) => Box::new(f),
                Err(e) => {
                    eprintln!("soksak-ptyd: adopt fd {} writer: {e}", hs.fd_index);
                    continue;
                }
            };
            let session = Arc::new(Session {
                id: hs.id,
                pane_id: hs.pane_id.clone(),
                window_label: hs.window_label.clone(),
                generation: hs.generation,
                shell_pid: hs.shell_pid,
                master: Mutex::new(MasterHandle::Adopted(master_file)),
                writer: Mutex::new(writer),
                child: Mutex::new(ChildHandle::Adopted(hs.shell_pid)),
                st: Mutex::new(SessState {
                    attached: None,
                    attach_seq: 0,
                    unacked: 0,
                    paused: false,
                    closed: false,
                    ckpt: None,
                    ring: RawRing::new(RING_CAP),
                    subscribers: Vec::new(),
                }),
                cv: Condvar::new(),
            });
            reg.sessions.lock().unwrap().insert(hs.id, session.clone());
            spawn_reader(&reg, session, reader);
        }
        // adopt-ack — 이전 데몬이 이걸 받고 exit 한다(fd 3 = 이전 데몬이 넘긴 IPC 소켓).
        {
            let mut ipc = unsafe { UnixStream::from_raw_fd(3) };
            let _ = ipc.write_all(b"ok\n");
            let _ = ipc.flush();
        }
        // 이전 데몬 exit 대기 — control 소켓 연결이 끊기면 이전 데몬이 물러난 것(소켓 bind race 회피).
        let control_path = proto::control_socket_path(&home);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while UnixStream::connect(&control_path).is_ok() {
            if std::time::Instant::now() >= deadline {
                break; // 이전 데몬이 안 물러나도 강행 — bind 가 실패하면 그때 exit.
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let token = load_or_create_token(&home);
        let stream_path = proto::stream_socket_path(&home);
        serve(reg, token, control_path, stream_path);
    }

    fn load_or_create_token(home: &std::path::Path) -> String {
        let path = proto::token_path(home);
        if let Ok(t) = std::fs::read_to_string(&path) {
            let t = t.trim().to_string();
            if !t.is_empty() {
                return t;
            }
        }
        // /dev/urandom 32바이트 → hex. 새 crypto 의존 없이 OS 엔트로피만 쓴다.
        let mut buf = [0u8; 32];
        if std::fs::File::open("/dev/urandom")
            .and_then(|mut f| f.read_exact(&mut buf))
            .is_err()
        {
            eprintln!("soksak-ptyd: cannot read /dev/urandom");
            std::process::exit(2);
        }
        let token: String = buf.iter().map(|b| format!("{b:02x}")).collect();
        if let Err(e) = std::fs::write(&path, &token) {
            eprintln!("soksak-ptyd: cannot write token {path:?}: {e}");
            std::process::exit(2);
        }
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        token
    }

    // hello 1줄을 읽고 판정한다. 성공 시 Some(Hello) — 실패는 이 함수가 거절 응답을
    // 쓰고 None. reader 는 hello 줄만 소비한다(이후 바이트 무손실).
    fn read_hello<R: BufRead, W: Write>(
        reader: &mut R,
        writer: &mut W,
        token: &str,
    ) -> Option<proto::Hello> {
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() || line.trim().is_empty() {
            return None;
        }
        let hello: proto::Hello = match serde_json::from_str(line.trim()) {
            Ok(h) => h,
            Err(e) => {
                let _ = writeln!(writer, "{}", proto::err_reply("INVALID_PARAMS", &format!("hello parse: {e}")));
                return None;
            }
        };
        match proto::judge_client(hello.version) {
            proto::Compat::Compatible => {}
            verdict => {
                let msg = proto::skew_sentence(
                    verdict,
                    "soksak-ptyd",
                    "the client",
                    None,
                    proto::Lang::En,
                )
                .unwrap_or_else(|| "protocol skew".into());
                let _ = writeln!(writer, "{}", proto::err_reply("VERSION_SKEW", &msg));
                return None;
            }
        }
        if hello.token != token {
            let _ = writeln!(writer, "{}", proto::err_reply("UNAUTHORIZED", "bad token"));
            return None;
        }
        Some(hello)
    }

    // ── control 연결 ─────────────────────────────────────────────────────────

    fn handle_control(conn: UnixStream, reg: &Arc<Registry>, token: &str) {
        let Ok(read_half) = conn.try_clone() else { return };
        let mut reader = BufReader::new(read_half);
        let mut writer = conn;
        let Some(_hello) = read_hello(&mut reader, &mut writer, token) else { return };
        let ok = proto::ok_reply(json!({
            "version": proto::PTYD_PROTOCOL_VERSION,
            "pid": std::process::id(),
        }));
        if writeln!(writer, "{ok}").is_err() {
            return;
        }
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            let reply = match serde_json::from_str::<proto::Request>(line.trim()) {
                Err(e) => proto::err_reply("INVALID_PARAMS", &format!("request parse: {e}")),
                Ok(req) => handle_request(req, reg),
            };
            if writeln!(writer, "{reply}").is_err() {
                break;
            }
        }
        // 연결 종료(클라이언트/앱 사망 포함) — 세션은 그대로 산다. stream 부착 해제는
        // stream 소켓 자신의 EOF 가 처리한다(이벤트 — 폴링 0).
    }

    fn handle_request(req: proto::Request, reg: &Arc<Registry>) -> Value {
        use proto::Request as R;
        match req {
            R::CreateOrAttach {
                pane_id,
                cols,
                rows,
                cwd,
                shell,
                env,
                env_remove,
                window_label,
                checkpoint_pk,
                checkpoint_key_id,
            } => {
                if let Some(s) = reg.by_pane(window_label.as_deref(), &pane_id) {
                    // 재부착 — 키 없이 태어난 세션이면 지금 온 체크포인트 키를 입양한다
                    // (암호화를 세션 도중 켠 경우의 공백 봉합).
                    if let Some(cfg) =
                        make_ckpt_cfg(&reg.home, &window_label, &pane_id, &checkpoint_pk, &checkpoint_key_id)
                    {
                        let mut st = s.st.lock().unwrap();
                        if st.ckpt.is_none() {
                            st.ckpt = Some(cfg);
                        }
                    }
                    let mut d = serde_json::to_value(s.info()).unwrap_or_default();
                    d["attached"] = json!(true);
                    return proto::ok_reply(d);
                }
                let ckpt =
                    make_ckpt_cfg(&reg.home, &window_label, &pane_id, &checkpoint_pk, &checkpoint_key_id);
                match spawn_session(reg, pane_id, cols, rows, cwd, shell, env, env_remove, window_label, ckpt)
                {
                    Ok(s) => {
                        let mut d = serde_json::to_value(s.info()).unwrap_or_default();
                        d["attached"] = json!(false);
                        proto::ok_reply(d)
                    }
                    Err(e) => proto::err_reply("IO", &e),
                }
            }
            R::Write { session, data_b64 } => with_session(reg, session, |s| {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data_b64.as_bytes())
                    .map_err(|e| format!("base64: {e}"))?;
                let mut w = s.writer.lock().unwrap();
                w.write_all(&bytes).and_then(|_| w.flush()).map_err(|e| e.to_string())?;
                Ok(json!({}))
            }),
            R::Resize { session, cols, rows } => with_session(reg, session, |s| {
                s.master
                    .lock()
                    .unwrap()
                    .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
                    .map_err(|e| e.to_string())?;
                // 격자 크기는 사이드카 미러가 tee 소비 중 자체 추적한다(데몬은 바이트만).
                Ok(json!({}))
            }),
            R::Ack { session, bytes } => with_session(reg, session, |s| {
                let mut st = s.st.lock().unwrap();
                st.unacked = st.unacked.saturating_sub(bytes as usize);
                if st.paused && st.unacked <= proto::LOW_WATERMARK {
                    st.paused = false;
                    s.cv.notify_all();
                }
                Ok(json!({}))
            }),
            R::Kill { session } => with_session(reg, session, |s| {
                let _ = s.child.lock().unwrap().kill();
                // reader 가 EOF 로 정리를 마감한다. 플로우 정지도 깨워 준다.
                let mut st = s.st.lock().unwrap();
                st.paused = false;
                s.cv.notify_all();
                drop(st);
                Ok(json!({}))
            }),
            R::Detach { session } => with_session(reg, session, |s| {
                s.detach();
                Ok(json!({}))
            }),
            R::KillByWindow { window_label } => {
                let victims: Vec<Arc<Session>> = reg
                    .sessions
                    .lock()
                    .unwrap()
                    .values()
                    .filter(|s| s.window_label.as_deref() == Some(window_label.as_str()))
                    .cloned()
                    .collect();
                let n = victims.len();
                for s in victims {
                    let _ = s.child.lock().unwrap().kill();
                    let mut st = s.st.lock().unwrap();
                    st.paused = false;
                    s.cv.notify_all();
                }
                proto::ok_reply(json!({ "killed": n }))
            }
            R::ListSessions => {
                let infos: Vec<proto::SessionInfo> =
                    reg.sessions.lock().unwrap().values().map(|s| s.info()).collect();
                proto::ok_reply(json!({ "sessions": infos }))
            }
            // 봉인-블롭 저장(내용 불가지) — 라이브 세션의 봉인 키로 임의 바이트를 봉인해
            // 원자 쓰기. 키 없는 세션은 fail closed(데몬은 평문 화면 바이트를 안 남긴다).
            R::StoreBlob { window_label, pane_id, bytes_b64 } => {
                let bytes = match base64::engine::general_purpose::STANDARD.decode(bytes_b64.as_bytes()) {
                    Ok(b) => b,
                    Err(e) => return proto::err_reply("INVALID_PARAMS", &format!("base64: {e}")),
                };
                match reg.by_pane(window_label.as_deref(), &pane_id) {
                    None => proto::err_reply("NOT_FOUND", &format!("no live session for pane {pane_id}")),
                    Some(s) => {
                        let cfg = s.st.lock().unwrap().ckpt.clone();
                        match cfg {
                            None => proto::err_reply(
                                "NO_CHECKPOINT_KEY",
                                "session has no seal key (fail closed)",
                            ),
                            Some(cfg) => match store_sealed_blob(&cfg, s.id, &bytes) {
                                Ok(()) => proto::ok_reply(json!({ "stored": bytes.len() })),
                                Err(e) => proto::err_reply("IO", &e),
                            },
                        }
                    }
                }
            }
            // 봉인-블롭 조회(내용 불가지) — 라이브 세션 없이 디스크에서 읽는다(살아남은
            // 블롭이 cold restore 입력). 호출자가 vault 로 개봉한다.
            R::FetchSealed { window_label, pane_id } => {
                let path =
                    proto::checkpoint_path(&reg.home, window_label.as_deref().unwrap_or(""), &pane_id);
                match std::fs::read(&path) {
                    Ok(body) => match serde_json::from_slice::<Value>(&body) {
                        Ok(doc) => proto::ok_reply(json!({ "sealed": doc })),
                        Err(e) => proto::err_reply("IO", &format!("sealed blob parse: {e}")),
                    },
                    Err(_) => proto::err_reply("NOT_FOUND", "no sealed blob"),
                }
            }
            // pane id 첫 매치(창 무관) — 앱의 pty_pane_pid 명령이 창 문맥 없이 pane 만
            // 받는 기존 의미론과 동형이다(교차 창 동명 pane 의 모호성도 그대로 이어진다).
            R::PanePid { pane_id } => {
                let found = reg
                    .sessions
                    .lock()
                    .unwrap()
                    .values()
                    .find(|s| s.pane_id == pane_id && !s.st.lock().unwrap().closed)
                    .cloned();
                match found {
                    None => proto::err_reply("NOT_FOUND", &format!("no session for pane {pane_id}")),
                    Some(s) => {
                        let pid = s.master.lock().unwrap().process_group_leader();
                        proto::ok_reply(json!({ "pid": pid }))
                    }
                }
            }
            R::Ping => {
                let n = reg.sessions.lock().unwrap().len();
                proto::ok_reply(json!({ "pid": std::process::id(), "sessions": n }))
            }
            R::Shutdown => {
                let victims: Vec<Arc<Session>> =
                    reg.sessions.lock().unwrap().values().cloned().collect();
                for s in &victims {
                    let _ = s.child.lock().unwrap().kill();
                }
                // 응답을 쓸 시간을 주기 위해 별도 스레드에서 잠깐 뒤 종료한다.
                std::thread::spawn(|| {
                    std::thread::sleep(std::time::Duration::from_millis(150));
                    std::process::exit(0);
                });
                proto::ok_reply(json!({ "killed": victims.len() }))
            }
            R::PrepareUpgrade { new_bin } => do_handoff(reg, &new_bin),
        }
    }

    // 라이브 업그레이드(PrepareUpgrade) — 이 세대의 라이브 PTY 세션을 새 데몬(스테이징된 새
    // 바이너리)으로 넘긴다. HS1(무중단)·HS2(fd 소유 불변식). 각 세션의 PTY master fd 를 새 데몬에
    // fd 상속(dup)으로 넘기고, 세션 메타+ring seq 스냅샷을 원자 기록한 뒤 새 데몬을 스폰한다. 새
    // 데몬이 adopt-ack 하면 이 데몬은 exit 한다 — 이 데몬 쪽 fd 는 닫히지만 master 의 kernel refcount
    // 가 새 데몬 dup 으로 남아 slave(셸)에 SIGHUP 이 가지 않는다. 미세 gap 은 소비자가 ring
    // seq(from_seq)부터 이어 읽어 흡수하므로 reader pause 가 불필요하다. ack 전 실패면 handoff 를
    // 해제하고 새 데몬을 종료한 뒤 계속 서빙한다(rollback, master fd 는 여전히 이 데몬 소유).
    // supervisor 는 이 데몬의 소켓 EOF(exit)로 handoff 완료를 알고 재연결한다.
    fn do_handoff(reg: &Arc<Registry>, new_bin: &str) -> Value {
        use std::os::unix::process::CommandExt;
        reg.handoff.store(true, Ordering::SeqCst);
        // 세션 메타 스냅샷 + 새 데몬 상속 fd 맵(fd 4..N).
        let mut snap = Vec::new();
        let mut fd_map: Vec<(RawFd, RawFd)> = Vec::new(); // (target, source)
        let mut fd_index = 4u32;
        {
            let sessions = reg.sessions.lock().unwrap();
            for s in sessions.values() {
                if s.st.lock().unwrap().closed {
                    continue;
                }
                let raw = match s.master.lock().unwrap().as_raw_fd() {
                    Some(fd) => fd,
                    None => continue,
                };
                let ring_seq = s.st.lock().unwrap().ring.seq();
                snap.push(proto::HandoffSession {
                    id: s.id,
                    pane_id: s.pane_id.clone(),
                    window_label: s.window_label.clone(),
                    generation: s.generation,
                    shell_pid: s.shell_pid,
                    fd_index,
                    ring_seq,
                });
                fd_map.push((fd_index as RawFd, raw));
                fd_index += 1;
            }
        }
        let fail = |reg: &Arc<Registry>, msg: &str| -> Value {
            reg.handoff.store(false, Ordering::SeqCst);
            proto::err_reply("HANDOFF_FAILED", msg)
        };
        // 스냅샷 원자 기록(tmp+rename).
        let snap_path = proto::run_dir(&reg.home).join("ptyd-handoff.json");
        let tmp = snap_path.with_extension("tmp");
        let doc = match serde_json::to_vec(&proto::HandoffSnapshot { sessions: snap }) {
            Ok(d) => d,
            Err(e) => return fail(reg, &format!("snapshot encode: {e}")),
        };
        if std::fs::write(&tmp, &doc)
            .and_then(|_| std::fs::rename(&tmp, &snap_path))
            .is_err()
        {
            return fail(reg, "snapshot write failed");
        }
        // IPC socketpair — 새 데몬 adopt-ack 채널(fd 3).
        let (parent_ipc, child_ipc) = match UnixStream::pair() {
            Ok(p) => p,
            Err(e) => return fail(reg, &format!("socketpair: {e}")),
        };
        // 새 데몬 스폰 — pre_exec 로 IPC 를 fd 3, 각 master fd 를 4..N 에 dup2(exec 를 넘는 상속).
        let child_ipc_raw = child_ipc.as_raw_fd();
        let fd_map_c = fd_map.clone();
        let mut cmd = std::process::Command::new(new_bin);
        cmd.arg("--handoff").arg(&snap_path);
        unsafe {
            cmd.pre_exec(move || {
                if libc::dup2(child_ipc_raw, 3) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                for (target, source) in &fd_map_c {
                    if libc::dup2(*source, *target) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return fail(reg, &format!("spawn new daemon: {e}")),
        };
        drop(child_ipc); // 현 데몬은 IPC 의 자기 쪽 끝만 남긴다(자식 쪽은 spawn 이 fd 3 으로 상속시켰다).
        // adopt-ack 대기(5s). 새 데몬이 모든 fd 를 adopt 하면 한 줄("ok\n")을 보낸다.
        let _ = parent_ipc.set_read_timeout(Some(std::time::Duration::from_secs(5)));
        let mut ack = String::new();
        let acked = BufReader::new(parent_ipc)
            .read_line(&mut ack)
            .map(|n| n > 0)
            .unwrap_or(false);
        if !acked {
            let _ = child.kill(); // rollback — 새 데몬 거두고 계속 서빙(master fd 는 우리 것, HS2).
            return fail(reg, "new daemon did not ack");
        }
        // commit — 새 데몬이 fd 를 adopt 했다. exit(0) 시 이 데몬 쪽 fd 는 닫히지만 master 의 kernel
        // refcount 는 새 데몬 dup 으로 남아 slave(셸)에 SIGHUP 이 없다. 어떤 세션에도 시그널을
        // 보내지 않는다(HS2). supervisor 는 소켓 EOF 로 재연결한다.
        std::process::exit(0);
    }

    fn with_session(
        reg: &Arc<Registry>,
        id: u64,
        f: impl FnOnce(&Arc<Session>) -> Result<Value, String>,
    ) -> Value {
        match reg.get(id) {
            None => proto::err_reply("NOT_FOUND", &format!("no session {id}")),
            Some(s) => match f(&s) {
                Ok(d) => proto::ok_reply(d),
                Err(e) => proto::err_reply("IO", &e),
            },
        }
    }

    // ── 세션 스폰 + reader ────────────────────────────────────────────────────

    #[allow(clippy::too_many_arguments)]
    fn spawn_session(
        reg: &Arc<Registry>,
        pane_id: String,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        shell: String,
        env: Vec<(String, String)>,
        env_remove: Vec<String>,
        window_label: Option<String>,
        ckpt: Option<CkptCfg>,
    ) -> Result<Arc<Session>, String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;

        let mut cmd = CommandBuilder::new(&shell);
        for k in &env_remove {
            cmd.env_remove(k);
        }
        for (k, v) in &env {
            cmd.env(k, v);
        }
        if let Some(cwd) = &cwd {
            cmd.cwd(cwd);
        }

        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        // slave 는 더 이상 불필요 — 닫아야 자식 종료 시 master 가 EOF 를 받는다.
        drop(pair.slave);
        let shell_pid = child.process_id().unwrap_or(0);

        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        let id = reg.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let generation = reg.next_gen.fetch_add(1, Ordering::SeqCst) + 1;
        let session = Arc::new(Session {
            id,
            pane_id,
            window_label,
            generation,
            shell_pid,
            master: Mutex::new(MasterHandle::Owned(pair.master)),
            writer: Mutex::new(writer),
            child: Mutex::new(ChildHandle::Owned(child)),
            st: Mutex::new(SessState {
                attached: None,
                attach_seq: 0,
                unacked: 0,
                paused: false,
                closed: false,
                ckpt,
                ring: RawRing::new(RING_CAP),
                subscribers: Vec::new(),
            }),
            cv: Condvar::new(),
        });
        reg.sessions.lock().unwrap().insert(id, session.clone());

        spawn_reader(reg, session.clone(), reader);
        Ok(session)
    }

    // reader 스레드: PTY master 출력 → 링(seq)+tee 사본+(부착 시) stream 소켓. EOF 가 세션 정리의
    // 단일 지점이다. owned(spawn_session) 세션과 adopted(handoff 새 데몬) 세션이 공유한다 —
    // adopted 도 같은 SessState/ring/tee 를 쓰므로 재부착 재생·체크포인트가 그대로 성립한다.
    fn spawn_reader(reg: &Arc<Registry>, session: Arc<Session>, mut reader: Box<dyn Read + Send>) {
        let reg = reg.clone();
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 8192];
            loop {
                // 부착 중 플로우 정지면 ack/detach 로 깨어날 때까지 대기.
                {
                    let mut st = session.st.lock().unwrap();
                    while st.paused && st.attached.is_some() {
                        st = session.cv.wait(st).unwrap();
                    }
                }
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break, // EOF = 셸 종료(또는 kill)
                    Ok(n) => {
                        let mut st = session.st.lock().unwrap();
                        let seq0 = st.ring.seq();
                        st.ring.push(&buf[..n]);
                        if !st.subscribers.is_empty() {
                            for sub in &st.subscribers {
                                sub.buf.lock().unwrap().push_data(seq0, &buf[..n]);
                                sub.cv.notify_one();
                            }
                        }
                        if let Some(s) = st.attached.as_mut() {
                            if s.write_all(&buf[..n]).is_err() {
                                st.attached = None;
                                st.unacked = 0;
                                st.paused = false;
                            } else {
                                st.unacked += n;
                                if st.unacked >= proto::HIGH_WATERMARK {
                                    st.paused = true;
                                }
                            }
                        }
                    }
                }
            }
            // 세션 마감: 부착 스트림을 닫아 EOF 전달, 봉인-블롭 정리, 등록 제거.
            {
                let mut st = session.st.lock().unwrap();
                st.closed = true;
                if let Some(s) = st.attached.take() {
                    let _ = s.shutdown(std::net::Shutdown::Both);
                }
                if let Some(cfg) = &st.ckpt {
                    let _ = std::fs::remove_file(&cfg.path);
                }
                session.cv.notify_all();
            }
            session.child.lock().unwrap().wait();
            reg.remove(session.id);
        });
    }

    // ── stream 연결(부착) ─────────────────────────────────────────────────────

    fn handle_stream(conn: UnixStream, reg: &Arc<Registry>, token: &str) {
        let Ok(read_half) = conn.try_clone() else { return };
        let mut reader = BufReader::new(read_half);
        let mut writer = conn;
        let Some(hello) = read_hello(&mut reader, &mut writer, token) else { return };
        let Some(sid) = hello.session else {
            let _ = writeln!(writer, "{}", proto::err_reply("INVALID_PARAMS", "stream hello requires session"));
            return;
        };
        let Some(session) = reg.get(sid) else {
            let _ = writeln!(writer, "{}", proto::err_reply("NOT_FOUND", &format!("no session {sid}")));
            return;
        };

        // 구독(tee) 스트림 — 라이브 attach 가 아니라 프레임 사본 소비자. 별 경로.
        if hello.subscribe {
            handle_subscribe(session, writer, reader);
            return;
        }

        // hello 확인 응답 1줄 → 이후 raw 바이트로 전환(재생 → 라이브).
        let my_seq;
        {
            let mut st = session.st.lock().unwrap();
            if st.closed {
                let _ = writeln!(writer, "{}", proto::err_reply("NOT_FOUND", "session closed"));
                return;
            }
            // 재생 경로(세션 락 안에서 원자 — reader 가 끼어들어 순서를 섞지 못한다):
            //   from_seq 없음 = 재생 없이 라이브 부착(미러 방출됨 — 화면 복원 페인트는
            //     사이드카·플러그인 소유). replayBytes 0 을 알리고 곧장 라이브로 넘어간다.
            //   from_seq 있음 = 원시 링을 그 seq 부터 재생(레이스-프리 핸드오프 좌표).
            //     evict 로 그 seq 가 사라졌으면 gap 을 응답에 실어 유실을 고지한다.
            match hello.from_seq {
                None => {
                    let ok = proto::ok_reply(json!({ "session": sid, "replayBytes": 0 }));
                    if writeln!(writer, "{ok}").is_err() {
                        return;
                    }
                }
                Some(from) => {
                    let (gap, tail) = st.ring.since(from);
                    let served = st.ring.start_seq().max(from);
                    let mut d = json!({
                        "session": sid,
                        "servedFromSeq": served,
                        "replayBytes": tail.len(),
                    });
                    if let Some((f, t)) = gap {
                        d["gap"] = json!({ "fromSeq": f, "toSeq": t });
                    }
                    let ok = proto::ok_reply(d);
                    if writeln!(writer, "{ok}").is_err() {
                        return;
                    }
                    if writer.write_all(&tail).is_err() {
                        return;
                    }
                }
            }
            st.attach_seq += 1;
            my_seq = st.attach_seq;
            // 이전 부착(있으면)은 조용히 대체된다 — 마지막 승자 규칙.
            st.attached = Some(match writer.try_clone() {
                Ok(w) => w,
                Err(_) => return,
            });
            st.unacked = 0;
            st.paused = false;
            session.cv.notify_all();
        }

        // 클라이언트 사망 감지: 클라이언트는 hello 후 이 소켓에 아무것도 쓰지 않으므로,
        // read 반환 = EOF/에러 = 부착 해제 이벤트다(출력이 없어도 즉시 감지 — 폴링 0).
        let mut sink = [0u8; 64];
        loop {
            match reader.read(&mut sink) {
                Ok(0) | Err(_) => break,
                Ok(_) => continue, // 규약 밖 바이트는 무시
            }
        }
        let mut st = session.st.lock().unwrap();
        if st.attach_seq == my_seq {
            st.attached = None;
            st.unacked = 0;
            st.paused = false;
            session.cv.notify_all();
        }
    }

    // ── 구독(tee) 연결 ────────────────────────────────────────────────────────
    // 세션 출력의 프레임 사본을 배달한다. reader 는 유계 버퍼에 비차단 enqueue 만
    // 하고, 실제 소켓 쓰기는 이 스레드가 소유한다 — 느린 구독자가 라이브를 못 막는다.
    // 버퍼가 차면 드롭+gap 프레임으로 유실을 고지한다(무음 유실 금지).
    fn handle_subscribe(session: Arc<Session>, mut writer: UnixStream, mut reader: BufReader<UnixStream>) {
        let sub = Arc::new(TeeSub {
            id: NEXT_SUB_ID.fetch_add(1, Ordering::SeqCst) + 1,
            buf: Mutex::new(TeeBuf::new(TEE_BUF_CAP)),
            cv: Condvar::new(),
        });
        // 링 head seq 를 읽고 같은 락 안에서 구독자를 등록한다 — 그 뒤 push 되는 바이트만
        // (seq >= start_seq) 이 구독자에 배달되므로 start_seq 가 이 tee 의 정확한 기점이다.
        // 소비자는 이걸 consumed_seq 앵커로 삼아(warm 핸드오프 좌표) 이후 프레임 길이만큼
        // 전진한다 — mid-session 구독이어도 좌표가 데몬 링과 어긋나지 않는다(무음 시프트 금지).
        // 같은 락 안에서 링 backlog(seedB64, [ring.start_seq, start_seq))도 원자 캡처한다 —
        // 미드-세션 구독의 근접-birth 씨앗이다. start_seq 이전 retained 출력이라 이후 라이브
        // 프레임과 겹치지 않는다. 소비자가 이를 미러에 선주입해 구독 전 화면을 메운다(데몬
        // 미러 직렬화 불필요 — 링이 씨앗 원천). 링은 유계라 부분 씨앗(evict 된 prefix 는 없음).
        let (start_seq, seed) = {
            let mut st = session.st.lock().unwrap();
            let s = st.ring.seq();
            let seed = st.ring.snapshot();
            st.subscribers.push(sub.clone());
            (s, seed)
        };
        let ack = proto::ok_reply(json!({
            "session": session.id,
            "mode": "subscribe",
            "startSeq": start_seq,
            "seedB64": base64::engine::general_purpose::STANDARD.encode(&seed),
        }));
        if writeln!(writer, "{ack}").is_err() {
            session.st.lock().unwrap().subscribers.retain(|s| s.id != sub.id);
            return;
        }

        // 구독자 사망 감지: 구독자는 hello 후 아무것도 쓰지 않으므로 read 반환 =
        // EOF/에러 = 연결 종료 이벤트다(폴링 0). 버퍼를 닫아 writer 를 깨운다.
        {
            let sub = sub.clone();
            std::thread::spawn(move || {
                let mut sink = [0u8; 64];
                loop {
                    match reader.read(&mut sink) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => continue,
                    }
                }
                let mut b = sub.buf.lock().unwrap();
                b.closed = true;
                sub.cv.notify_all();
            });
        }

        // writer 루프: 프레임 드레인 → 프레이밍 소켓 쓰기. 쓰기 실패로 종료.
        loop {
            let (frames, closed) = {
                let mut b = sub.buf.lock().unwrap();
                while !b.closed && b.is_empty() {
                    b = sub.cv.wait(b).unwrap();
                }
                (b.drain(), b.closed)
            };
            let mut out = Vec::new();
            for fr in frames {
                match fr {
                    TeeFrame::Data(d) => proto::encode_tee_frame(proto::TEE_FRAME_DATA, &d, &mut out),
                    TeeFrame::Gap(f, t) => {
                        let payload =
                            serde_json::to_vec(&proto::TeeGap { from_seq: f, to_seq: t }).unwrap_or_default();
                        proto::encode_tee_frame(proto::TEE_FRAME_GAP, &payload, &mut out);
                    }
                }
            }
            if !out.is_empty() && writer.write_all(&out).is_err() {
                break;
            }
            if closed {
                break;
            }
        }

        // 등록 해제 — reader 가 사라진 구독자에 더는 사본을 밀지 않는다.
        session.st.lock().unwrap().subscribers.retain(|s| s.id != sub.id);
    }
}
