// plugin service ServiceManager — 상주 서비스의 bind·프레이밍·라우팅(규범 docs/PLUGIN-SERVICE.md).
// 와이어 단일진실은 soksak-service-proto 크레이트(PS5). 코어는 매니페스트 파생 원장(bind ledger)
// 만 읽는다 — 특정 플러그인·특정 커맨드 문자열 0(PS1, C1).
//
// 구조: 실행 진실은 이 매니저 하나다(PS11). route()의 직행 분기와 창 프록시(S1b)가 전부 여기로
// 수렴한다. 스폰·전송은 seam 트레이트(ServiceSpawner) 뒤에 있어 유닛 테스트가 프로세스 없이
// 인메모리 파이프로 전 규칙을 검증한다(RED→GREEN, PS 조항 번호 인용).

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use soksak_service_proto::{
    judge_hello, ops_match, Compat, ErrCode, ServiceBinding, ServiceIn, ServiceOut,
    MAX_LINE_BYTES, RESTART_BACKOFF_SECS, SHUTDOWN_GRACE_MS,
};

// ── 호스트 seam — 활동 발행·스케줄 poke·시크릿 해소(테스트 mock 대상) ────────────

pub trait ServiceHost: Send + Sync + 'static {
    // 활동 피드 발행(PS8 — 무음 강등 금지). source 는 플러그인 id.
    fn publish(&self, kind: &str, source: &str, payload: Value);
    // 리스폰·bind 직후 owner 스케줄 poke(PS10·PS14).
    fn poke_owner(&self, owner: &str);
    // 볼트 시크릿 해소(ns=플러그인 id) — 평문은 스폰 env 경계로만(PS9).
    fn resolve_secret(&self, ns: &str, name: &str) -> Result<String, String>;
}

// ── 스폰 seam — 실 프로세스/테스트 파이프 공용 ───────────────────────────────────

pub struct SpawnedIo {
    pub stdin: Box<dyn Write + Send>,
    pub stdout: Box<dyn BufRead + Send>,
    pub pid: u32,
    // 강제 종료(멱등). 드레인 유예 초과·kill_all 이 부른다.
    pub kill: Box<dyn FnMut() + Send>,
}

pub trait ServiceSpawner: Send + Sync + 'static {
    fn spawn(&self, binding: &ServiceBinding, env: &[(String, String)]) -> Result<SpawnedIo, String>;
}

// ── 상태 기계(PS10) ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum SvcStatus {
    Spawning,
    Ready,
    Draining,
    Backoff(u32),
    Error(String),
    Stopped,
}

struct PendingSvc {
    tx: mpsc::SyncSender<Value>,
    // 진행 ev 가 갱신하는 절대 마감(ms) — PS12 의 마감 연장 축.
    extended_deadline: Arc<Mutex<u64>>,
}

struct SvcInner {
    status: SvcStatus,
    generation: u64,
    ready_this_generation: bool,
    stdin: Option<Box<dyn Write + Send>>,
    kill: Option<Box<dyn FnMut() + Send>>,
    pending: HashMap<u64, PendingSvc>,
    // 드레인/종료 의도 — reader EOF 를 크래시로 오분류하지 않는다.
    intent_stop: bool,
    attempt: u32,
}

pub struct Service {
    binding: ServiceBinding,
    inner: Mutex<SvcInner>,
    cv: Condvar,
}

struct MgrInner {
    services: Mutex<HashMap<String, Arc<Service>>>,
    // 레지스트리 전체 이름("plugin.<id>.<op>") → (플러그인, op). 조회는 데이터 주도(PS1).
    ops: Mutex<HashMap<String, (String, String)>>,
    host: Arc<dyn ServiceHost>,
    spawner: Arc<dyn ServiceSpawner>,
    backoff_ms: Vec<u64>,
    seq: AtomicU64,
}

pub struct ServiceManager {
    inner: Arc<MgrInner>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn envelope_err(code: ErrCode, message: &str) -> Value {
    json!({ "ok": false, "code": code.as_str(), "message": message })
}

impl ServiceManager {
    pub fn new(host: Arc<dyn ServiceHost>, spawner: Arc<dyn ServiceSpawner>) -> Self {
        Self::with_backoff(
            host,
            spawner,
            RESTART_BACKOFF_SECS.iter().map(|s| s * 1000).collect(),
        )
    }

    // 테스트 seam — 백오프 스케줄 주입(의미는 proto 상수와 동일, 단위만 ms).
    pub fn with_backoff(
        host: Arc<dyn ServiceHost>,
        spawner: Arc<dyn ServiceSpawner>,
        backoff_ms: Vec<u64>,
    ) -> Self {
        Self {
            inner: Arc::new(MgrInner {
                services: Mutex::new(HashMap::new()),
                ops: Mutex::new(HashMap::new()),
                host,
                spawner,
                backoff_ms,
                seq: AtomicU64::new(1),
            }),
        }
    }

    // bind(PS9) — 원장 한 항목을 서비스로 올린다. 멱등: 같은 플러그인 재-bind 는 무시(세대는
    // 드레인 재시작이 관리). ops 맵 등록 → 스폰 → hello 검증은 reader 스레드가 상태로 전이.
    pub fn bind(&self, binding: ServiceBinding) {
        let plugin = binding.plugin.clone();
        {
            let mut services = lock_or_poisoned(&self.inner.services);
            if services.contains_key(&plugin) {
                return;
            }
            let mut ops = lock_or_poisoned(&self.inner.ops);
            for op in &binding.ops {
                ops.insert(format!("plugin.{plugin}.{op}"), (plugin.clone(), op.clone()));
            }
            services.insert(
                plugin.clone(),
                Arc::new(Service {
                    binding,
                    inner: Mutex::new(SvcInner {
                        status: SvcStatus::Spawning,
                        generation: 0,
                        ready_this_generation: false,
                        stdin: None,
                        kill: None,
                        pending: HashMap::new(),
                        intent_stop: false,
                        attempt: 0,
                    }),
                    cv: Condvar::new(),
                }),
            );
        }
        let svc = {
            let services = lock_or_poisoned(&self.inner.services);
            services.get(&plugin).cloned()
        };
        if let Some(svc) = svc {
            spawn_generation(&self.inner, &svc);
        }
    }

    // 이 매니저가 소유한 커맨드인가 — route() 직행 분기의 판정(PS11).
    pub fn owns(&self, method: &str) -> bool {
        lock_or_poisoned(&self.inner.ops).contains_key(method)
    }

    pub fn status_of(&self, plugin: &str) -> Option<SvcStatus> {
        let services = lock_or_poisoned(&self.inner.services);
        services.get(plugin).map(|s| lock_or_poisoned(&s.inner).status.clone())
    }

