// AI 명령 인터페이스의 전송 계층: Unix Domain Socket JSON-RPC 서버 + 프론트 브리지.
// kitty remote control 과 동일 모델 — 소켓 한 줄(JSON) 요청 → 한 줄(JSON) 응답.
//   요청: {"id":<any>, "method":"panel.split", "params":{...}, "pane":"p3"}
//   응답: {"ok":true, ...} | {"ok":false, "code":"...", "message":"..."} (+ id echo)
// 명령 실행은 프론트 Command Registry 가 담당: Rust 는 emit("cmd-request") 로 전달하고
// 프론트가 invoke(cmd_result) 로 회신한다(요청 seq 매칭, 기본 타임아웃 10s — 요청별 timeoutMs 로
// 상향 가능, [1s,3600s] 클램프. 실 LLM 에이전트 턴처럼 느린 커맨드용). 폴링 없음.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

// PTY 가 SOKSAK_SOCKET 으로 주입할 소켓 경로(서버 기동 시 1회 설정).
static SOCKET_PATH: OnceLock<String> = OnceLock::new();

pub fn socket_path() -> Option<&'static str> {
    SOCKET_PATH.get().map(|s| s.as_str())
}

#[derive(Default)]
pub struct CmdBridge {
    // 요청 seq → 응답 채널. 프론트의 cmd_result 가 채운다.
    pending: Mutex<HashMap<u64, mpsc::SyncSender<Value>>>,
}

static SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Deserialize)]
struct Request {
    // 클라이언트 상관 id(있으면 응답에 echo).
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
    pane: Option<String>,
    // 멀티 윈도우 타겟 창 label. 생략 시 활성 창(마지막 포커스), 그것도 없으면 "main".
    // tmux -t 관례 — 특정 창을 명시할 때 지정한다.
    window: Option<String>,
    // 프론트 응답 대기 상한(ms). 생략 시 10s(정상 커맨드의 빠른 행 감지 유지). 느린 커맨드(실 LLM
    // 에이전트 턴 등)는 크게 지정. [1s, 3600s] 로 클램프(무한대기 금지). camelCase(timeoutMs) 수용.
    #[serde(default, rename = "timeoutMs")]
    timeout_ms: Option<u64>,
    // 상관 부모(대화 턴 id) — 오케스트레이터가 스폰한 에이전트의 SOKSAK_PARENT env 가 sok 을 타고
    // 도착한다. registry trace 를 거쳐 활동 엔트리 payload.parentId 로 실려 턴 세트를 묶는다.
    parent: Option<String>,
    // 실행 유래(MESSAGE-PROTOCOL §5) — 사람 유래(생략)와 시스템 유래("schedule" 등)를 가른다.
    // 시스템 유래는 낭독 후보에서 제외되고 피드에서 흐리게 표시된다. 소켓 클라이언트는 쓰지
    // 않는다(사람/에이전트=사람 유래) — Rust 내부 발화(스케줄러)만 싣는다.
    origin: Option<String>,
    // 클라이언트가 선언하는 소켓 프로토콜 판(soksak-protocol 계약). 부재=0(레거시) —
    // effective_protocol 규칙 하나로 구세대 자동 수용과 미래 차단 스위치를 겸한다.
    protocol: Option<u32>,
}

// 마지막으로 포커스된 창 label(활성 창 추적). lib.rs on_window_event 의 Focused(true) 가 갱신.
// 소켓 명령이 window 를 생략하면 이 창으로 라우팅된다.
static LAST_FOCUSED: LazyLock<Mutex<String>> = LazyLock::new(|| Mutex::new("main".to_string()));

pub fn note_focus(label: &str) {
    if let Ok(mut f) = LAST_FOCUSED.lock() {
        *f = label.to_string();
    }
    // 마지막 워크스페이스(비-main) 포커스 — 자연어 턴의 기본 무대. 오케스트레이터에서 명령을
    // 칠 때 활성 창은 main(컨트롤 플레인)이므로, "사용자가 실제로 일하던 창"은 이 값이다.
    // main 은 플랫폼 예약어(NAMING §1-4b) — 예약어 비교이지 라벨에서 역할 파싱이 아니다.
    if label != "main" {
        if let Ok(mut w) = LAST_WORKSPACE.lock() {
            *w = Some(label.to_string());
        }
    }
}

static LAST_WORKSPACE: Mutex<Option<String>> = Mutex::new(None);

// 마지막 포커스 워크스페이스 창(읽기 전용) — orchestrator.ask 의 기본 무대(SOKSAK_WINDOW).
#[tauri::command]
pub fn ipc_last_project_window() -> Option<String> {
    LAST_WORKSPACE.lock().ok().and_then(|w| w.clone())
}

fn active_window() -> String {
    LAST_FOCUSED
        .lock()
        .ok()
        .map(|f| f.clone())
        .unwrap_or_else(|| "main".to_string())
}

fn last_workspace_window() -> Option<String> {
    LAST_WORKSPACE.lock().ok().and_then(|w| w.clone())
}

// 창 폴백 해석(순수) — 명령이 window 를 생략했을 때의 타겟 결정.
// 플러그인 명령(plugin.* — 네임스페이스 문법이지 특정 id 가 아니다)은 컨트롤 플레인(main)으로
// 폴백하지 않는다: main 은 설계상 플러그인을 싣지 않으므로 그 폴백은 상시 UNKNOWN_COMMAND 다
// (main 포커스 중 스케줄 발화가 통째로 죽던 결함 — PLUGIN-SERVICE 입법 조사에서 확정).
// 폴백 사다리: 마지막 워크스페이스 창(살아있으면) → 살아있는 워크스페이스 창 라벨 정렬 첫
// 항목(결정적 — 포커스 무관) → NO_WORKSPACE_WINDOW. 비-플러그인 명령은 기존 규칙(마지막
// 포커스, main 포함)을 유지한다.
fn resolve_fallback_target(
    method: &str,
    focused: String,
    last_workspace: Option<String>,
    live_workspaces: &[String],
) -> Result<String, ()> {
    if !method.starts_with("plugin.") {
        return Ok(focused);
    }
    if let Some(w) = last_workspace {
        if live_workspaces.iter().any(|l| l == &w) {
            return Ok(w);
        }
    }
    let mut sorted: Vec<&String> = live_workspaces.iter().collect();
    sorted.sort();
    match sorted.first() {
        Some(w) => Ok((*w).clone()),
        None => Err(()),
    }
}

