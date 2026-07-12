// soksak-ptyd — PTY 세션 데몬. 셸과 그 자식 프로세스를 앱 프로세스 밖에서 소유해
// 앱 종료·재시작·크래시에도 같은 pid 로 생존시키고, 재부착 시 detach 동안의 출력
// (스크롤백 링)을 재생한다. 프로세스 분리 3사유 중 "생존"(플랜 §2 축1).
//
// 경계 지불(축1): ① 버전 협상 = NDJSON hello(soksak-pty-proto judge_client)
// ② 죽음 감지 = 소켓 에러 이벤트(클라이언트/데몬 어느 쪽이 죽어도 상대 소켓이
//    EOF/에러로 즉시 안다 — 폴링 0)
// ③ 폴백+고지 = 앱 쪽 pty.rs 라우터가 소유(로컬 in-process 폴백 + activity 고지).
//
// 제어 표면 아님: 이 소켓은 PTY 데이터 평면 전용이다. 명령 표면은 코어 command
// registry 한 경로가 불변이다(플랜 §2 축1 — 수기 RPC 이중 제어 표면 금지).
//
// 소켓 2본(프로토콜별 경로, soksak-pty-proto 가 정본):
//   control  <home>/run/ptyd-p<N>.sock         NDJSON 요청/응답(hello 선행)
//   stream   <home>/run/ptyd-p<N>-stream.sock  hello 1줄 교환 후 raw PTY 출력
// 인증: <home>/run/ptyd-p<N>.token (0600) 공유 토큰 — hello 에 실어 보낸다.
//
// 재부착 재생 = 원시 출력 링(RawRing)을 from_seq 좌표부터 재생한다 — VT 해석은 코어
// 밖(사이드카)이 소유하므로 데몬은 바이트만 나른다. 화면 상태 복원(스크롤백·alt·모드)은
// 사이드카가 tee 를 소비해 미러링하고, 봉인-블롭 저장소(StoreBlob)로 체크포인트한다.
//
// 이 판의 정직한 한계 — 후속 레인 소유:
//   - Windows(named pipe/ConPTY)·데몬 업그레이드 drain 은 후속(M5·운명 3분기 b).

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
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Condvar, Mutex};

    use base64::Engine as _;
    use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
    use serde_json::{json, Value};
    use soksak_pty_proto as proto;

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
        // (새 attach 가 이미 승계했으면 no-op).
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

    // 체크포인트 봉인 설정 — 수신 공개키·볼트 키 id·경로·AAD(전부 soksak-pty-proto 규약).
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
        let dir = path.parent().ok_or("checkpoint path has no parent")?;
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

    struct Session {
        id: u64,
        pane_id: String,
        window_label: Option<String>,
        generation: u64,
        shell_pid: u32,
        master: Mutex<Box<dyn MasterPty + Send>>,
        writer: Mutex<Box<dyn Write + Send>>,
        child: Mutex<Box<dyn Child + Send + Sync>>,
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
        // identity 홈은 스폰한 앱이 명시한다 — 데몬이 identity 를 추측하지 않는다
        // (경계에서 원인 제거: 홈 파생 규칙의 단일 소유자는 앱 home.rs 다).
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

        // 싱글턴: control 소켓에 살아있는 응답자가 있으면 내가 두 번째다 — 즉시 물러난다
        // (연결 프로브 — 죽은 소켓 파일은 재바인드를 위해 제거).
        if UnixStream::connect(&control_path).is_ok() {
            eprintln!("soksak-ptyd: another daemon serves {control_path:?}; exiting");
            std::process::exit(0);
        }
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
            run_dir
        );

        let reg = Arc::new(Registry {
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
            next_gen: AtomicU64::new(0),
            home,
        });

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
                                "session has no checkpoint key (fail closed)",
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
            // 받는 기존 의미론과 동형이다(교차 창 동명 pane 의 모호성도 그대로 승계).
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
        }
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
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
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

        // reader 스레드: PTY 출력 → 링 + (부착 시) stream 소켓. 종료(EOF)가 세션 정리의
        // 단일 지점이다.
        {
            let session = session.clone();
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
                            // 원시 링 + seq(warm 핸드오프 substrate) 그리고 tee 사본. 둘 다
                            // 비차단 — reader(라이브 경로)는 여기서 소켓 I/O 를 하지 않는다
                            // (tee 소켓 쓰기는 구독자 자기 스레드 소유). VT 해석·체크포인트
                            // 정책은 사이드카 소유다 — 데몬은 바이트만 나른다.
                            let seq0 = st.ring.seq();
                            st.ring.push(&buf[..n]);
                            if !st.subscribers.is_empty() {
                                for sub in &st.subscribers {
                                    sub.buf.lock().unwrap().push_data(seq0, &buf[..n]);
                                    sub.cv.notify_one();
                                }
                            }
                            // 부착 중이면 라이브 전달. 쓰기 실패 = 클라이언트 사망 → detach
                            // (소켓 에러 이벤트가 죽음 감지다).
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
                // 세션 마감: 부착 스트림을 닫아 클라이언트에 EOF 를 전달하고 등록을 지운다.
                // 봉인-블롭이 남아 있으면 지운다 — 정상 종료(셸 exit/kill)는 산출물을 없앤다.
                // 파일이 남는 경우는 데몬 자신의 죽음뿐이고, 그것이 cold restore 의 입력이다.
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
                let _ = session.child.lock().unwrap().wait();
                reg.remove(session.id);
            });
        }
        Ok(session)
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