    // 커맨드 실행(PS11·PS12) — 창 무관·포커스 무관. None = 이 매니저 소유가 아님(호출자 폴백).
    // key: 코어 발급 idempotency 키(스케줄 발화는 job+due 로 안정) — 미지정이면 유일 키 자동.
    pub fn dispatch(
        &self,
        method: &str,
        params: Value,
        key: Option<String>,
        origin: &str,
        parent: Option<String>,
        timeout_ms: u64,
        backstop_ms: u64,
    ) -> Option<Value> {
        let (plugin, op) = {
            let ops = lock_or_poisoned(&self.inner.ops);
            ops.get(method)?.clone()
        };
        let svc = {
            let services = lock_or_poisoned(&self.inner.services);
            services.get(&plugin)?.clone()
        };
        let deadline = now_ms() + timeout_ms;
        let backstop = now_ms() + backstop_ms.max(timeout_ms);

        // 준비 대기(PS10 큐잉) + 전송 — Spawning/Draining/Backoff 는 마감까지 cv 로 대기한다
        // (폴링 0). 전송 실패는 크래시 전이의 짧은 창(상태가 아직 Ready 로 보임) — 즉사 반환이
        // 아니라 큐잉으로 되돌아가 새 세대를 기다린다(마감이 상한).
        let (id, rx, extended) = 'attempt: loop {
            let mut inner = lock_or_poisoned(&svc.inner);
            loop {
                match &inner.status {
                    SvcStatus::Ready => break,
                    SvcStatus::Error(reason) => {
                        let reason = reason.clone();
                        return Some(envelope_err(
                            ErrCode::Unavailable,
                            &format!("서비스가 에러 상태({plugin}): {reason}"),
                        ));
                    }
                    SvcStatus::Stopped => {
                        return Some(envelope_err(ErrCode::Unavailable, "서비스가 종료됨"));
                    }
                    SvcStatus::Spawning | SvcStatus::Draining | SvcStatus::Backoff(_) => {
                        let remain = deadline.saturating_sub(now_ms());
                        if remain == 0 {
                            return Some(envelope_err(ErrCode::Timeout, "서비스 준비 대기 시간 초과"));
                        }
                        let (guard, _) = svc
                            .cv
                            .wait_timeout(inner, Duration::from_millis(remain))
                            .unwrap_or_else(|p| p.into_inner());
                        inner = guard;
                    }
                }
            }

            let id = self.inner.seq.fetch_add(1, Ordering::Relaxed);
            let key = key
                .clone()
                .unwrap_or_else(|| format!("auto:{}:{}", inner.generation, id));
            let (tx, rx) = mpsc::sync_channel::<Value>(1);
            let extended = Arc::new(Mutex::new(deadline));
            inner.pending.insert(id, PendingSvc { tx, extended_deadline: extended.clone() });
            let req = ServiceIn::Req {
                id,
                op: op.clone(),
                params: params.clone(),
                key,
                ctx: soksak_service_proto::ReqCtx {
                    origin: origin.to_string(),
                    parent: parent.clone(),
                    deadline_ms: deadline,
                },
            };
            if let Err(_e) = send_frame(&mut inner, &req) {
                inner.pending.remove(&id);
                if now_ms() >= deadline {
                    return Some(envelope_err(ErrCode::Timeout, "서비스 준비 대기 시간 초과"));
                }
                // 크래시 경로가 상태를 전이할 때까지 양보(상태 변화가 cv 를 울린다).
                let (guard, _) = svc
                    .cv
                    .wait_timeout(inner, Duration::from_millis(20))
                    .unwrap_or_else(|p| p.into_inner());
                drop(guard);
                continue 'attempt;
            }
            break (id, rx, extended);
        };

        // 마감 대기 — 진행 ev 가 extended_deadline 을 밀면 그만큼 더 기다린다(backstop 상한, PS12).
        loop {
            let target = {
                let d = lock_or_poisoned(&extended);
                (*d).min(backstop)
            };
            let remain = target.saturating_sub(now_ms());
            match rx.recv_timeout(Duration::from_millis(remain.max(1))) {
                Ok(v) => return Some(v),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let extended_to = *lock_or_poisoned(&extended);
                    if extended_to.min(backstop) > now_ms() {
                        continue; // 진행 중 — 연장된 마감까지 재대기.
                    }
                    let mut inner = lock_or_poisoned(&svc.inner);
                    inner.pending.remove(&id);
                    drop(inner);
                    self.inner.host.publish(
                        "service.req.timeout",
                        &plugin,
                        json!({ "op": op, "reqId": id }),
                    );
                    return Some(envelope_err(ErrCode::Timeout, "서비스 응답 시간 초과"));
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Some(envelope_err(ErrCode::Internal, "서비스 응답 채널 끊김"));
                }
            }
        }
    }

    // 환경 변화(시크릿 set/unlock 이벤트)의 발효 — 드레인 재시작(PS10). in-flight 완료를 cv 로
    // 기다리고(백스톱 상한), shutdown → 유예 → kill → 새 세대 스폰. 이벤트 시점 호출 전용(폴링 0).
    pub fn drain_restart(&self, plugin: &str) -> bool {
        let svc = {
            let services = lock_or_poisoned(&self.inner.services);
            match services.get(plugin) {
                Some(s) => s.clone(),
                None => return false,
            }
        };
        {
            let mut inner = lock_or_poisoned(&svc.inner);
            if !matches!(inner.status, SvcStatus::Ready) {
                return false;
            }
            inner.status = SvcStatus::Draining;
            svc.cv.notify_all();
        }
        self.inner.host.publish("service.draining", plugin, json!({}));
        // in-flight 완료 대기 — complete/crash 가 pending 을 비우며 cv 를 울린다.
        let grace_deadline = now_ms() + SHUTDOWN_GRACE_MS;
        {
            let mut inner = lock_or_poisoned(&svc.inner);
            while !inner.pending.is_empty() && now_ms() < grace_deadline {
                let remain = grace_deadline.saturating_sub(now_ms());
                let (guard, _) = svc
                    .cv
                    .wait_timeout(inner, Duration::from_millis(remain.max(1)))
                    .unwrap_or_else(|p| p.into_inner());
                inner = guard;
            }
            inner.intent_stop = true;
            let _ = send_frame(&mut inner, &ServiceIn::Shutdown);
            if let Some(kill) = inner.kill.as_mut() {
                kill();
            }
            inner.stdin = None;
            inner.kill = None;
        }
        // 새 세대 — 시크릿 재해소 포함(spawn_generation 이 다시 뽑는다).
        {
            let mut inner = lock_or_poisoned(&svc.inner);
            inner.intent_stop = false;
            inner.status = SvcStatus::Spawning;
            inner.ready_this_generation = false;
            inner.attempt = 0;
        }
        self.inner.host.publish("service.restarted", plugin, json!({ "cause": "drain" }));
        spawn_generation(&self.inner, &svc);
        true
    }

    // 앱 종료 — 상주 서비스 프로세스 잔존 0(PS10).
    pub fn kill_all(&self) {
        let services: Vec<Arc<Service>> = {
            let map = lock_or_poisoned(&self.inner.services);
            map.values().cloned().collect()
        };
        for svc in services {
            let mut inner = lock_or_poisoned(&svc.inner);
            inner.intent_stop = true;
            let _ = send_frame(&mut inner, &ServiceIn::Shutdown);
            if let Some(kill) = inner.kill.as_mut() {
                kill();
            }
            inner.stdin = None;
            inner.kill = None;
            inner.status = SvcStatus::Stopped;
            answer_all_pending(&mut inner, envelope_err(ErrCode::Unavailable, "앱 종료"));
            svc.cv.notify_all();
        }
    }
}