fn parse_request(line: &str) -> Result<Request, String> {
    serde_json::from_str::<Request>(line).map_err(|e| format!("JSON 파싱 실패: {e}"))
}

fn error_reply(code: &str, message: &str) -> Value {
    json!({ "ok": false, "code": code, "message": message })
}

// 서버 기동 시각(ms) — system.hello 의 startedAt. start() 가 1회 기록한다.
static STARTED_AT_MS: OnceLock<u64> = OnceLock::new();

// transport 레벨 응답에 필요한 앱 사실 — 연결당 1회 수집해 transport_route 를 순수하게
// 유지한다(AppHandle 없이 테스트 가능).
struct TransportCtx {
    identity: String,
    app_version: String,
    pid: u32,
    started_at_ms: u64,
}

impl TransportCtx {
    // 연결(handle_conn)과 ipc_hello_info 커맨드가 공유하는 앱 사실 수집 — hello 사실의 단일 출처.
    fn from_app(app: &AppHandle) -> Self {
        TransportCtx {
            identity: app.config().identifier.clone(),
            app_version: app.package_info().version.to_string(),
            pid: std::process::id(),
            started_at_ms: STARTED_AT_MS.get().copied().unwrap_or(0),
        }
    }
}

// system.hello 협상 사실 — 판 상수(soksak-protocol) + 앱 사실. transport 즉답과 ipc_hello_info
// 커맨드가 같은 함수를 쓴다(이중 진실 없음): 봉투의 ok 는 각 계층이 얹는다(transport 는 여기서,
// registry 는 execute 에서). capabilities 는 전송층 행위만 싣는다 — 기능 발견은 카탈로그가 정본.
fn hello_facts(ctx: &TransportCtx) -> Value {
    use soksak_protocol::{MIN_COMPATIBLE_CLIENT_PROTOCOL, SOCKET_PROTOCOL_VERSION};
    json!({
        "protocol": SOCKET_PROTOCOL_VERSION,
        "minClientProtocol": MIN_COMPATIBLE_CLIENT_PROTOCOL,
        "appVersion": ctx.app_version,
        "identity": ctx.identity,
        "pid": ctx.pid,
        "startedAt": ctx.started_at_ms,
        "capabilities": ["hello.v1"],
    })
}

// 프론트 내부 경로(command palette·registry 핸들러)용 hello — transport 즉답과 같은 hello_facts
// 를 반환한다. 소켓/MCP/CLI 는 transport 선점으로 답하고, catalog 의 system.hello 핸들러는 이
// 커맨드로 위임한다 — 어느 경로로 발견해도 같은 사실로 실제 동작한다.
#[tauri::command]
pub fn ipc_hello_info(app: AppHandle) -> Value {
    hello_facts(&TransportCtx::from_app(&app))
}

// transport 레벨 라우트: 프론트 미경유 즉답(webview 가 행이어도 답한다 — 진단 가치).
// ① system.hello — 협상 프리미티브. 스큐 게이트 면제: 스큐된 클라이언트가 두 판 숫자를
//    배울 유일한 통로가 hello 다. capabilities 는 전송층 행위만 싣는다 — 기능 발견은
//    state.commands 카탈로그가 단일진실.
// ② VERSION_SKEW 게이트 — soksak-protocol 호환창 밖의 요청은 dispatch(프론트 registry)에
//    도달하지 못한다. 부재=0 규칙으로 레거시(hello 생략) 클라이언트는 그대로 통과한다.
//    거부 message 는 방향 명시 한 문장(낡은 쪽+두 판 숫자+해결 명령), data 에 숫자 3종 —
//    에이전트가 파싱으로 자가 판정한다.
fn transport_route(req: &Request, ctx: &TransportCtx, lang: soksak_protocol::Lang) -> Option<Value> {
    use soksak_protocol::{
        effective_protocol, evaluate_compat, skew_sentence, Compat, Lang,
        MIN_COMPATIBLE_CLIENT_PROTOCOL, SOCKET_PROTOCOL_VERSION,
    };
    if req.method == "system.hello" {
        let mut reply = hello_facts(ctx);
        if let Some(obj) = reply.as_object_mut() {
            obj.insert("ok".into(), json!(true));
        }
        return Some(reply);
    }
    let declared = effective_protocol(req.protocol);
    let verdict = evaluate_compat(SOCKET_PROTOCOL_VERSION, MIN_COMPATIBLE_CLIENT_PROTOCOL, declared);
    // 스큐 거부 message 는 사람 표면(sok stderr) — 이 앱의 언어 설정으로 해소한다. 이 시선은 앱이
    // 클라이언트를 판정하므로 self=앱, peer=클라이언트다. 명사와 해결 지시는 앱이 소유(크레이트는
    // 문장 골격만 해소).
    let (self_name, peer_name) = match lang {
        Lang::En => ("the app", "the client"),
        Lang::Ko => ("앱", "클라이언트"),
    };
    let remedy = match (verdict, lang) {
        (Compat::Compatible, _) => None,
        (Compat::PeerTooOld { .. }, Lang::En) => {
            Some("run the sok bundled with this app or rerun `sok mcp install`")
        }
        (Compat::PeerTooOld { .. }, Lang::Ko) => {
            Some("이 앱에 동봉된 sok 을 쓰거나 `sok mcp install` 을 다시 실행하세요")
        }
        (Compat::SelfTooOld { .. }, Lang::En) => Some("install the app build this client shipped with"),
        (Compat::SelfTooOld { .. }, Lang::Ko) => Some("이 클라이언트가 함께 배포된 앱 빌드를 설치하세요"),
    };
    let sentence = skew_sentence(verdict, self_name, peer_name, remedy, lang)?;
    let mut reply = error_reply("VERSION_SKEW", &sentence);
    reply["data"] = json!({
        "appProtocol": SOCKET_PROTOCOL_VERSION,
        "minClientProtocol": MIN_COMPATIBLE_CLIENT_PROTOCOL,
        "clientProtocol": declared,
    });
    Some(reply)
}

