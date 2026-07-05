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
use std::time::Duration;

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
}

// 마지막으로 포커스된 창 label(활성 창 추적). lib.rs on_window_event 의 Focused(true) 가 갱신.
// 소켓 명령이 window 를 생략하면 이 창으로 라우팅된다.
static LAST_FOCUSED: LazyLock<Mutex<String>> = LazyLock::new(|| Mutex::new("main".to_string()));

pub fn note_focus(label: &str) {
    if let Ok(mut f) = LAST_FOCUSED.lock() {
        *f = label.to_string();
    }
}

fn active_window() -> String {
    LAST_FOCUSED
        .lock()
        .ok()
        .map(|f| f.clone())
        .unwrap_or_else(|| "main".to_string())
}

fn parse_request(line: &str) -> Result<Request, String> {
    serde_json::from_str::<Request>(line).map_err(|e| format!("JSON 파싱 실패: {e}"))
}

fn error_reply(code: &str, message: &str) -> Value {
    json!({ "ok": false, "code": code, "message": message })
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

// 소켓 서버 기동. 잔존 소켓이 살아 있으면(다른 인스턴스) 에러, 죽었으면 제거 후 재바인드.
pub fn start(app: AppHandle) -> Result<String, String> {
    let dir = crate::home::soksak_home();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let identifier = app.config().identifier.clone();
    let path = dir.join(format!("{identifier}.sock")).to_string_lossy().to_string();

    if std::path::Path::new(&path).exists() {
        if UnixStream::connect(&path).is_ok() {
            return Err(format!("이미 실행 중인 인스턴스가 소켓을 사용 중: {path}"));
        }
        let _ = std::fs::remove_file(&path); // 죽은 소켓 정리
    }
    let listener = UnixListener::bind(&path).map_err(|e| e.to_string())?;
    // 로컬 사용자 전용(0600).
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    let _ = SOCKET_PATH.set(path.clone());

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let app = app.clone();
            std::thread::spawn(move || handle_conn(app, stream));
        }
    });
    Ok(path)
}

// 앱 종료 시 소켓 파일 정리(다음 기동의 죽은-소켓 처리와 이중 안전).
pub fn cleanup() {
    if let Some(path) = SOCKET_PATH.get() {
        let _ = std::fs::remove_file(path);
    }
}

fn handle_conn(app: AppHandle, stream: UnixStream) {
    let Ok(read_half) = stream.try_clone() else { return };
    let reader = BufReader::new(read_half);
    let mut writer = stream;
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
fn subscribe_stream(app: &AppHandle, req: Request, mut writer: UnixStream) {
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

// 타겟 창의 메인 webview 를 네이티브로 리로드한다(JS 브리지/eval 미경유). webview JS 가 멈춰도
// (행) AppKit 메인 스레드는 살아있어 WKWebView.reload 가 페이지를 다시 띄운다 → 행 복구.
#[cfg(target_os = "macos")]
fn native_reload(app: &AppHandle, label: &str) -> bool {
    let Some(wv) = app.get_webview(label) else { return false };
    wv.with_webview(|pw| unsafe {
        use objc2_web_kit::WKWebView;
        let wk = &*(pw.inner() as *const WKWebView);
        let _ = wk.reload();
    })
    .is_ok()
}

// 비-macos 폴백: 플랫폼 webview 직접접근이 없어 eval 로 리로드한다(JS 가 살아있을 때만 동작).
#[cfg(not(target_os = "macos"))]
fn native_reload(app: &AppHandle, label: &str) -> bool {
    match app.get_webview(label) {
        Some(wv) => wv.eval("location.reload()").is_ok(),
        None => false,
    }
}

// 요청을 *타겟 창의* 프론트 registry 로 전달하고 응답을 기다린다. 타겟 = req.window ?? 활성 창 ??
// "main". broadcast(app.emit) 가 아니라 emit_to(타겟)이라 멀티 윈도우에서 그 창만 응답 → seq 충돌 0.
fn route(app: &AppHandle, req: Request) -> Value {
    let target = req.window.clone().unwrap_or_else(active_window);
    // get_window(Window 레지스트리) — 브라우저 child 를 연 창은 멀티-webview 라 get_webview_window
    // (단일-webview 전용)에서 빠진다. 그걸 쓰면 브라우저 연 창의 모든 소켓 명령이 WINDOW_NOT_FOUND.
    // emit_to(label)은 멀티-webview 여도 그 창 메인 webview 로 도달하므로 라우팅은 정상.
    if app.get_window(&target).is_none() {
        return error_reply("WINDOW_NOT_FOUND", &format!("창을 찾을 수 없음: {target}"));
    }

    // window.reload 는 네이티브로 처리한다(프론트 registry 미경유). 모든 일반 명령은 emit_to 로
    // webview JS 에 보내 응답을 기다리지만, 그 webview 가 멈추면 reload 마저 TIMEOUT 이 되어 복구
    // 수단이 사라진다. 네이티브 WKWebView.reload 는 JS 상태와 무관하게 동작 → 행에서도 리로드 가능.
    if req.method == "window.reload" {
        return if native_reload(app, &target) {
            json!({ "ok": true, "reloaded": true })
        } else {
            error_reply("INTERNAL", &format!("네이티브 webview 리로드 실패: {target}"))
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
    });
    if app.emit_to(&target, "cmd-request", payload).is_err() {
        bridge.pending.lock().unwrap().remove(&seq);
        return error_reply("INTERNAL", "프론트로 요청 전달 실패");
    }

    // 기본 10s(빠른 행 감지). 요청이 timeoutMs 를 주면 그 값으로 — [1s, 3600s] 클램프(무한대기 금지).
    let timeout = Duration::from_millis(clamp_timeout_ms(req.timeout_ms));
    let result = rx.recv_timeout(timeout);
    bridge.pending.lock().unwrap().remove(&seq);
    match result {
        Ok(v) => v,
        Err(_) => error_reply("TIMEOUT", "응답 시간 초과(앱 UI 미응답?)"),
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

// Rust 내부에서 프론트 registry 명령을 실행한다(딥링크 라우팅·스케줄러 발화 공용 — 소켓 서버와 같은
// CmdBridge 경로 재사용, 새 채널 발명 0). 활성 창으로 라우팅하고 결과를 동기 대기한다(route 가 [1s,3600s]
// 클램프). registry 가 단일 실행 표면이므로 Rust 기능은 이 한 경로로만 명령을 부른다(R8 단일 경로).
pub fn request_command(app: &AppHandle, method: String, params: Value, timeout_ms: u64) -> Value {
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
        },
    )
}

// 스트리밍 발화 프리미티브 — emit + pending 채널만 노출(단일 recv·[1s,3600s] 클램프 없음). 호출자(스케줄러
// heartbeat 경로)가 직접 recv_timeout 루프로 staleness/backstop 을 관리한다(프로세스-생존 lease — 도는 중
// 안 자름). 반환=(seq, rx). 호출자는 종료 시 close_request(seq)로 pending 을 회수해야 한다(cancel 도 호출 →
// tx drop → rx Disconnected 로 대기 즉시 깨움). emit 실패면 None.
pub fn open_request(app: &AppHandle, method: String, params: Value) -> Option<(u64, mpsc::Receiver<Value>)> {
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