fn lock_or_poisoned<'a, T>(m: &'a Mutex<T>) -> std::sync::MutexGuard<'a, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn send_frame(inner: &mut SvcInner, frame: &ServiceIn) -> Result<(), String> {
    let line = serde_json::to_string(frame).map_err(|e| e.to_string())?;
    if line.len() > MAX_LINE_BYTES {
        return Err(format!("프레임이 줄 상한 초과({} bytes)", line.len()));
    }
    let stdin = inner.stdin.as_mut().ok_or("stdin 없음(미기동)")?;
    writeln!(stdin, "{line}").map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

fn answer_all_pending(inner: &mut SvcInner, envelope: Value) {
    for (_, p) in inner.pending.drain() {
        let _ = p.tx.try_send(envelope.clone());
    }
}

// 한 세대 스폰 — 시크릿 해소(PS9, all-or-nothing: 미해소면 Error+loud, 부분 주입 금지) →
// spawner → reader 스레드. hello 검증·상태 전이는 reader 가 소유한다.
fn spawn_generation(mgr: &Arc<MgrInner>, svc: &Arc<Service>) {
    let plugin = svc.binding.plugin.clone();
    let mut env: Vec<(String, String)> = Vec::new();
    for name in &svc.binding.secrets {
        match mgr.host.resolve_secret(&plugin, name) {
            Ok(plain) => env.push((name.clone(), plain)),
            Err(e) => {
                let reason = format!("선언 시크릿 미해소({name}): {e}");
                let mut inner = lock_or_poisoned(&svc.inner);
                inner.status = SvcStatus::Error(reason.clone());
                svc.cv.notify_all();
                drop(inner);
                mgr.host.publish("service.error", &plugin, json!({ "reason": reason }));
                return;
            }
        }
    }
    let spawned = match mgr.spawner.spawn(&svc.binding, &env) {
        Ok(s) => s,
        Err(e) => {
            let reason = format!("스폰 실패: {e}");
            let mut inner = lock_or_poisoned(&svc.inner);
            inner.status = SvcStatus::Error(reason.clone());
            svc.cv.notify_all();
            drop(inner);
            mgr.host.publish("service.error", &plugin, json!({ "reason": reason }));
            return;
        }
    };
    let (stdout, my_gen) = {
        let mut inner = lock_or_poisoned(&svc.inner);
        inner.generation += 1;
        inner.ready_this_generation = false;
        inner.stdin = Some(spawned.stdin);
        inner.kill = Some(spawned.kill);
        mgr.host.publish(
            "service.spawned",
            &plugin,
            json!({ "generation": inner.generation, "pid": spawned.pid }),
        );
        (spawned.stdout, inner.generation)
    };
    let mgr = mgr.clone();
    let svc = svc.clone();
    std::thread::spawn(move || reader_loop(mgr, svc, stdout, my_gen));
}