// 명령 응답 대기 timeout(ms) 정규화. 미지정 시 기본 10s(빠른 행 감지). [1s, 3600s] 클램프:
// 무한대기는 금지(hung UI 하드캡)하되, 단일 LLM 턴(검색 fan-out + 긴 추론, 30분+)이 provider
// 강제종료 캡 안에서 끝까지 응답을 기다릴 수 있어야 한다 — 천장이 provider 캡(soksak-workflow
// provider.rs)보다 짧으면 provider 가 도는 중 스케줄러/호출자가 먼저 TIMEOUT → 중복 발화.
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 3_600_000;
const DEFAULT_TIMEOUT_MS: u64 = 10_000;

fn clamp_timeout_ms(requested: Option<u64>) -> u64 {
    requested
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
}

// ─── 전송 시임(transport seam) ──────────────────────────────────────────────
// JSON-RPC 서버가 OS 전송을 만지는 유일한 경계. 오늘의 구현은 unix domain socket
// 하나이고, Windows named pipe 전송(W2 M0)은 이 두 trait 를 구현해 같은 자리에
// 꽂힌다 — handle_conn 이하 프로토콜 코드는 전송 종류를 모른다. 이 시임 밖에서
// 플랫폼 소켓 타입을 쓰지 않는다.

trait IpcConnection: std::io::Read + std::io::Write + Send {
    // 같은 연결의 독립 핸들(handle_conn 의 reader/writer 분리용).
    fn try_clone_conn(&self) -> std::io::Result<Box<dyn IpcConnection>>;
}

trait IpcListenerSeam: Send {
    fn accept_conn(&self) -> std::io::Result<Box<dyn IpcConnection>>;
}

impl IpcConnection for UnixStream {
    fn try_clone_conn(&self) -> std::io::Result<Box<dyn IpcConnection>> {
        self.try_clone().map(|s| Box::new(s) as Box<dyn IpcConnection>)
    }
}

struct UnixIpcListener(UnixListener);

impl IpcListenerSeam for UnixIpcListener {
    fn accept_conn(&self) -> std::io::Result<Box<dyn IpcConnection>> {
        self.0.accept().map(|(s, _)| Box::new(s) as Box<dyn IpcConnection>)
    }
}

// unix 전송 바인드. 죽은 소켓 정리·중복 인스턴스 거부·0600 퍼미션까지가 전송 소관 —
// 잔존 소켓이 살아 있으면(다른 인스턴스) 에러, 죽었으면 제거 후 재바인드.
fn bind_transport(path: &str) -> Result<Box<dyn IpcListenerSeam>, String> {
    if std::path::Path::new(path).exists() {
        if UnixStream::connect(path).is_ok() {
            return Err(format!("이미 실행 중인 인스턴스가 소켓을 사용 중: {path}"));
        }
        let _ = std::fs::remove_file(path); // 죽은 소켓 정리
    }
    let listener = UnixListener::bind(path).map_err(|e| e.to_string())?;
    // 로컬 사용자 전용(0600).
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    Ok(Box::new(UnixIpcListener(listener)))
}

// 소켓 서버 기동 — 전송은 bind_transport 시임 뒤에서 온다.
pub fn start(app: AppHandle) -> Result<String, String> {
    let dir = crate::home::soksak_home();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let identifier = app.config().identifier.clone();
    let path = dir.join(format!("{identifier}.sock")).to_string_lossy().to_string();

    let listener = bind_transport(&path)?;
    let _ = SOCKET_PATH.set(path.clone());
    // system.hello 의 startedAt — 서버 기동 시각을 1회 기록.
    let _ = STARTED_AT_MS.set(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    );

    std::thread::spawn(move || loop {
        let Ok(conn) = listener.accept_conn() else { continue };
        let app = app.clone();
        std::thread::spawn(move || handle_conn(app, conn));
    });
    Ok(path)
}

// 앱 종료 시 소켓 파일 정리(다음 기동의 죽은-소켓 처리와 이중 안전).
pub fn cleanup() {
    if let Some(path) = SOCKET_PATH.get() {
        let _ = std::fs::remove_file(path);
    }
}

