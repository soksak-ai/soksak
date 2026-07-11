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
// 재부착 재생 = 세션당 헤드리스 미러(soksak-pty-mirror)의 직렬화 시퀀스다. 미러는
// 절대 응답하지 않고(단일 응답자 = 프론트 xterm), 재생 바이트는 전부 그리드 합성물이라
// 질의 재응답이 원천 차단된다. 스크롤백·alt-screen·private mode 가 재현된다(§5.5 M2).
//
// 이 판의 정직한 한계 — 후속 레인 소유:
//   - Windows(named pipe/ConPTY)·데몬 업그레이드 drain 은 후속(M5·운명 3분기 b).

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
    use std::time::{Duration, Instant};

    use base64::Engine as _;
    use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
    use serde_json::{json, Value};
    use soksak_pty_mirror::Mirror;
    use soksak_pty_proto as proto;

    // ── 세션 ─────────────────────────────────────────────────────────────────

    struct SessState {
        // 헤드리스 화면 미러 — attach 시 직렬화 시퀀스가 라이브에 앞서 재생된다.
        // 미러는 절대 응답하지 않는다(응답 요구는 관찰값으로만 삼킨다).
        mirror: Mirror,
        // 부착된 stream 소켓(마지막 승자). None = detached.
        attached: Option<UnixStream>,
        // attach 세대 — stream 사망 감지 스레드가 자기 세대의 부착만 해제한다
        // (새 attach 가 이미 승계했으면 no-op).
        attach_seq: u64,
        // 플로우 컨트롤(부착 중에만 유효) — pty.rs 와 같은 워터마크.
        unacked: usize,
        paused: bool,
        closed: bool,
        // 봉인 체크포인트 설정 — None 이면 이 세션은 체크포인트를 쓰지 않는다
        // (fail closed: 데몬은 화면 바이트를 평문으로 디스크에 남기지 않는다).
        ckpt: Option<CkptCfg>,
        // 디바운스 상태 — 출력 이벤트가 세운다. 고정 틱 폴링 없음: 체크포인트
        // 스레드는 cv 이벤트와 마감 시각(wait_timeout)으로만 깬다.
        ckpt_dirty: bool,
        ckpt_dirty_since: Option<Instant>,
        ckpt_last_output: Instant,
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

    // 출력 이벤트 디바운스: idle 300ms, 상한 5s(플랜 §5.5 M3).
    const CKPT_IDLE: Duration = Duration::from_millis(300);
    const CKPT_CAP: Duration = Duration::from_secs(5);

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

    // 봉인 후 tmp+rename 원자 쓰기 — 찢어진 파일이 정본 자리를 차지하지 못한다.
    fn write_checkpoint(
        cfg: &CkptCfg,
        session_id: u64,
        paint: &[u8],
        alt_active: bool,
    ) -> Result<(), String> {
        let sealed = soksak_seal::seal_to(&cfg.pk, paint, &cfg.aad)?;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let doc = json!({
            "v": 1,
            "keyId": cfg.key_id,
            "window": cfg.window,
            "pane": cfg.pane,
            "altActive": alt_active,
            "ts": ts,
            "sealed": sealed,
        });
        let dir = cfg.path.parent().ok_or("checkpoint path has no parent")?;
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        let tmp = dir.join(format!(".ckpt-tmp-{}-{session_id}", std::process::id()));
        let body = serde_json::to_vec(&doc).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        std::fs::rename(&tmp, &cfg.path).map_err(|e| e.to_string())
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
                s.st.lock().unwrap().mirror.resize(cols, rows);
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
            R::GetSnapshot { session } => with_session(reg, session, |s| {
                let st = s.st.lock().unwrap();
                let buf = st.mirror.rehydrate();
                Ok(json!({ "snapshotB64": base64::engine::general_purpose::STANDARD.encode(&buf) }))
            }),
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
                mirror: Mirror::new(cols, rows),
                attached: None,
                attach_seq: 0,
                unacked: 0,
                paused: false,
                closed: false,
                ckpt,
                ckpt_dirty: false,
                ckpt_dirty_since: None,
                ckpt_last_output: Instant::now(),
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
                            // 미러 갱신 — 화면 상태(스크롤백·alt·모드)가 여기서 유지된다.
                            st.mirror.feed(&buf[..n]);
                            // 체크포인트 디바운스 이벤트 — 첫 dirty 전이만 스레드를 깨운다
                            // (이후 연장은 wait_timeout 마감 재계산이 처리).
                            if st.ckpt.is_some() {
                                let first = st.ckpt_dirty_since.is_none();
                                st.ckpt_dirty = true;
                                st.ckpt_last_output = Instant::now();
                                if first {
                                    st.ckpt_dirty_since = Some(st.ckpt_last_output);
                                    session.cv.notify_all();
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
                // notify 로 체크포인트 스레드도 깨워 산출물 삭제·종료를 밟게 한다.
                {
                    let mut st = session.st.lock().unwrap();
                    st.closed = true;
                    if let Some(s) = st.attached.take() {
                        let _ = s.shutdown(std::net::Shutdown::Both);
                    }
                    session.cv.notify_all();
                }
                let _ = session.child.lock().unwrap().wait();
                reg.remove(session.id);
            });
        }

        // 체크포인트 스레드: 출력 이벤트 디바운스(idle 300ms·상한 5s)로 화면 페인트를
        // 봉인해 tmp+rename 원자 쓰기. 고정 틱 폴링 없음 — cv 이벤트 + 마감 시각
        // wait_timeout 으로만 깬다. 정상 종료(EOF/kill)면 산출물을 삭제한다: 파일이
        // 남는 경우는 데몬 자신의 죽음뿐 — 그것이 cold restore 의 입력이다.
        {
            let session = session.clone();
            std::thread::spawn(move || {
                let mut st = session.st.lock().unwrap();
                loop {
                    if st.closed {
                        break;
                    }
                    if !st.ckpt_dirty || st.ckpt.is_none() {
                        st = session.cv.wait(st).unwrap();
                        continue;
                    }
                    let now = Instant::now();
                    let idle = st.ckpt_last_output + CKPT_IDLE;
                    let cap = st.ckpt_dirty_since.unwrap_or(now) + CKPT_CAP;
                    let deadline = idle.min(cap);
                    if now < deadline {
                        let (guard, _) = session.cv.wait_timeout(st, deadline - now).unwrap();
                        st = guard;
                        continue;
                    }
                    // 마감 도달 — 직렬화는 락 안(짧다), 봉인·디스크 쓰기는 락 밖.
                    let paint = st.mirror.cold_paint();
                    let alt = st.mirror.alt_active();
                    let cfg = st.ckpt.clone();
                    st.ckpt_dirty = false;
                    st.ckpt_dirty_since = None;
                    drop(st);
                    if let Some(cfg) = &cfg {
                        if let Err(e) = write_checkpoint(cfg, session.id, &paint, alt) {
                            eprintln!("soksak-ptyd: checkpoint write failed: {e}");
                        }
                    }
                    st = session.st.lock().unwrap();
                }
                if let Some(cfg) = &st.ckpt {
                    let _ = std::fs::remove_file(&cfg.path);
                }
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

        // hello 확인 응답 1줄 → 이후 raw 바이트로 전환(링 재생 → 라이브).
        let my_seq;
        {
            let mut st = session.st.lock().unwrap();
            if st.closed {
                let _ = writeln!(writer, "{}", proto::err_reply("NOT_FOUND", "session closed"));
                return;
            }
            // 재생 = 미러 직렬화(화면 상태 재현) — raw 바이트 꼬리가 아니라 그리드
            // 합성물이다: 질의 재응답 불가, mid-escape 절단 불가(플랜 §5.5 M2).
            let replay = st.mirror.rehydrate();
            let ok = proto::ok_reply(json!({
                "session": sid,
                "replayBytes": replay.len(),
            }));
            if writeln!(writer, "{ok}").is_err() {
                return;
            }
            // 재생과 부착 승계는 세션 락 안에서 원자다 — reader 가 끼어들어 순서를 섞지 못한다.
            if writer.write_all(&replay).is_err() {
                return;
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
}