// reader — hello 검증(PS3·PS5) 후 프레임 루프. EOF/프로토콜 결함 = 크래시 경로(PS10).
// my_gen: 이 reader 가 속한 세대 — 드레인 교체 후 구세대 reader 의 EOF 가 신세대 상태를
// 오염시키지 않는다(세대 가드).
fn reader_loop(
    mgr: Arc<MgrInner>,
    svc: Arc<Service>,
    mut stdout: Box<dyn BufRead + Send>,
    my_gen: u64,
) {
    let plugin = svc.binding.plugin.clone();
    let mut line = String::new();

    // 1) hello — 첫 줄. 판정 실패 = bind 거부(재시도 없음, loud).
    line.clear();
    match stdout.read_line(&mut line) {
        Ok(n) if n > 0 => {}
        _ => return on_stream_end(&mgr, &svc, "hello 이전 종료", my_gen),
    }
    if line.len() > MAX_LINE_BYTES {
        return refuse_bind(&mgr, &svc, "hello 줄 상한 초과", my_gen);
    }
    let hello: ServiceOut = match serde_json::from_str(line.trim()) {
        Ok(f) => f,
        Err(e) => return refuse_bind(&mgr, &svc, &format!("hello 파싱 실패: {e}"), my_gen),
    };
    let (version, interface, ops, _subscribe) = match hello {
        ServiceOut::Hello { version, interface, ops, subscribe, .. } => {
            (version, interface, ops, subscribe)
        }
        _ => return refuse_bind(&mgr, &svc, "첫 프레임이 hello 가 아님", my_gen),
    };
    if !matches!(judge_hello(version), Compat::Compatible) {
        return refuse_bind(&mgr, &svc, &format!("프로토콜 비호환(선언 {version:?})"), my_gen);
    }
    if interface != svc.binding.interface {
        return refuse_bind(
            &mgr,
            &svc,
            &format!("interface 불일치: 자기보고 {interface} ≠ 선언 {}", svc.binding.interface),
            my_gen,
        );
    }
    if !ops_match(&ops, &svc.binding.ops) {
        return refuse_bind(
            &mgr,
            &svc,
            &format!("ops 불일치(declared ≡ actual 위반): hello {ops:?} ≠ 원장 {:?}", svc.binding.ops),
            my_gen,
        );
    }

    // 2) ready — 상태 전이 + 큐 대기자 기상 + owner poke(부팅 스캔·리스폰 되먹임).
    {
        let mut inner = lock_or_poisoned(&svc.inner);
        if send_frame(&mut inner, &ServiceIn::Ready).is_err() {
            drop(inner);
            return on_stream_end(&mgr, &svc, "ready 전송 실패", my_gen);
        }
        inner.status = SvcStatus::Ready;
        inner.ready_this_generation = true;
        // attempt 는 ready 로 리셋하지 않는다(daemon.rs 의미론) — 크래시 루프가 리셋으로
        // 상한을 영영 피하는 구멍을 막는다. 명시 리셋은 드레인 재시작(사람/이벤트 유래)만.
        svc.cv.notify_all();
    }
    mgr.host.publish("service.ready", &plugin, json!({}));
    mgr.host.poke_owner(&plugin);

    // 3) 프레임 루프.
    loop {
        line.clear();
        match stdout.read_line(&mut line) {
            Ok(n) if n > 0 => {}
            _ => return on_stream_end(&mgr, &svc, "스트림 종료", my_gen),
        }
        if line.len() > MAX_LINE_BYTES {
            return on_stream_end(&mgr, &svc, "줄 상한 초과(프로토콜 결함)", my_gen);
        }
        let frame: ServiceOut = match serde_json::from_str(line.trim()) {
            Ok(f) => f,
            Err(e) => return on_stream_end(&mgr, &svc, &format!("프레임 파싱 실패: {e}"), my_gen),
        };
        match frame {
            ServiceOut::Hello { .. } => {
                return on_stream_end(&mgr, &svc, "중복 hello(프로토콜 결함)", my_gen);
            }
            ServiceOut::Res { id, ok, code, message, hints, data } => {
                let mut envelope = json!({ "ok": ok });
                let code = if ok {
                    "OK".to_string()
                } else {
                    // 폐쇄 enum 클램프(PS5) — 미지 코드는 INTERNAL, raw 문자열 비누출.
                    ErrCode::clamp(code.as_deref().unwrap_or("INTERNAL")).as_str().to_string()
                };
                envelope["code"] = json!(code);
                if let Some(m) = message {
                    envelope["message"] = json!(m); // 봉투 정식 seam(PS7)
                }
                if let Some(h) = hints {
                    envelope["hints"] = serde_json::to_value(h).unwrap_or(Value::Null);
                }
                if let Some(d) = data {
                    envelope["data"] = d;
                }
                let mut inner = lock_or_poisoned(&svc.inner);
                if let Some(p) = inner.pending.remove(&id) {
                    let _ = p.tx.try_send(envelope);
                }
                svc.cv.notify_all(); // 드레인 대기자에게 pending 감소 통지.
            }
            ServiceOut::Ev { id, kind, payload } => {
                // 진행 = 마감 연장(PS12) + 표준 진행 채널 발행(PS7 — A14 흡수).
                let extend_to = {
                    let inner = lock_or_poisoned(&svc.inner);
                    inner.pending.get(&id).map(|p| p.extended_deadline.clone())
                };
                if let Some(d) = extend_to {
                    let mut d = lock_or_poisoned(&d);
                    *d = now_ms() + soksak_service_proto::DEFAULT_REQ_TIMEOUT_MS;
                }
                mgr.host.publish(
                    "command.progress",
                    &plugin,
                    json!({ "reqId": id, "kind": kind, "payload": payload }),
                );
            }
            ServiceOut::Act { kind, payload } => {
                mgr.host.publish(&kind, &plugin, payload);
            }
            ServiceOut::Cmd { id, .. } => {
                // 아웃바운드 중개(PS13)는 S1b 의 executor mediation 이 연다. 게이트 없는 중개를
                // 코어에서 여는 것이 금지이므로 미개방이 올바른 기본값(fail-closed)이다 —
                // 임시 회피가 아니라 개방 조건(게이트 전체 세트)이 아직 랜딩 전인 것.
                let refusal = ServiceIn::CmdRes {
                    id,
                    envelope: envelope_err(ErrCode::Unavailable, "중개 미개방(mediation 게이트 미랜딩)"),
                };
                let mut inner = lock_or_poisoned(&svc.inner);
                let _ = send_frame(&mut inner, &refusal);
            }
        }
    }
}

fn refuse_bind(mgr: &Arc<MgrInner>, svc: &Arc<Service>, reason: &str, my_gen: u64) {
    let plugin = svc.binding.plugin.clone();
    let mut inner = lock_or_poisoned(&svc.inner);
    if inner.generation != my_gen {
        return; // 구세대 reader — 신세대 상태 불가침(세대 가드).
    }
    if let Some(kill) = inner.kill.as_mut() {
        kill();
    }
    inner.stdin = None;
    inner.kill = None;
    inner.status = SvcStatus::Error(reason.to_string());
    answer_all_pending(&mut inner, envelope_err(ErrCode::Unavailable, reason));
    svc.cv.notify_all();
    drop(inner);
    mgr.host.publish("service.bind.refused", &plugin, json!({ "reason": reason }));
}

// 스트림 종료 — 의도(드레인/종료)면 조용히, 아니면 크래시 경로(PS10):
// pending 즉시 응답 → ready 미도달 세대는 재시도 없이 Error → 그 외 백오프 리스폰(상한 후 Error).
fn on_stream_end(mgr: &Arc<MgrInner>, svc: &Arc<Service>, cause: &str, my_gen: u64) {
    let plugin = svc.binding.plugin.clone();
    let (retry_after_ms, attempt) = {
        let mut inner = lock_or_poisoned(&svc.inner);
        if inner.generation != my_gen {
            return; // 구세대 reader — 신세대 상태 불가침(세대 가드).
        }
        if inner.intent_stop {
            return; // 드레인/종료 의도 — 크래시 아님.
        }
        answer_all_pending(&mut inner, envelope_err(ErrCode::Internal, &format!("서비스 비정상 종료: {cause}")));
        if let Some(kill) = inner.kill.as_mut() {
            kill();
        }
        inner.stdin = None;
        inner.kill = None;
        if !inner.ready_this_generation {
            // 결정적 즉사(ready 이전 사망) — 재시도 없음(PS10).
            let reason = format!("기동 즉시 종료: {cause}");
            inner.status = SvcStatus::Error(reason.clone());
            svc.cv.notify_all();
            drop(inner);
            mgr.host.publish("service.error", &plugin, json!({ "reason": reason, "deterministic": true }));
            return;
        }
        inner.attempt += 1;
        if inner.attempt as usize > mgr.backoff_ms.len() {
            let reason = format!("크래시 상한 도달({}회): {cause}", inner.attempt - 1);
            inner.status = SvcStatus::Error(reason.clone());
            svc.cv.notify_all();
            drop(inner);
            mgr.host.publish("service.error", &plugin, json!({ "reason": reason }));
            return;
        }
        let delay = mgr.backoff_ms[(inner.attempt - 1) as usize];
        inner.status = SvcStatus::Backoff(inner.attempt);
        svc.cv.notify_all();
        (delay, inner.attempt)
    };
    mgr.host.publish(
        "service.backoff",
        &plugin,
        json!({ "attempt": attempt, "delayMs": retry_after_ms, "cause": cause }),
    );
    let mgr = mgr.clone();
    let svc = svc.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(retry_after_ms));
        {
            let inner = lock_or_poisoned(&svc.inner);
            if inner.intent_stop || !matches!(inner.status, SvcStatus::Backoff(_)) {
                return;
            }
        }
        mgr.host.publish("service.restarted", &svc.binding.plugin, json!({ "cause": "crash" }));
        spawn_generation(&mgr, &svc);
    });
}

// ── 앱 배선(실 구현) — 호스트·스포너·부트 ────────────────────────────────────────