fn handle_conn(app: AppHandle, conn: Box<dyn IpcConnection>) {
    let ctx = TransportCtx::from_app(&app);
    // 스큐 거부 문장의 언어를 연결당 1회 조회한다(사람 표면 — 폴링 없음). 연결은 sok 호출당 하나라
    // 잦지 않다. transport_route 는 순수 유지 — 해소된 언어만 넘긴다.
    let lang = crate::i18n::app_language(&app);
    let Ok(read_half) = conn.try_clone_conn() else { return };
    let reader = BufReader::new(read_half);
    let mut writer = conn;
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let req = match parse_request(&line) {
            Err(msg) => {
                if writeln!(writer, "{}", error_reply("INVALID_PARAMS", &msg)).is_err() {
                    break;
                }
                continue;
            }
            Ok(req) => req,
        };
        // transport 선점(hello 즉답+스큐 게이트) — events.subscribe 포함 전 명령이 게이트를
        // 지나도록 dispatch/subscribe 보다 먼저 평가한다. id echo 는 여기서 직접 박는다.
        if let Some(mut reply) = transport_route(&req, &ctx, lang) {
            if reply["code"] == "VERSION_SKEW" {
                // 스큐 거부는 registry 계측에 도달하지 못하는 실행이다 — 라우팅 계층 기록
                // 계약(command.executed)과 동일하게 여기서 발행해 관찰 공백을 막는다.
                let target = req.window.clone().unwrap_or_else(active_window);
                let message = reply["message"].as_str().unwrap_or_default().to_string();
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                record_route_outcome(&app, &req.method, &req.params, &target, &req.parent, &req.origin, false, "VERSION_SKEW", &message, now);
            }
            if let (Some(cid), Some(obj)) = (req.id.clone(), reply.as_object_mut()) {
                obj.insert("id".into(), cid);
            }
            if writeln!(writer, "{reply}").is_err() {
                break;
            }
            continue;
        }
        // events.subscribe 는 transport 레벨(A2 — window.reload 선례): 확인 응답 1회 후 이
        // 연결을 push 스트림으로 전환한다(요청-응답 프로토콜에서 이탈 — 연결 수명 = 구독 수명).
        if req.method == "events.subscribe" {
            subscribe_stream(&app, req, writer);
            return;
        }
        let reply = dispatch(&app, req);
        if writeln!(writer, "{reply}").is_err() {
            break;
        }
    }
}

// 활동 스트림 push 루프(A2 — P11 이벤트 스트림). params: kinds?=서버측 필터(prefix 매칭),
// since?=백필 커서(exclusive seq). 백필(링에서) 후 라이브 전환 — 구독자 큐는 bounded·drop-oldest
// (느린 소비자가 발행을 못 막고, 유실은 seq gap 으로 드러나 클라이언트가 since 재접속으로 메꾼다).
// 연결이 끊기면(write 실패) 구독 해지. 폴링 없음 — Condvar 대기.
fn subscribe_stream(app: &AppHandle, req: Request, mut writer: Box<dyn IpcConnection>) {
    let kinds: Vec<String> = req
        .params
        .get("kinds")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
        .unwrap_or_default();
    let since = req.params.get("since").and_then(Value::as_u64);
    let matches = |e: &Value| -> bool {
        if kinds.is_empty() {
            return true;
        }
        let k = e.get("kind").and_then(Value::as_str).unwrap_or("");
        kinds.iter().any(|f| k == f || k.starts_with(&format!("{f}.")))
    };

    let hub = app.state::<crate::activity::ActivityHub>();
    let sub = hub.subscribe(); // 백필 조회 전에 등록 — 조회↔라이브 사이 공백 0(중복은 seq 로 dedup 가능)
    let mut ack = json!({ "ok": true, "subscribed": true });
    if let (Some(cid), Some(obj)) = (req.id.clone(), ack.as_object_mut()) {
        obj.insert("id".into(), cid);
    }
    if writeln!(writer, "{ack}").is_err() {
        hub.unsubscribe(&sub);
        return;
    }
    let mut last_seq = since.unwrap_or(0);
    if since.is_some() {
        for e in hub.recent(since, usize::MAX) {
            if !matches(&e) {
                continue;
            }
            last_seq = e.get("seq").and_then(Value::as_u64).unwrap_or(last_seq);
            if writeln!(writer, "{e}").is_err() {
                hub.unsubscribe(&sub);
                return;
            }
        }
    }
    while let Some(e) = sub.pop_wait() {
        // 백필과 라이브의 겹침 제거(seq 단조) + kinds 필터.
        let seq = e.get("seq").and_then(Value::as_u64).unwrap_or(0);
        if seq <= last_seq || !matches(&e) {
            continue;
        }
        last_seq = seq;
        if writeln!(writer, "{e}").is_err() {
            break;
        }
    }
    hub.unsubscribe(&sub);
}

// 클라이언트 상관 id echo 를 단일 지점에서 보장한다 — route 가 어떤 경로(WINDOW_NOT_FOUND·INTERNAL·
// TIMEOUT·정상)로 끝나든 응답에 id 를 박는다. early return 마다 echo 를 흩뿌리면 누락이 생긴다
// (클라이언트가 seq 매칭 실패 → 무한 대기). id echo 는 라우팅 로직과 직교하므로 바깥에서 1회.
fn dispatch(app: &AppHandle, req: Request) -> Value {
    let cid = req.id.clone();
    let mut out = route(app, req);
    if let (Some(cid), Some(obj)) = (cid, out.as_object_mut()) {
        obj.insert("id".into(), cid);
    }
    out
}

// 타겟 창의 메인 webview 를 네이티브로 리로드한다(JS 브리지/eval 미경유). Tauri(wry) reload 는
// WKWebView.reload / WebView2.Reload / WebKitGTK 를 dispatcher 로 직접 호출 — webview JS 가 멈춰도
// (행) 페이지를 다시 띄운다(행 복구). 전 플랫폼 동일 native 경로(cfg 분기·eval 폴백 제거).
fn native_reload(app: &AppHandle, label: &str) -> bool {
    match app.get_webview(label) {
        Some(wv) => {
            // 의도된 reload 예고(webview_health) — 행 프로세스를 죽이며 나는 종료를
            // 크래시로 오분류하지 않는다(마크는 1회 소모·수 초 내 만료).
            crate::webview_health::mark_expected_teardown(app, label);
            wv.reload().is_ok()
        }
        None => false,
    }
}