pub struct AppServiceHost {
    app: tauri::AppHandle,
}

impl AppServiceHost {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl ProcessServiceSpawner {
    pub fn new(home: std::path::PathBuf) -> Self {
        Self { home }
    }
}

impl ServiceHost for AppServiceHost {
    fn publish(&self, kind: &str, source: &str, payload: Value) {
        crate::activity::publish(&self.app, kind, source, payload);
    }
    fn poke_owner(&self, owner: &str) {
        use tauri::Manager;
        self.app
            .state::<crate::schedule::ScheduleState>()
            .poke_owner(owner, now_ms());
    }
    fn resolve_secret(&self, ns: &str, name: &str) -> Result<String, String> {
        use tauri::Manager;
        let state = self.app.state::<crate::secrets::SecretsState>();
        crate::secrets::resolve(&state, ns, name)
    }
}

// 실 프로세스 스포너 — 바이너리 해석은 사이드카 규약(resolve_sidecar_cmd, PS9: 배급·스테이징은
// 사이드카 법 상속), env 는 SOKSAK_HOME + 해소된 시크릿만. stderr 는 identity 홈 로그로.
pub struct ProcessServiceSpawner {
    home: std::path::PathBuf,
}

impl ServiceSpawner for ProcessServiceSpawner {
    fn spawn(&self, binding: &ServiceBinding, env: &[(String, String)]) -> Result<SpawnedIo, String> {
        use std::process::{Command, Stdio};
        let bin = crate::process::resolve_sidecar_cmd(&format!("sidecar:{}", binding.sidecar))?;
        let log = soksak_service_proto::log_path(&self.home, &binding.plugin);
        if let Some(dir) = log.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let stderr = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log)
            .map(Stdio::from)
            .unwrap_or_else(|_| Stdio::null());
        let mut child = Command::new(&bin)
            .arg(soksak_service_proto::SERVE_ARG)
            .env("SOKSAK_HOME", &self.home)
            .envs(env.iter().cloned())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(stderr)
            .spawn()
            .map_err(|e| format!("{bin} 스폰 실패: {e}"))?;
        let pid = child.id();
        let stdin = child.stdin.take().ok_or("자식 stdin 없음")?;
        let stdout = child.stdout.take().ok_or("자식 stdout 없음")?;
        let child = Arc::new(Mutex::new(child));
        let kill_child = child.clone();
        Ok(SpawnedIo {
            stdin: Box::new(stdin),
            stdout: Box::new(std::io::BufReader::new(stdout)),
            pid,
            kill: Box::new(move || {
                let mut c = lock_or_poisoned(&kill_child);
                let _ = c.kill();
                let _ = c.wait(); // 리핑 — 좀비 0.
            }),
        })
    }
}

// 부트(PS9) — bind 원장을 읽어 각 서비스를 올린다: 스케줄 등록(owner 스탬핑) → bind(스폰).
// 원장이 없으면 서비스 0 — 정상(선언 플러그인 부재). 워크스페이스 창 불요(창-무관).
pub fn boot(app: &tauri::AppHandle) {
    use tauri::Manager;
    let home = crate::home::soksak_home();
    let ledger_file = soksak_service_proto::ledger_path(&home);
    let ledger: soksak_service_proto::BindLedger = match std::fs::read_to_string(&ledger_file) {
        Ok(text) => match serde_json::from_str(&text) {
            Ok(l) => l,
            Err(e) => {
                crate::activity::publish(
                    app,
                    "service.ledger.invalid",
                    "core",
                    json!({ "path": ledger_file.to_string_lossy(), "error": e.to_string() }),
                );
                return;
            }
        },
        Err(_) => return, // 원장 없음 = 서비스 선언 플러그인 없음.
    };
    let mgr = app.state::<ServiceManager>();
    for binding in ledger.services {
        register_binding_schedules(app, &binding);
        mgr.bind(binding);
    }
}