// 요청을 *타겟 창의* 프론트 registry 로 전달하고 응답을 기다린다. 타겟 = req.window ?? 활성 창 ??
// "main". broadcast(app.emit) 가 아니라 emit_to(타겟)이라 멀티 윈도우에서 그 창만 응답 → seq 충돌 0.
// 라우팅 계층의 실행 기록(§5 R2) — 창 라우팅에서 끝난 명령(WINDOW_NOT_FOUND·전달 실패·TIMEOUT·
// 네이티브 reload)은 executor(창 JS)의 registry 계측에 도달하지 못해 활동 기록이 없는 사각지대였다
// (실측: 닫힌 창으로 보낸 명령들이 무기록 — 관찰 공백). 여기서 동일 계약(command.executed)으로
// 발행한다. 낭독 규칙도 registry 와 동일: 사람 유래(무 origin)만 message 를 낭독 후보로 싣는다.
#[allow(clippy::too_many_arguments)]
fn record_route_outcome(
    app: &AppHandle,
    method: &str,
    params: &Value,
    target: &str,
    parent: &Option<String>,
    origin: &Option<String>,
    ok: bool,
    code: &str,
    message: &str,
    started_ms: u64,
) {
    let finished = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(started_ms);
    let param_keys: Vec<String> = params
        .as_object()
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    let mut payload = serde_json::json!({
        "command": method,
        "ok": ok,
        "code": code,
        "message": message,
        "paramKeys": param_keys,
        "durationMs": finished.saturating_sub(started_ms),
        "startedAt": started_ms,
        "finishedAt": finished,
        "window": target,
    });
    if let Some(pv) = parent {
        payload["parentId"] = serde_json::json!(pv);
    }
    match origin {
        Some(o) => payload["origin"] = serde_json::json!(o),
        None => payload["tts"] = serde_json::json!(message),
    }
    crate::activity::publish(app, "command.executed", "remote", payload);
}

fn route(app: &AppHandle, req: Request) -> Value {
    let started_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let target = match req.window.clone() {
        Some(w) => w,
        None => {
            // 워크스페이스 창 목록(w-* 라벨 문법 — NAMING) — 폴백 사다리의 결정적 후보 집합.
            let live: Vec<String> = app
                .windows()
                .keys()
                .filter(|l| l.starts_with("w-"))
                .cloned()
                .collect();
            match resolve_fallback_target(&req.method, active_window(), last_workspace_window(), &live) {
                Ok(t) => t,
                Err(()) => {
                    let message = "플러그인 명령을 받을 워크스페이스 창이 없음(컨트롤 플레인은 플러그인을 싣지 않음)";
                    record_route_outcome(app, &req.method, &req.params, "", &req.parent, &req.origin, false, "NO_WORKSPACE_WINDOW", message, started_ms);
                    return error_reply("NO_WORKSPACE_WINDOW", message);
                }
            }
        }
    };
    // get_window(Window 레지스트리) — 브라우저 child 를 연 창은 멀티-webview 라 get_webview_window
    // (단일-webview 전용)에서 빠진다. 그걸 쓰면 브라우저 연 창의 모든 소켓 명령이 WINDOW_NOT_FOUND.
    // emit_to(label)은 멀티-webview 여도 그 창 메인 webview 로 도달하므로 라우팅은 정상.
    if app.get_window(&target).is_none() {
        let message = format!("창을 찾을 수 없음: {target}");
        record_route_outcome(app, &req.method, &req.params, &target, &req.parent, &req.origin, false, "WINDOW_NOT_FOUND", &message, started_ms);
        return error_reply("WINDOW_NOT_FOUND", &message);
    }

    // window.reload 는 네이티브로 처리한다(프론트 registry 미경유). 모든 일반 명령은 emit_to 로
    // webview JS 에 보내 응답을 기다리지만, 그 webview 가 멈추면 reload 마저 TIMEOUT 이 되어 복구
    // 수단이 사라진다. 네이티브 WKWebView.reload 는 JS 상태와 무관하게 동작 → 행에서도 리로드 가능.
    if req.method == "window.reload" {
        return if native_reload(app, &target) {
            record_route_outcome(app, &req.method, &req.params, &target, &req.parent, &req.origin, true, "OK", "창을 다시 불러왔습니다", started_ms);
            json!({ "ok": true, "reloaded": true })
        } else {
            let message = format!("네이티브 webview 리로드 실패: {target}");
            record_route_outcome(app, &req.method, &req.params, &target, &req.parent, &req.origin, false, "INTERNAL", &message, started_ms);
            error_reply("INTERNAL", &message)
        };
    }
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::sync_channel::<Value>(1);
    let bridge = app.state::<CmdBridge>();
    bridge.pending.lock().unwrap().insert(seq, tx);

    let payload = json!({
        "id": seq,
        "method": req.method,
        "params": req.params,
        "pane": req.pane,
        "window": target,
        "parent": req.parent,
        "origin": req.origin,
    });
    if app.emit_to(&target, "cmd-request", payload).is_err() {
        bridge.pending.lock().unwrap().remove(&seq);
        record_route_outcome(app, &req.method, &req.params, &target, &req.parent, &req.origin, false, "INTERNAL", "프론트로 요청 전달 실패", started_ms);
        return error_reply("INTERNAL", "프론트로 요청 전달 실패");
    }

    // 기본 10s(빠른 행 감지). 요청이 timeoutMs 를 주면 그 값으로 — [1s, 3600s] 클램프(무한대기 금지).
    let timeout = Duration::from_millis(clamp_timeout_ms(req.timeout_ms));
    let result = rx.recv_timeout(timeout);
    bridge.pending.lock().unwrap().remove(&seq);
    match result {
        Ok(v) => v,
        Err(_) => {
            // 호출자 관점의 사실(응답을 못 받았다) — executor 가 늦게 완주하면 그 실행 기록이
            // 별도로 남는다(둘 다 사실 — code=TIMEOUT 이 구분자).
            record_route_outcome(app, &req.method, &req.params, &target, &req.parent, &req.origin, false, "TIMEOUT", "응답 시간 초과(앱 UI 미응답?)", started_ms);
            error_reply("TIMEOUT", "응답 시간 초과(앱 UI 미응답?)")
        }
    }
}