// 원장 스케줄 → 코어 스케줄러(PS14): owner=플러그인 id 스탬핑, id 는 안정("svc:<plugin>:<name>").
// bind 후 poke 는 reader 의 ready 전이가 쏜다(poke_owner) — 부팅 스캔은 서비스가 준비된 뒤에만.
fn register_binding_schedules(app: &tauri::AppHandle, binding: &ServiceBinding) {
    for s in &binding.schedules {
        let trigger = match &s.trigger {
            soksak_service_proto::LedgerTrigger::Reconcile { .. } => crate::schedule::Trigger::Reconcile,
            soksak_service_proto::LedgerTrigger::Every { every_ms } => {
                crate::schedule::Trigger::Every { every_ms: *every_ms, anchor: None }
            }
            soksak_service_proto::LedgerTrigger::Cron { cron } => {
                crate::schedule::Trigger::Cron { expr: cron.clone() }
            }
        };
        let spec = crate::schedule::JobSpec {
            id: Some(format!("svc:{}:{}", binding.plugin, s.name)),
            trigger,
            command: format!("plugin.{}.{}", binding.plugin, s.command),
            params: s.params.clone().unwrap_or_else(|| json!({})),
            retry: None,
            concurrency: 1,
            timeout_ms: s.timeout_ms,
            process_lease: false, // 서비스 op 의 장기 실행은 진행 ev 연장이 담당(PS12) — 웹뷰 lease 불요.
            zombie_backstop_ms: s.zombie_backstop_ms,
            owner: Some(binding.plugin.clone()),
        };
        crate::schedule::register_owned(app, spec);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::io::Read;
    use std::sync::atomic::AtomicUsize;

    // ── 인메모리 파이프(블로킹 Read/Write) — 프로세스 없는 결정적 유닛 ─────────

    #[derive(Clone, Default)]
    struct Pipe(Arc<(Mutex<PipeBuf>, Condvar)>);

    #[derive(Default)]
    struct PipeBuf {
        buf: VecDeque<u8>,
        closed: bool,
    }

    impl Pipe {
        fn close(&self) {
            let (m, cv) = &*self.0;
            lock_or_poisoned(m).closed = true;
            cv.notify_all();
        }
    }

    impl Write for Pipe {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            let (m, cv) = &*self.0;
            let mut b = lock_or_poisoned(m);
            if b.closed {
                return Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "closed"));
            }
            b.buf.extend(data);
            cv.notify_all();
            Ok(data.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Read for Pipe {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            let (m, cv) = &*self.0;
            let mut b = lock_or_poisoned(m);
            loop {
                if !b.buf.is_empty() {
                    let n = out.len().min(b.buf.len());
                    for slot in out.iter_mut().take(n) {
                        *slot = b.buf.pop_front().unwrap_or(0);
                    }
                    return Ok(n);
                }
                if b.closed {
                    return Ok(0);
                }
                b = cv.wait(b).unwrap_or_else(|p| p.into_inner());
            }
        }
    }

    // ── 가짜 서비스 — 스크립트 클로저가 per-spawn 프로토콜 상대역을 연기 ────────

    struct FakeConn {
        // 코어가 서비스 stdin 에 쓴 것(서비스가 읽는다).
        from_core: std::io::BufReader<Pipe>,
        // 서비스 stdout(코어가 읽는다).
        to_core: Pipe,
    }

    // 스크립트 종료 = 프로세스 종료 — 파이프를 닫아 코어가 EOF(크래시/종료)를 본다.
    impl Drop for FakeConn {
        fn drop(&mut self) {
            self.to_core.close();
            self.from_core.get_ref().close();
        }
    }

    impl FakeConn {
        fn read_frame(&mut self) -> Option<ServiceIn> {
            let mut line = String::new();
            match self.from_core.read_line(&mut line) {
                Ok(n) if n > 0 => serde_json::from_str(line.trim()).ok(),
                _ => None,
            }
        }
        fn write_out(&mut self, f: &ServiceOut) {
            let line = serde_json::to_string(f).expect("frame serialize");
            let _ = writeln!(self.to_core, "{line}");
        }
        fn hello(&mut self, ops: &[&str]) {
            self.write_out(&ServiceOut::Hello {
                version: Some(soksak_service_proto::SERVICE_PROTOCOL_VERSION),
                interface: soksak_service_proto::SERVICE_INTERFACE.into(),
                ops: ops.iter().map(|s| s.to_string()).collect(),
                subscribe: vec![],
                pid: 1,
            });
        }
    }

    type Script = Arc<dyn Fn(u64, FakeConn) + Send + Sync>;

    struct FakeSpawner {
        script: Script,
        spawns: AtomicUsize,
    }

    impl ServiceSpawner for FakeSpawner {
        fn spawn(&self, _b: &ServiceBinding, _env: &[(String, String)]) -> Result<SpawnedIo, String> {
            let n = self.spawns.fetch_add(1, Ordering::SeqCst) as u64 + 1;
            let stdin_pipe = Pipe::default();
            let stdout_pipe = Pipe::default();
            let conn = FakeConn {
                from_core: std::io::BufReader::new(stdin_pipe.clone()),
                to_core: stdout_pipe.clone(),
            };
            let script = self.script.clone();
            std::thread::spawn(move || script(n, conn));
            let kill_in = stdin_pipe.clone();
            let kill_out = stdout_pipe.clone();
            Ok(SpawnedIo {
                stdin: Box::new(stdin_pipe),
                stdout: Box::new(std::io::BufReader::new(stdout_pipe)),
                pid: n as u32,
                kill: Box::new(move || {
                    kill_in.close();
                    kill_out.close();
                }),
            })
        }
    }

    #[derive(Default)]
    struct MockHost {
        events: Mutex<Vec<(String, String)>>,
        pokes: Mutex<Vec<String>>,
    }

    impl ServiceHost for MockHost {
        fn publish(&self, kind: &str, source: &str, _payload: Value) {
            lock_or_poisoned(&self.events).push((kind.to_string(), source.to_string()));
        }
        fn poke_owner(&self, owner: &str) {
            lock_or_poisoned(&self.pokes).push(owner.to_string());
        }
        fn resolve_secret(&self, _ns: &str, name: &str) -> Result<String, String> {
            if name == "MISSING" {
                return Err("볼트 잠김".into());
            }
            Ok(format!("plain-{name}"))
        }
    }

    fn binding(ops: &[&str]) -> ServiceBinding {
        ServiceBinding {
            plugin: "demo".into(),
            sidecar: "demo".into(),
            interface: soksak_service_proto::SERVICE_INTERFACE.into(),
            ops: ops.iter().map(|s| s.to_string()).collect(),
            subscribe: vec![],
            schedules: vec![],
            secrets: vec![],
        }
    }

    fn manager(script: Script) -> (ServiceManager, Arc<MockHost>, Arc<FakeSpawner>) {
        let host = Arc::new(MockHost::default());
        let spawner = Arc::new(FakeSpawner { script, spawns: AtomicUsize::new(0) });
        let mgr = ServiceManager::with_backoff(host.clone(), spawner.clone(), vec![20, 20, 20, 20, 20]);
        (mgr, host, spawner)
    }

    fn wait_status(mgr: &ServiceManager, plugin: &str, want: fn(&SvcStatus) -> bool) -> SvcStatus {
        for _ in 0..200 {
            if let Some(s) = mgr.status_of(plugin) {
                if want(&s) {
                    return s;
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        mgr.status_of(plugin).unwrap_or(SvcStatus::Stopped)
    }

    fn events_of(host: &MockHost) -> Vec<String> {
        lock_or_poisoned(&host.events).iter().map(|(k, _)| k.clone()).collect()
    }

    // ── PS3·PS5: hello 양방향 대조 — 불일치=거부, 재시도 없음 ────────────────

    #[test]
    fn hello_ops_mismatch_refuses_the_bind() {
        let (mgr, host, spawner) = manager(Arc::new(|_gen, mut conn: FakeConn| {
            conn.hello(&["run", "extra"]);
        }));
        mgr.bind(binding(&["run"]));
        let st = wait_status(&mgr, "demo", |s| matches!(s, SvcStatus::Error(_)));
        assert!(matches!(st, SvcStatus::Error(ref r) if r.contains("ops 불일치")), "{st:?}");
        assert!(events_of(&host).contains(&"service.bind.refused".to_string()));
        assert_eq!(spawner.spawns.load(Ordering::SeqCst), 1, "거부는 재시도 없음");
    }

    #[test]
    fn hello_interface_mismatch_refuses_the_bind() {
        let (mgr, _host, _sp) = manager(Arc::new(|_gen, mut conn: FakeConn| {
            conn.write_out(&ServiceOut::Hello {
                version: Some(1),
                interface: "soksak-other-spec@1".into(),
                ops: vec!["run".into()],
                subscribe: vec![],
                pid: 1,
            });
        }));
        mgr.bind(binding(&["run"]));
        let st = wait_status(&mgr, "demo", |s| matches!(s, SvcStatus::Error(_)));
        assert!(matches!(st, SvcStatus::Error(ref r) if r.contains("interface 불일치")), "{st:?}");
    }

    // ── PS7·PS5: 봉투 매핑 — message/hints 1급, 미지 코드는 INTERNAL 클램프 ──

    fn echo_script() -> Script {
        Arc::new(|_gen, mut conn: FakeConn| {
            conn.hello(&["run", "fail"]);
            loop {
                match conn.read_frame() {
                    Some(ServiceIn::Req { id, op, params, .. }) => {
                        if op == "run" {
                            conn.write_out(&ServiceOut::Res {
                                id,
                                ok: true,
                                code: None,
                                message: Some("완료했습니다".into()),
                                hints: Some(vec![soksak_service_proto::Hint {
                                    cmd: "plugin.demo.fail".into(),
                                    why: "다음 단계".into(),
                                }]),
                                data: Some(json!({ "echo": params })),
                            });
                        } else {
                            conn.write_out(&ServiceOut::Res {
                                id,
                                ok: false,
                                code: Some("WEIRD_CODE".into()),
                                message: Some("실패".into()),
                                hints: None,
                                data: None,
                            });
                        }
                    }
                    Some(ServiceIn::Shutdown) | None => return,
                    _ => {}
                }
            }
        })
    }

    #[test]
    fn dispatch_maps_the_envelope_with_message_hints_and_code_clamp() {
        let (mgr, _host, _sp) = manager(echo_script());
        mgr.bind(binding(&["run", "fail"]));
        assert!(mgr.owns("plugin.demo.run"), "데이터 주도 소유 판정(PS11)");
        assert!(!mgr.owns("plugin.demo.ghost"));
        let ok = mgr
            .dispatch("plugin.demo.run", json!({ "doc": "a" }), None, "socket", None, 2_000, 10_000)
            .expect("소유 커맨드");
        assert_eq!(ok["ok"], true);
        assert_eq!(ok["code"], "OK");
        assert_eq!(ok["message"], "완료했습니다", "message 는 봉투 1급(PS7)");
        assert_eq!(ok["hints"][0]["cmd"], "plugin.demo.fail");
        assert_eq!(ok["data"]["echo"]["doc"], "a");
        let err = mgr
            .dispatch("plugin.demo.fail", json!({}), None, "socket", None, 2_000, 10_000)
            .expect("소유 커맨드");
        assert_eq!(err["ok"], false);
        assert_eq!(err["code"], "INTERNAL", "미지 코드는 폐쇄 enum 클램프(PS5)");
        assert_eq!(err["message"], "실패");
    }

    #[test]
    fn dispatch_returns_none_for_unowned_methods() {
        let (mgr, _host, _sp) = manager(echo_script());
        mgr.bind(binding(&["run", "fail"]));
        assert!(mgr
            .dispatch("window.open", json!({}), None, "socket", None, 100, 100)
            .is_none());
    }

    // ── 멀티플렉스 — 역순 응답도 각자에게 도착 ────────────────────────────────

    #[test]
    fn multiplexed_requests_resolve_out_of_order() {
        let script: Script = Arc::new(|_gen, mut conn: FakeConn| {
            conn.hello(&["a", "b"]);
            let mut held: Option<u64> = None;
            loop {
                match conn.read_frame() {
                    Some(ServiceIn::Req { id, op, .. }) => {
                        if op == "a" {
                            held = Some(id); // 첫 req 는 보류
                        } else {
                            conn.write_out(&ServiceOut::Res {
                                id, ok: true, code: None,
                                message: None, hints: None, data: Some(json!({ "op": "b" })),
                            });
                            if let Some(h) = held.take() {
                                conn.write_out(&ServiceOut::Res {
                                    id: h, ok: true, code: None,
                                    message: None, hints: None, data: Some(json!({ "op": "a" })),
                                });
                            }
                        }
                    }
                    Some(ServiceIn::Shutdown) | None => return,
                    _ => {}
                }
            }
        });
        let (mgr, _host, _sp) = manager(script);
        mgr.bind(binding(&["a", "b"]));
        let mgr = Arc::new(mgr);
        let m2 = mgr.clone();
        let t = std::thread::spawn(move || {
            m2.dispatch("plugin.demo.a", json!({}), None, "socket", None, 3_000, 10_000)
        });
        std::thread::sleep(Duration::from_millis(50)); // a 가 먼저 도착하도록
        let b = mgr
            .dispatch("plugin.demo.b", json!({}), None, "socket", None, 3_000, 10_000)
            .expect("b");
        assert_eq!(b["data"]["op"], "b");
        let a = t.join().expect("join").expect("a");
        assert_eq!(a["data"]["op"], "a", "역순 응답이 원 요청자에게 도착(멀티플렉스)");
    }

    // ── PS12: 진행 ev 가 마감을 연장한다 ─────────────────────────────────────

    #[test]
    fn progress_events_extend_the_deadline() {
        let script: Script = Arc::new(|_gen, mut conn: FakeConn| {
            conn.hello(&["slow"]);
            loop {
                match conn.read_frame() {
                    Some(ServiceIn::Req { id, .. }) => {
                        // 마감(200ms)보다 늦게 끝나지만 진행 ev 가 계속 연장한다.
                        for _ in 0..4 {
                            std::thread::sleep(Duration::from_millis(100));
                            conn.write_out(&ServiceOut::Ev {
                                id, kind: "progress".into(), payload: json!({}),
                            });
                        }
                        std::thread::sleep(Duration::from_millis(100));
                        conn.write_out(&ServiceOut::Res {
                            id, ok: true, code: None, message: None, hints: None,
                            data: Some(json!({ "done": true })),
                        });
                    }
                    Some(ServiceIn::Shutdown) | None => return,
                    _ => {}
                }
            }
        });
        let (mgr, _host, _sp) = manager(script);
        mgr.bind(binding(&["slow"]));
        let out = mgr
            .dispatch("plugin.demo.slow", json!({}), None, "socket", None, 200, 60_000)
            .expect("소유 커맨드");
        assert_eq!(out["ok"], true, "진행 중 op 는 마감 연장으로 완주(PS12): {out}");
    }

    // ── PS10: 크래시 경로 — 결정적 즉사/백오프 리스폰/상한/의도 종료 ──────────

    #[test]
    fn immediate_exit_before_ready_goes_straight_to_error() {
        let (mgr, host, spawner) = manager(Arc::new(|_gen, conn: FakeConn| {
            drop(conn); // hello 없이 즉사
        }));
        mgr.bind(binding(&["run"]));
        let st = wait_status(&mgr, "demo", |s| matches!(s, SvcStatus::Error(_)));
        assert!(matches!(st, SvcStatus::Error(ref r) if r.contains("기동 즉시 종료")), "{st:?}");
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(spawner.spawns.load(Ordering::SeqCst), 1, "결정적 즉사는 재시도 없음(PS10)");
        assert!(events_of(&host).contains(&"service.error".to_string()), "loud(PS8)");
    }

    #[test]
    fn crash_after_ready_respawns_with_backoff_and_pokes_owner() {
        let script: Script = Arc::new(|generation, mut conn: FakeConn| {
            conn.hello(&["run"]);
            if generation == 1 {
                // ready 수신 후 크래시.
                let _ = conn.read_frame();
                return;
            }
            loop {
                match conn.read_frame() {
                    Some(ServiceIn::Req { id, .. }) => {
                        conn.write_out(&ServiceOut::Res {
                            id, ok: true, code: None, message: None, hints: None,
                            data: Some(json!({ "generation": generation })),
                        });
                    }
                    Some(ServiceIn::Shutdown) | None => return,
                    _ => {}
                }
            }
        });
        let (mgr, host, spawner) = manager(script);
        mgr.bind(binding(&["run"]));
        // 2세대가 Ready 될 때까지 — 크래시(1세대) → 백오프 → 리스폰.
        let out = mgr
            .dispatch("plugin.demo.run", json!({}), None, "socket", None, 5_000, 10_000)
            .expect("소유 커맨드");
        assert_eq!(out["data"]["generation"], 2, "리스폰 세대가 응답: {out}");
        assert!(spawner.spawns.load(Ordering::SeqCst) >= 2);
        let ev = events_of(&host);
        assert!(ev.contains(&"service.backoff".to_string()), "백오프 발행(loud): {ev:?}");
        let pokes = lock_or_poisoned(&host.pokes);
        assert!(pokes.len() >= 2, "ready 마다 owner poke(부팅 스캔·리스폰 되먹임): {pokes:?}");
    }

    #[test]
    fn crash_cap_lands_in_error_state_loudly() {
        let host = Arc::new(MockHost::default());
        let spawner = Arc::new(FakeSpawner {
            script: Arc::new(|_gen, mut conn: FakeConn| {
                conn.hello(&["run"]);
                let _ = conn.read_frame(); // ready 받고 즉시 크래시(전 세대)
            }),
            spawns: AtomicUsize::new(0),
        });
        let mgr = ServiceManager::with_backoff(host.clone(), spawner.clone(), vec![5, 5]);
        mgr.bind(binding(&["run"]));
        let st = wait_status(&mgr, "demo", |s| matches!(s, SvcStatus::Error(_)));
        assert!(matches!(st, SvcStatus::Error(ref r) if r.contains("크래시 상한")), "{st:?}");
        assert_eq!(spawner.spawns.load(Ordering::SeqCst), 3, "원 스폰 + 백오프 2회");
    }

    #[test]
    fn crash_answers_inflight_pending_immediately() {
        let script: Script = Arc::new(|_gen, mut conn: FakeConn| {
            conn.hello(&["run"]);
            let _ = conn.read_frame(); // ready
            let _ = conn.read_frame(); // req 받고 응답 없이 크래시
        });
        let (mgr, _host, _sp) = manager(script);
        mgr.bind(binding(&["run"]));
        let started = std::time::Instant::now();
        let out = mgr
            .dispatch("plugin.demo.run", json!({}), None, "socket", None, 30_000, 60_000)
            .expect("소유 커맨드");
        assert_eq!(out["ok"], false);
        assert_eq!(out["code"], "INTERNAL");
        assert!(started.elapsed() < Duration::from_secs(5), "타임아웃 방치 금지 — 즉시 응답(PS12)");
    }

    // ── PS10: 드레인 재시작 — in-flight 완주 후 교체, 새 req 는 큐잉 ──────────

    #[test]
    fn drain_restart_completes_inflight_then_replaces_the_process() {
        let script: Script = Arc::new(|generation, mut conn: FakeConn| {
            conn.hello(&["work"]);
            loop {
                match conn.read_frame() {
                    Some(ServiceIn::Req { id, .. }) => {
                        std::thread::sleep(Duration::from_millis(80));
                        conn.write_out(&ServiceOut::Res {
                            id, ok: true, code: None, message: None, hints: None,
                            data: Some(json!({ "generation": generation })),
                        });
                    }
                    Some(ServiceIn::Shutdown) | None => return,
                    _ => {}
                }
            }
        });
        let (mgr, host, _sp) = manager(script);
        mgr.bind(binding(&["work"]));
        wait_status(&mgr, "demo", |s| matches!(s, SvcStatus::Ready));
        let mgr = Arc::new(mgr);
        let m2 = mgr.clone();
        let inflight = std::thread::spawn(move || {
            m2.dispatch("plugin.demo.work", json!({}), None, "socket", None, 5_000, 10_000)
        });
        std::thread::sleep(Duration::from_millis(20)); // in-flight 진입 보장
        assert!(mgr.drain_restart("demo"), "Ready 상태에서 드레인 수용");
        let first = inflight.join().expect("join").expect("in-flight");
        assert_eq!(first["data"]["generation"], 1, "in-flight 는 옛 세대에서 완주(도는 중 안 자름)");
        let after = mgr
            .dispatch("plugin.demo.work", json!({}), None, "socket", None, 5_000, 10_000)
            .expect("소유 커맨드");
        assert_eq!(after["data"]["generation"], 2, "드레인 후 요청은 새 세대로: {after}");
        let ev = events_of(&host);
        assert!(ev.contains(&"service.draining".to_string()) && ev.contains(&"service.restarted".to_string()), "{ev:?}");
    }

    // ── PS9: 시크릿 all-or-nothing — 미해소면 Error, 부분 주입 금지 ───────────

    #[test]
    fn unresolved_declared_secret_refuses_the_spawn() {
        let (mgr, host, spawner) = manager(echo_script());
        let mut b = binding(&["run", "fail"]);
        b.secrets = vec!["OK_ONE".into(), "MISSING".into()];
        mgr.bind(b);
        let st = wait_status(&mgr, "demo", |s| matches!(s, SvcStatus::Error(_)));
        assert!(matches!(st, SvcStatus::Error(ref r) if r.contains("MISSING")), "{st:?}");
        assert_eq!(spawner.spawns.load(Ordering::SeqCst), 0, "미해소 시크릿이면 스폰 자체가 없다");
        assert!(events_of(&host).contains(&"service.error".to_string()));
    }

    // ── PS10: kill_all — pending 즉시 응답 + Stopped ─────────────────────────

    #[test]
    fn kill_all_answers_pending_and_stops() {
        let script: Script = Arc::new(|_gen, mut conn: FakeConn| {
            conn.hello(&["hang"]);
            let _ = conn.read_frame(); // ready
            let _ = conn.read_frame(); // req — 영영 무응답
            loop {
                match conn.read_frame() {
                    Some(ServiceIn::Shutdown) | None => return,
                    _ => {}
                }
            }
        });
        let (mgr, _host, _sp) = manager(script);
        mgr.bind(binding(&["hang"]));
        wait_status(&mgr, "demo", |s| matches!(s, SvcStatus::Ready));
        let mgr = Arc::new(mgr);
        let m2 = mgr.clone();
        let hung = std::thread::spawn(move || {
            m2.dispatch("plugin.demo.hang", json!({}), None, "socket", None, 30_000, 60_000)
        });
        std::thread::sleep(Duration::from_millis(50));
        mgr.kill_all();
        let out = hung.join().expect("join").expect("소유 커맨드");
        assert_eq!(out["code"], "UNAVAILABLE", "종료 시 pending 즉시 응답: {out}");
        assert_eq!(mgr.status_of("demo"), Some(SvcStatus::Stopped));
    }
}