// 프론트 executor 의 회신(요청 seq 매칭).
#[tauri::command]
pub fn cmd_result(bridge: State<CmdBridge>, id: u64, result: Value) {
    if let Some(tx) = bridge.pending.lock().unwrap().remove(&id) {
        let _ = tx.try_send(result);
    }
}

// 제어 소켓 경로(읽기 전용) — PTY 주입(pty.rs)과 같은 정본. 오케스트레이터가 스폰하는
// 에이전트 서브프로세스(PTY 아님 — 자동주입 없음)의 SOKSAK_SOCKET env 로 쓴다.
#[tauri::command]
pub fn ipc_socket_path() -> Option<String> {
    socket_path().map(str::to_string)
}

// 앱과 짝인 `sok` CLI 가 든 디렉토리 — 스폰된 에이전트의 PATH 에 앞세워 `sok …` 이 어느 설치
// 형태에서든 해소되게 한다(사용자 PATH 설치 미전제). 탐색: 실행 파일 디렉토리부터 조상 6단계
// 안에서 `sok` 실물이 있는 첫 디렉토리 — dev(target/debug 직하), debug 번들(bundle/macos/….app/
// Contents/MacOS → target/debug 5단계), 미래 번들 동봉(exe 옆) 모두 이 한 규칙으로 잡힌다.
#[tauri::command]
pub fn ipc_cli_dir() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let mut dir = exe.parent()?.to_path_buf();
    for _ in 0..=6 {
        if dir.join("sok").is_file() {
            return Some(dir.to_string_lossy().into_owned());
        }
        dir = dir.parent()?.to_path_buf();
    }
    None
}

// Rust 내부에서 프론트 registry 명령을 실행한다(딥링크 라우팅·스케줄러 발화 공용 — 소켓 서버와 같은
// CmdBridge 경로 재사용, 새 채널 발명 0). 활성 창으로 라우팅하고 결과를 동기 대기한다(route 가 [1s,3600s]
// 클램프). registry 가 단일 실행 표면이므로 Rust 기능은 이 한 경로로만 명령을 부른다(R8 단일 경로).
// origin: 사람 유래(딥링크 = 사람 클릭)는 None, 시스템 유래(스케줄러)는 Some("schedule") —
// 활동 스트림의 낭독·표시 규칙이 이 축을 소비한다(MESSAGE-PROTOCOL §5).
pub fn request_command(
    app: &AppHandle,
    method: String,
    params: Value,
    timeout_ms: u64,
    origin: Option<&str>,
) -> Value {
    route(
        app,
        Request {
            id: None,
            method,
            params,
            pane: None,
            window: None,
            timeout_ms: Some(timeout_ms),
            parent: None,
            origin: origin.map(str::to_string),
            // Rust 내부 발화는 같은 빌드다 — 스큐가 구조적으로 불가능(게이트도 미경유).
            protocol: None,
        },
    )
}

// 스트리밍 발화 프리미티브 — emit + pending 채널만 노출(단일 recv·[1s,3600s] 클램프 없음). 호출자(스케줄러
// heartbeat 경로)가 직접 recv_timeout 루프로 staleness/backstop 을 관리한다(프로세스-생존 lease — 도는 중
// 안 자름). 반환=(seq, rx). 호출자는 종료 시 close_request(seq)로 pending 을 회수해야 한다(cancel 도 호출 →
// tx drop → rx Disconnected 로 대기 즉시 깨움). emit 실패면 None.
pub fn open_request(
    app: &AppHandle,
    method: String,
    params: Value,
    origin: Option<&str>,
) -> Option<(u64, mpsc::Receiver<Value>)> {
    let target = active_window();
    if app.get_window(&target).is_none() {
        return None;
    }
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::sync_channel::<Value>(1);
    let bridge = app.state::<CmdBridge>();
    bridge.pending.lock().unwrap().insert(seq, tx);
    let payload = json!({
        "id": seq,
        "method": method,
        "params": params,
        "pane": Value::Null,
        "window": target,
        "origin": origin,
    });
    if app.emit_to(&target, "cmd-request", payload).is_err() {
        bridge.pending.lock().unwrap().remove(&seq);
        return None;
    }
    Some((seq, rx))
}

// pending 회수(멱등) — 정상 완료·좀비 포기·cancel 공용. 남은 tx 를 drop 해 호출자 rx 를 깨운다.
pub fn close_request(app: &AppHandle, seq: u64) {
    app.state::<CmdBridge>().pending.lock().unwrap().remove(&seq);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_request() {
        let r = parse_request(
            r#"{"id":7,"method":"panel.split","params":{"side":"right"},"pane":"p3"}"#,
        )
        .unwrap();
        assert_eq!(r.method, "panel.split");
        assert_eq!(r.id, Some(json!(7)));
        assert_eq!(r.pane.as_deref(), Some("p3"));
        assert_eq!(r.params["side"], "right");
    }

    #[test]
    fn parses_minimal_request_with_defaults() {
        let r = parse_request(r#"{"method":"state.tree"}"#).unwrap();
        assert_eq!(r.method, "state.tree");
        assert!(r.id.is_none());
        assert!(r.pane.is_none());
        assert!(r.params.is_null());
    }

    #[test]
    fn rejects_invalid_json_with_structured_error() {
        let msg = parse_request("not json").unwrap_err();
        let reply = error_reply("INVALID_PARAMS", &msg);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["code"], "INVALID_PARAMS");
    }

    // ── transport 레벨 협상(system.hello + VERSION_SKEW 게이트) ──────────────

    fn test_ctx() -> TransportCtx {
        TransportCtx {
            identity: "com.soksak.test".into(),
            app_version: "0.9.9".into(),
            pid: 4242,
            started_at_ms: 1_700_000_000_000,
        }
    }

    // system.hello 는 프론트 미경유 즉답이다(webview 가 행이어도 답한다 — 진단 가치).
    #[test]
    fn hello_is_answered_at_transport_level() {
        let req = parse_request(r#"{"id":1,"method":"system.hello"}"#).unwrap();
        let reply = transport_route(&req, &test_ctx(), soksak_protocol::Lang::En)
            .expect("system.hello must be answered by the transport, not forwarded to the front");
        assert_eq!(reply["ok"], true);
        assert_eq!(reply["protocol"], soksak_protocol::SOCKET_PROTOCOL_VERSION);
        assert_eq!(reply["minClientProtocol"], soksak_protocol::MIN_COMPATIBLE_CLIENT_PROTOCOL);
        assert_eq!(reply["appVersion"], "0.9.9");
        assert_eq!(reply["identity"], "com.soksak.test");
        assert_eq!(reply["pid"], 4242);
        assert_eq!(reply["startedAt"], 1_700_000_000_000u64);
        let caps = reply["capabilities"].as_array().expect("capabilities array");
        assert!(caps.iter().any(|c| c == "hello.v1"), "hello.v1 capability advertised");
    }

    // transport 즉답과 ipc_hello_info(프론트 경로)는 같은 hello_facts 에서 나온다 — 판 상수의
    // 단일 출처. 봉투 ok 는 hello_facts 밖(각 계층이 얹음)임을 함께 고정한다.
    #[test]
    fn transport_hello_reply_is_hello_facts_plus_envelope_ok() {
        let ctx = test_ctx();
        let facts = hello_facts(&ctx);
        assert!(facts.get("ok").is_none(), "hello_facts 는 사실만 — 봉투 ok 는 밖에서 얹는다");
        let req = parse_request(r#"{"method":"system.hello"}"#).expect("valid hello request");
        let reply = transport_route(&req, &ctx, soksak_protocol::Lang::En)
            .expect("hello answered at transport");
        assert_eq!(reply["ok"], true);
        for (k, v) in facts.as_object().expect("hello_facts is a json object") {
            assert_eq!(&reply[k], v, "transport hello field {k} must derive from hello_facts");
        }
    }

    // 스큐 요청은 dispatch(프론트 registry)에 도달하기 전에 거부되어야 한다.
    // 라이브 실측 RED(2026-07-11): {"method":"state.context","protocol":999} 가 ok:true 로
    // 그대로 실행됐다 — 게이트 부재.
    #[test]
    fn skewed_request_is_rejected_before_dispatch() {
        let req = parse_request(r#"{"id":2,"method":"state.context","protocol":999}"#).unwrap();
        let reply = transport_route(&req, &test_ctx(), soksak_protocol::Lang::En)
            .expect("a version-skewed request must be rejected at the transport");
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["code"], "VERSION_SKEW");
        let msg = reply["message"].as_str().expect("message string");
        assert!(msg.contains("999"), "peer version number in the sentence: {msg}");
        assert!(
            msg.contains(&soksak_protocol::SOCKET_PROTOCOL_VERSION.to_string()),
            "own version number in the sentence: {msg}"
        );
        // 방향 명시: 이 사분면(클라이언트가 더 새것)에서 낡은 쪽은 앱이다.
        assert!(msg.contains("update the app"), "stale side named explicitly: {msg}");
        // 봉투 data 로 숫자도 반환 — 에이전트가 파싱으로 자가 판정할 수 있게.
        assert_eq!(reply["data"]["appProtocol"], soksak_protocol::SOCKET_PROTOCOL_VERSION);
        assert_eq!(reply["data"]["clientProtocol"], 999);
    }

    // 스큐 거부 message 는 사람 표면 — 앱 언어가 ko 면 한국어로 해소한다. 봉투 data 의 숫자는
    // 언어 독립(기계 자가 판정 보존).
    #[test]
    fn skew_message_resolves_to_app_language() {
        let req = parse_request(r#"{"id":2,"method":"state.context","protocol":999}"#)
            .expect("valid skew request");
        let reply = transport_route(&req, &test_ctx(), soksak_protocol::Lang::Ko)
            .expect("a version-skewed request must be rejected at the transport");
        assert_eq!(reply["code"], "VERSION_SKEW");
        let msg = reply["message"].as_str().expect("message string");
        assert!(msg.contains("999"), "peer version number in the sentence: {msg}");
        assert!(msg.contains("소켓 프로토콜"), "Korean grammar: {msg}");
        assert!(msg.contains("업데이트하세요"), "stale side named in Korean: {msg}");
        assert!(!msg.contains("speaks socket protocol"), "no English grammar leak: {msg}");
        // data 숫자는 언어와 무관하게 그대로.
        assert_eq!(reply["data"]["clientProtocol"], 999);
    }

    // 부재=0 규칙: hello 를 모르는 구세대 클라이언트는 protocol 필드가 없고, 0 은 현행
    // 호환창(floor=0) 안이므로 그대로 dispatch 로 흐른다.
    #[test]
    fn legacy_request_without_protocol_reaches_dispatch() {
        let req = parse_request(r#"{"method":"state.tree"}"#).unwrap();
        assert!(
            transport_route(&req, &test_ctx(), soksak_protocol::Lang::En).is_none(),
            "legacy peers are judged as protocol 0 and stay inside the window"
        );
    }

    #[test]
    fn current_protocol_request_reaches_dispatch() {
        let line = format!(
            r#"{{"method":"state.tree","protocol":{}}}"#,
            soksak_protocol::SOCKET_PROTOCOL_VERSION
        );
        let req = parse_request(&line).unwrap();
        assert!(transport_route(&req, &test_ctx(), soksak_protocol::Lang::En).is_none());
    }

    // ── 전송 시임 계약 ───────────────────────────────────────────────────────
    // handle_conn 이하가 기대는 성질만 검사한다: accept 가 연결을 내주고, 클론 핸들로
    // reader/writer 를 분리해 줄 단위 왕복이 성립한다. 플랫폼 전송(named pipe)이 이
    // trait 쌍을 구현하면 같은 테스트 형태를 상속한다.

    fn seam_test_path(tag: &str) -> String {
        let p = std::env::temp_dir().join(format!("soksak-ipc-seam-{tag}-{}.sock", std::process::id()));
        let s = p.to_string_lossy().to_string();
        let _ = std::fs::remove_file(&s);
        s
    }

    #[test]
    fn transport_seam_round_trips_a_line() {
        let path = seam_test_path("rt");
        let listener = bind_transport(&path).expect("bind");
        let server = std::thread::spawn(move || {
            let conn = listener.accept_conn().expect("accept");
            let mut reader = BufReader::new(conn.try_clone_conn().expect("clone"));
            let mut line = String::new();
            reader.read_line(&mut line).expect("read");
            let mut writer = conn;
            writeln!(writer, "echo:{}", line.trim()).expect("write");
        });
        let mut client = UnixStream::connect(&path).expect("connect");
        writeln!(client, "ping").expect("client write");
        let mut resp = String::new();
        BufReader::new(client).read_line(&mut resp).expect("client read");
        assert_eq!(resp.trim(), "echo:ping");
        server.join().expect("server thread");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn stale_socket_file_is_replaced_on_bind() {
        let path = seam_test_path("stale");
        drop(bind_transport(&path).expect("first bind"));
        // 리스너가 죽었지만 소켓 파일은 남는다 — 재바인드가 정리하고 성공해야 한다.
        assert!(std::path::Path::new(&path).exists(), "socket file survives the listener");
        let rebound = bind_transport(&path);
        assert!(rebound.is_ok(), "stale socket must be cleaned and rebound: {:?}", rebound.err());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn live_socket_refuses_a_second_instance() {
        let path = seam_test_path("live");
        let _held = bind_transport(&path).expect("first bind");
        let second = bind_transport(&path);
        assert!(second.is_err(), "a live socket must refuse a second bind");
        let _ = std::fs::remove_file(&path);
    }

    // 창 폴백 사다리 — 플러그인 명령은 컨트롤 플레인(main)으로 폴백하지 않는다.
    // main 포커스 상태의 스케줄/소켓 발화가 UNKNOWN_COMMAND 로 죽던 결함의 재현 기준.
    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn plugin_fallback_prefers_last_workspace_over_focused_main() {
        let got = resolve_fallback_target(
            "plugin.demo.run",
            "main".into(),
            Some("w-b".into()),
            &s(&["w-a", "w-b"]),
        );
        assert_eq!(got, Ok("w-b".to_string()));
    }

    #[test]
    fn plugin_fallback_uses_sorted_live_workspace_when_last_is_dead() {
        let got = resolve_fallback_target(
            "plugin.demo.run",
            "main".into(),
            Some("w-dead".into()),
            &s(&["w-b", "w-a"]),
        );
        assert_eq!(got, Ok("w-a".to_string()), "결정적 선택 — 라벨 정렬 첫 항목(포커스 무관)");
    }

    #[test]
    fn plugin_fallback_with_no_workspace_is_an_explicit_error() {
        let got = resolve_fallback_target("plugin.demo.run", "main".into(), None, &[]);
        assert_eq!(got, Err(()), "main 라우팅(상시 UNKNOWN_COMMAND) 대신 구조적 거부");
    }

    #[test]
    fn plugin_fallback_keeps_focused_workspace_window() {
        let got = resolve_fallback_target(
            "plugin.demo.run",
            "w-a".into(),
            Some("w-a".into()),
            &s(&["w-a"]),
        );
        assert_eq!(got, Ok("w-a".to_string()));
    }

    #[test]
    fn non_plugin_fallback_keeps_the_focused_window_including_main() {
        let got = resolve_fallback_target("window.open", "main".into(), Some("w-a".into()), &s(&["w-a"]));
        assert_eq!(got, Ok("main".to_string()), "코어 명령의 기존 규칙 불변");
    }

    // timeout 클램프 경계 — 핵심: >600s(구 상한)가 그대로 통과해야 LLM 30분+ 턴을 끝까지 기다린다.
    // 천장이 provider 강제종료 캡(900s)보다 짧으면 provider 가 도는 중 TIMEOUT → 중복 발화(회귀 방지).
    #[test]
    fn timeout_clamp_bounds() {
        assert_eq!(clamp_timeout_ms(None), 10_000); // 미지정 → 기본 10s.
        assert_eq!(clamp_timeout_ms(Some(0)), 1_000); // 하한 1s.
        assert_eq!(clamp_timeout_ms(Some(500)), 1_000);
        assert_eq!(clamp_timeout_ms(Some(900_000)), 900_000); // provider 캡 = 통과(구 600s 였으면 막힘).
        assert_eq!(clamp_timeout_ms(Some(1_800_000)), 1_800_000); // 30분 LLM 턴 통과.
        assert_eq!(clamp_timeout_ms(Some(3_600_000)), 3_600_000); // 천장 정확히.
        assert_eq!(clamp_timeout_ms(Some(7_200_000)), 3_600_000); // 천장 초과 → 하드캡(무한 X).
    }
}
