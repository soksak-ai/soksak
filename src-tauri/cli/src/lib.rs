// sok — soksak 원격 제어 CLI (kitty @ / tmux 모델).
// 실행 중인 soksak 앱의 Unix 소켓(JSON-RPC)으로 명령을 보낸다. 전 기능 카탈로그는
// 앱의 Command Registry 가 단일 진실이며, 이 CLI 는 전송 + 매뉴얼 포맷터일 뿐이다.
//
// 사용:
//   sok <command> [값 | '{"k":"v"}']   # 기본형: sok plugin.install activity / 세밀: JSON
//   sok commands                  # 전체 카탈로그(JSON)
//   sok help <command>            # 단일 명령 매뉴얼
//   sok docs                      # 전체 매뉴얼 마크다운(stdout)
//   sok skill install [--claude|--gemini|--codex|--all] [--dir DIR]   (환경별 스킬: soksak(-dev|-debug))
//
// 컨텍스트: soksak 터미널 안에서는 $SOKSAK_PANE/$SOKSAK_SOCKET 이 자동 주입되어
// 대상 id 를 생략하면 "내 위치"가 기본이 된다.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::OnceLock;

use serde_json::{json, Value};

/// CLI 본체 — 이름별 실물 바이너리(sok/sok-dev/sok-debug)가 자기 기본 환경을 컴파일 타임에
/// 넘긴다. 링크·복사·argv0 추론 없이, 이름은 곧 빌드 산출물이다(P9).
pub fn run(default_env: &'static str) -> ExitCode {
    let _ = DEFAULT_ENV.set(default_env);
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    // 전역 --window 추출 — env(SOKSAK_WINDOW)보다 우선하는 창 명시 타겟. AI 에이전트는 셸 권한이
    // `sok …` prefix 로만 열리므로(env 프리픽스 불가) 플래그가 유일한 창 지정 수단이다.
    let _ = WINDOW_OVERRIDE.set(take_flag_value(&mut args, "--window"));
    match args.first().map(String::as_str) {
        None | Some("-h") | Some("--help") => {
            print_usage();
            ExitCode::SUCCESS
        }
        Some("hello") => run_hello(),
        Some("commands") => run_request("state.commands", Value::Null, true),
        Some("help") => match args.get(1) {
            Some(cmd) => run_help(cmd),
            None => {
                eprintln!("사용: sok help <command>");
                ExitCode::FAILURE
            }
        },
        Some("docs") => {
            let mut rest: Vec<String> = args[1..].to_vec();
            let format = take_flag_value(&mut rest, "--format");
            let lang = take_flag_value(&mut rest, "--lang");
            run_docs(
                rest.iter().any(|a| a == "--core"),
                format.as_deref().unwrap_or("md"),
                lang.as_deref().unwrap_or("en"),
            )
        }
        Some("events") => run_events(&args[1..]),
        Some("skill") => run_skill(&args[1..]),
        Some("mcp") => match args.get(1).map(String::as_str) {
            Some("install") => run_mcp_install(&args[2..]),
            _ => run_mcp(), // bare `sok mcp` = stdio MCP 서버 기동
        },
        Some(method) => {
            let params = match args.get(1) {
                None => Value::Null,
                // 기본형 문법: JSON 이 아닌 단일 값은 {"_": 값} 으로 보낸다 — 코어가 스펙의
                // 유일한 필수 매개변수로 해석한다(예: sok plugin.install activity).
                Some(raw) if !raw.trim_start().starts_with(['{', '[']) => {
                    serde_json::json!({ "_": raw })
                }
                Some(raw) => match serde_json::from_str::<Value>(raw) {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("파라미터 JSON 파싱 실패: {e}");
                        return ExitCode::FAILURE;
                    }
                },
            };
            run_request(method, params, false)
        }
    }
}

fn print_usage() {
    println!(
        "sok — soksak 원격 제어 CLI

사용:
  sok <command> [값 | '{{JSON}}']      명령 실행 — 값 하나면 유일한 필수 매개변수로 전달
                                       (기본형: sok plugin.install activity)
  sok state.tree                      전체 구조(주소록): 모든 id + 패널 rect
  sok hello                           협상/생존 진단 — 앱이 프론트 미경유 즉답(판·버전·pid),
                                      판이 어긋나면 실패 종료(방향 명시 문장)
  sok commands                        전체 명령 카탈로그(JSON)
  sok help <command>                  단일 명령 매뉴얼
  sok docs [--core] [--format md|json] [--lang en|ko]
                                      가능한 명령 전체 레퍼런스(기본 md/en; json=기계용)
  sok events [--kinds a,b] [--since N] 활동 스트림 팔로우(JSONL, Ctrl-C 종료)
  sok skill install [--claude|--gemini|--codex|--all] [--dir DIR]   (환경별 스킬: soksak(-dev|-debug))
                                      AI 에이전트 트리거 스킬 설치(soksak 제어법)
  sok skill print                     라이브 SKILL.md 를 stdout 으로(프롬프트 재료)
  sok mcp install [--claude|--codex|--gemini|--all]
                                      MCP 서버 등록(네이티브 mcp add, SOKSAK_SOCKET 핀)

컨텍스트:
  soksak 터미널 안에서는 $SOKSAK_PANE 이 자동 주입되어, 대상 id 를 생략하면
  호출한 pane 의 위치(패널/컨텐츠/프로젝트)가 기본 대상이 된다.
  멀티 윈도우: sok --window <label> <command> 또는 $SOKSAK_WINDOW 로 특정 창을 지정
  (생략 시 활성 창). 창 목록은 sok window.list, 새 창은 sok window.open.
  상관: $SOKSAK_PARENT 가 있으면 요청에 parent 로 실려 활동 엔트리가 그 턴으로 묶인다.

환경(한 sok 은 한 환경에만 묶인다 — 침묵 cross-env 금지):
  바이너리 identity가 환경을 고정한다(sok-dev→dev, sok-debug→debug, sok→release).
  $SOKSAK_SOCKET은 위치 힌트일 뿐이며 system.hello identity가 다르면 거부한다.
  그 환경 미실행이면 에러(다른 환경 대체 안 함)."
    );
}

// ── 소켓 ────────────────────────────────────────────────────────────────────

// 환경 묶임(배신 차단, docs/AI-CONTROL.md P9). 앱 정체성 3개(com.soksak.{dev|debug|app})로
// 소켓이 분리된다. sok 은 정확히 한 환경에 묶이고, 의도치 않은 다른 환경에 침묵으로 붙지 않는다.
// SOKSAK_SOCKET은 앱이 PTY에 주입하는 위치 힌트일 뿐이다. 연결 직후 system.hello의
// identity가 컴파일된 바이너리 identity와 일치해야 한다. env가 정해지면 그 소켓만 —
// 없으면 에러(다른 env 대체 금지).
// "살아있는-1개-잡기" 는 폐기(어느 env 든 말없이 잡던 배신 지점).

/// 바이너리에 컴파일된 환경 — 이름이 곧 정체성이다. 사람이 바꾸는 채널(--env/SOKSAK_ENV)은 없다.
/// SOKSAK_SOCKET은 위치 힌트일 뿐이며 연결된 peer의 system.hello identity가 최종 권위다.
static DEFAULT_ENV: OnceLock<&'static str> = OnceLock::new();
fn default_env() -> &'static str {
    DEFAULT_ENV.get().copied().unwrap_or("app")
}
// --window 전역 플래그(있으면). main 이 1회 설정 — send_request 의 창 해소에서 env 보다 우선.
static WINDOW_OVERRIDE: OnceLock<Option<String>> = OnceLock::new();

// env 토큰 검증(dev|debug|app 만). 그 외는 에러.
fn validate_env(env: &str) -> Result<&str, String> {
    match env {
        "dev" | "debug" | "app" => Ok(env),
        other => Err(format!("알 수 없는 환경: '{other}' (dev|debug|app)")),
    }
}

// env 토큰 → 소켓 파일명.
fn socket_name_for_env(env: &str) -> String {
    format!("com.soksak.{env}.sock")
}

fn identity_for_env(env: &str) -> Result<String, String> {
    Ok(format!("com.soksak.{}", validate_env(env)?))
}

fn validate_peer_identity(reply: &Value, expected: &str) -> Result<(), String> {
    let actual = reply
        .get("identity")
        .and_then(Value::as_str)
        .unwrap_or("<missing>");
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "ENVIRONMENT_MISMATCH: 이 CLI는 {expected} 전용이지만 소켓 앱은 {actual}입니다"
        ))
    }
}

// env 토큰 → 소켓 절대경로(존재·생존 검사 없음 — 핀 용도). validate_env 통과 전제.
// identity 홈 계약(코어 home.rs 와 동일, docs/ARCHITECTURE.md): app=~/.soksak, 그 외
// env=~/.soksak-<env>. 데이터·플러그인·소켓이 identity 별로 완전 분리되므로 소켓도 그 홈에 산다.
// runtime home override는 없다. 테스트도 순수 경로 함수와 fixture 입력으로 격리한다.
fn home_for_env(env: &str) -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME 없음".to_string())?;
    let suffix = if env == "app" {
        String::new()
    } else {
        format!("-{env}")
    };
    Ok(PathBuf::from(home).join(format!(".soksak{suffix}")))
}

fn socket_path_for_env(env: &str) -> Result<PathBuf, String> {
    let env = validate_env(env)?;
    Ok(home_for_env(env)?.join(socket_name_for_env(env)))
}

// 소켓 타겟 결정(순수). 명시 소켓 경로 또는 env 토큰.
enum SockTarget {
    Explicit(String),
    Env(String),
}

fn resolve_target(soksak_socket: Option<String>) -> SockTarget {
    if let Some(p) = soksak_socket.filter(|s| !s.is_empty()) {
        return SockTarget::Explicit(p);
    }
    SockTarget::Env(default_env().to_string())
}

// 묶인 환경의 소켓 경로. env 가 정해졌으면 그 소켓만 — 살아있지 않으면 에러(다른 env 로 대체 안 함).
fn resolve_socket() -> Result<PathBuf, String> {
    let target = resolve_target(std::env::var("SOKSAK_SOCKET").ok());
    match target {
        SockTarget::Explicit(p) => Ok(PathBuf::from(p)),
        SockTarget::Env(env) => {
            let path = socket_path_for_env(&env)?;
            if UnixStream::connect(&path).is_ok() {
                Ok(path)
            } else {
                Err(format!(
                    "soksak({env}) 미실행 — 소켓 없음: {}\n다른 환경은 그 이름의 바이너리(sok / sok-dev / sok-debug)로 호출하십시오.",
                    path.display()
                ))
            }
        }
    }
}

// args 에서 전역 `--flag VALUE` 를 뽑아 제거. 없으면 None. 값 없는 `--flag` 는 제거하고 None.
fn take_flag_value(args: &mut Vec<String>, flag: &str) -> Option<String> {
    if let Some(i) = args.iter().position(|a| a == flag) {
        if i + 1 < args.len() {
            let val = args.remove(i + 1);
            args.remove(i);
            return Some(val);
        }
        args.remove(i);
    }
    None
}

fn request(method: &str, mut params: Value) -> Result<Value, String> {
    // pane/window 는 env(SOKSAK_PANE/WINDOW)에서 — 터미널 안 "내 위치" 기본 타겟.
    // params 안의 timeoutMs 는 응답 대기 상한(envelope)으로 hoist — 커맨드 자체 params 검증에선 빠진다.
    // record/캡처처럼 기본 10s 를 넘는 장시간 커맨드가 이걸로 상한을 키운다(코어가 [1s,600s] 클램프). 숫자 아니면 무시.
    let timeout_ms = params
        .as_object_mut()
        .and_then(|o| o.remove("timeoutMs"))
        .and_then(|v| v.as_u64());
    send_request(method, params, None, None, timeout_ms)
}

// 활동 스트림 팔로우(A2) — events.subscribe 로 연결을 push 모드로 전환하고 라인을 그대로
// 흘린다(JSONL). 종료는 Ctrl-C(연결 끊김 → 코어가 구독 해지).
fn run_events(args: &[String]) -> ExitCode {
    let mut args = args.to_vec();
    let kinds = take_flag_value(&mut args, "--kinds")
        .map(|v| v.split(',').map(str::to_string).collect::<Vec<_>>())
        .unwrap_or_default();
    let since = take_flag_value(&mut args, "--since").and_then(|v| v.parse::<u64>().ok());
    let mut params = json!({});
    if !kinds.is_empty() {
        params["kinds"] = json!(kinds);
    }
    if let Some(s) = since {
        params["since"] = json!(s);
    }
    let sock = match resolve_socket() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    let mut stream = match UnixStream::connect(&sock) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("소켓 연결 실패({}): {e}", sock.display());
            return ExitCode::FAILURE;
        }
    };
    let expected = match identity_for_env(default_env()) {
        Ok(identity) => identity,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    if let Err(e) = verify_stream_identity(&mut stream, &expected) {
        eprintln!("{e}");
        return ExitCode::FAILURE;
    }
    let mut w = stream.try_clone().expect("소켓 클론 실패");
    // 구독(장수 연결)도 같은 봉투 빌더를 지난다 — 봉투 계약의 단일 지점 유지.
    let req = build_request("events.subscribe", params, None, None, None, None);
    if writeln!(w, "{req}").is_err() {
        eprintln!("구독 요청 전송 실패");
        return ExitCode::FAILURE;
    }
    let reader = std::io::BufReader::new(stream);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        println!("{line}");
    }
    ExitCode::SUCCESS
}

// 요청 봉투 빌더(순수) — 모든 소켓 요청(단발 왕복·events 구독·MCP 위임)이 여기서 태어난다.
// 봉투 계약의 단일 지점: protocol 판 선언(soksak-spec-socket, 앱 VERSION_SKEW 게이트의 재료)을
// 빠짐없이 싣고, 선택 필드(pane/window/parent/timeoutMs)는 값이 있을 때만 실린다.
fn build_request(
    method: &str,
    params: Value,
    pane: Option<String>,
    window: Option<String>,
    parent: Option<String>,
    timeout_ms: Option<u64>,
) -> Value {
    let mut req = json!({
        "id": 1,
        "method": method,
        "params": params,
        "protocol": soksak_spec_socket::SOCKET_PROTOCOL_VERSION,
    });
    if let Some(p) = pane {
        req["pane"] = json!(p);
    }
    if let Some(w) = window {
        req["window"] = json!(w);
    }
    if let Some(p) = parent {
        req["parent"] = json!(p);
    }
    if let Some(t) = timeout_ms {
        req["timeoutMs"] = json!(t);
    }
    req
}

// hello 응답 판정(순수) — 클라이언트 쪽 시선: sok 자신이 own, 앱이 peer.
// 협상 이전 앱은 hello 를 프론트로 흘려 ok:false 로 답한다 — 부재=0 규칙의 대칭으로 판 0
// 취급(floor 0 인 동안 호환). 스큐면 방향 명시 한 문장(낡은 쪽+두 판 숫자+해결 명령)이 Err.
// sok 은 앱과 무관한 단독 실행 도구다 — 판정 문장의 언어는 이 셸의 로케일(LC_ALL 우선, 없으면
// LANG)로 정한다. 소켓 연결 이전에도 정해지고(부재=영어), 앱 언어 설정과 독립이다(사람이 sok 을
// 치는 터미널의 로케일이 그가 읽을 언어다). 메시지 생성 시점 1회 조회 — 폴링 없음.
fn env_lang() -> soksak_spec_socket::Lang {
    let tag = std::env::var("LC_ALL")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("LANG").ok())
        .unwrap_or_default();
    soksak_spec_socket::Lang::from_tag(&tag)
}

// 호환 요약(순수) — 판정이 호환일 때 stderr 로 나가는 사람 표면. 판 숫자는 언어 독립,
// 문장은 해소한다. 협상 이전 앱(hello 를 프론트로 흘림)은 판 0 으로 판별되므로 그 사실을 덧붙인다.
fn hello_summary(lang: soksak_spec_socket::Lang, own: u32, peer: u32, answered: bool) -> String {
    use soksak_spec_socket::Lang;
    match lang {
        Lang::En => format!(
            "compatible — sok protocol {own}, app protocol {peer}{}",
            if answered { "" } else { " (pre-hello app)" }
        ),
        Lang::Ko => format!(
            "호환됨 — sok 프로토콜 {own}, 앱 프로토콜 {peer}{}",
            if answered { "" } else { " (hello 이전 앱)" }
        ),
    }
}

fn judge_hello_reply(reply: &Value, lang: soksak_spec_socket::Lang) -> Result<String, String> {
    use soksak_spec_socket::{
        effective_protocol, evaluate_compat, skew_sentence, Compat, Lang,
        MIN_COMPATIBLE_SERVER_PROTOCOL, SOCKET_PROTOCOL_VERSION,
    };
    let answered = reply.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let peer = if answered {
        effective_protocol(
            reply
                .get("protocol")
                .and_then(Value::as_u64)
                .map(|v| v as u32),
        )
    } else {
        0
    };
    let verdict = evaluate_compat(
        SOCKET_PROTOCOL_VERSION,
        MIN_COMPATIBLE_SERVER_PROTOCOL,
        peer,
    );
    // 스큐 문장의 명사와 해결 지시는 사람 표면 — 이 셸의 언어로 해소해 넘긴다(문장 골격은 크레이트가
    // 해소). 이 시선은 sok 이 앱을 판정하므로 self=sok, peer=앱이다.
    let (self_name, peer_name) = match lang {
        Lang::En => ("this sok", "the app"),
        Lang::Ko => ("이 sok", "앱"),
    };
    let remedy = match (verdict, lang) {
        (Compat::Compatible, _) => None,
        (Compat::PeerTooOld { .. }, Lang::En) => Some("update the app"),
        (Compat::PeerTooOld { .. }, Lang::Ko) => Some("앱을 업데이트하세요"),
        (Compat::SelfTooOld { .. }, Lang::En) => Some("run the sok bundled with this app"),
        (Compat::SelfTooOld { .. }, Lang::Ko) => Some("이 앱에 동봉된 sok 을 실행하세요"),
    };
    match skew_sentence(verdict, self_name, peer_name, remedy, lang) {
        Some(sentence) => Err(sentence),
        None => Ok(hello_summary(lang, SOCKET_PROTOCOL_VERSION, peer, answered)),
    }
}

// `sok hello` — transport 협상 프리미티브. 앱이 프론트 미경유로 즉답하므로 webview 가 행이어도
// 응답한다: "앱이 살아있나 + 판이 맞나" 진단의 첫 명령. stdout 은 순수 JSON(기계 소비 보존),
// 판정 문장은 stderr. 스큐면 실패 종료 — 스크립트가 종료코드로 자가 판정한다.
fn run_hello() -> ExitCode {
    match request("system.hello", Value::Null) {
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
        Ok(reply) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&reply).unwrap_or_default()
            );
            match judge_hello_reply(&reply, env_lang()) {
                Ok(summary) => {
                    eprintln!("{summary}");
                    ExitCode::SUCCESS
                }
                Err(sentence) => {
                    eprintln!("{sentence}");
                    ExitCode::FAILURE
                }
            }
        }
    }
}

// 소켓 JSON-RPC 1회 왕복. pane/window/timeout 명시값이 있으면 우선, 없으면 env(SOKSAK_PANE/WINDOW) 사용.
// MCP soksak.run 은 명시값을 넘긴다(서브프로세스라 PTY env 없음).
fn send_request(
    method: &str,
    params: Value,
    pane: Option<String>,
    window: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    let sock = resolve_socket()?;
    let req = build_request(
        method,
        params,
        pane.or_else(|| std::env::var("SOKSAK_PANE").ok()),
        // 멀티 윈도우 타겟 창: 명시 > --window > SOKSAK_WINDOW. 생략 시 코어가 활성 창으로 라우팅.
        window
            .or_else(|| WINDOW_OVERRIDE.get().cloned().flatten())
            .or_else(|| std::env::var("SOKSAK_WINDOW").ok()),
        // 상관 부모(SOKSAK_PARENT — 오케스트레이터가 스폰한 에이전트에 주입). 이 실행에서 비롯된
        // 활동 엔트리가 그 대화 턴(parentId)으로 묶인다. pane/window 와 같은 env 컨텍스트 모델.
        std::env::var("SOKSAK_PARENT")
            .ok()
            .filter(|s| !s.is_empty()),
        timeout_ms,
    );
    let expected = identity_for_env(default_env())?;
    authenticated_round_trip(&sock, &expected, method, &req)
}

// identity 확인과 본 명령은 반드시 같은 연결에서 수행한다. 확인 뒤 새 연결을 열면 그 사이
// 소켓 경로가 다른 서버로 교체되는 TOCTOU가 생겨 compile-time environment 고정이 무너진다.
fn authenticated_round_trip(
    sock: &Path,
    expected_identity: &str,
    method: &str,
    req: &Value,
) -> Result<Value, String> {
    let mut stream = UnixStream::connect(sock)
        .map_err(|e| format!("소켓 연결 실패({}): {e}", sock.display()))?;
    authenticated_exchange(expected_identity, method, req, |message| {
        round_trip_stream(&mut stream, message)
    })
}

// 단일 exchange closure가 한 연결의 수명을 소유한다. hello와 본 요청이 이 closure 밖으로
// 빠져나갈 수 없으므로 identity 검증 뒤 다른 peer에 명령을 보내는 경로가 구조적으로 없다.
fn authenticated_exchange<F>(
    expected_identity: &str,
    method: &str,
    req: &Value,
    mut exchange: F,
) -> Result<Value, String>
where
    F: FnMut(&Value) -> Result<Value, String>,
{
    if method != "system.hello" {
        let hello = build_request("system.hello", Value::Null, None, None, None, None);
        let reply = exchange(&hello)?;
        validate_peer_identity(&reply, expected_identity)?;
    }
    let reply = exchange(req)?;
    if method == "system.hello" {
        validate_peer_identity(&reply, expected_identity)?;
    }
    Ok(reply)
}

fn round_trip_stream(stream: &mut UnixStream, req: &Value) -> Result<Value, String> {
    writeln!(stream, "{req}").map_err(|e| format!("요청 전송 실패: {e}"))?;
    let mut line = String::new();
    let read_half = stream
        .try_clone()
        .map_err(|e| format!("소켓 읽기 핸들 복제 실패: {e}"))?;
    BufReader::new(read_half)
        .read_line(&mut line)
        .map_err(|e| format!("응답 수신 실패: {e}"))?;
    serde_json::from_str(&line).map_err(|e| format!("응답 파싱 실패: {e}"))
}

fn verify_stream_identity(stream: &mut UnixStream, expected: &str) -> Result<(), String> {
    let req = build_request("system.hello", Value::Null, None, None, None, None);
    let reply = round_trip_stream(stream, &req)?;
    validate_peer_identity(&reply, &expected)
}

// 응답 봉투의 hint([{cmd,why}])를 사람용 줄로 stdout 에 덧붙인다. TTY 에서만 호출된다(파이프/
// 리다이렉트는 순수 JSON 유지 — 기계 소비 보존). hint 필드는 다른 작업이 채운다 — 없으면 조용히 생략.
fn run_request(method: &str, params: Value, pretty_only: bool) -> ExitCode {
    match request(method, params) {
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
        Ok(v) => {
            let ok = v.get("ok").and_then(Value::as_bool).unwrap_or(false);
            println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
            if ok || pretty_only {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
    }
}

// ── 매뉴얼(카탈로그 → 포맷) ──────────────────────────────────────────────────

/// 창 미지정 시 워크스페이스 창(w-*)을 자동 선택한다 — 플러그인 명령 스키마는 창-로컬
/// 등록이라, 어느 창(오케스트레이터 포함)에서 불러도 같은 전체 카탈로그가 나오게 한다.
fn pick_catalog_window() -> Option<String> {
    WINDOW_OVERRIDE.get().cloned().flatten().or_else(|| {
        request("window.list", Value::Null).ok().and_then(|v| {
            v.get("data")
                .and_then(|d| d.get("labels"))
                .and_then(Value::as_array)
                .and_then(|ls| {
                    ls.iter()
                        .filter_map(Value::as_str)
                        .find(|l| l.starts_with("w-"))
                        .map(String::from)
                })
        })
    })
}

fn fetch_commands() -> Result<Vec<Value>, String> {
    let v = send_request(
        "state.commands",
        Value::Null,
        None,
        pick_catalog_window(),
        None,
    )?;
    // 응답 봉투(MESSAGE-PROTOCOL) — 기계 페이로드는 data 에 중첩된다.
    v.get("data")
        .and_then(|d| d.get("commands"))
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "카탈로그 응답 형식 오류".into())
}

fn format_command_md(c: &Value) -> String {
    let name = c["name"].as_str().unwrap_or("?");
    // danger(destructive/inject)는 헤딩 줄에 함께 표기 — 위험 명령을 한눈에 가려낼 수 있게.
    let dg = c["danger"]
        .as_str()
        .map(|d| format!(" (danger: {d})"))
        .unwrap_or_default();
    let mut out = format!(
        "## `{name}`{dg}\n\n{}\n\n",
        c["description"].as_str().unwrap_or("")
    );
    let params = c["params"].as_object();
    if params.is_some_and(|p| !p.is_empty()) {
        out.push_str("| Parameter | Type | Required | Description |\n|---|---|---|---|\n");
        for (k, p) in params.unwrap() {
            let ty = p["type"].as_str().unwrap_or("?");
            let req = if p["required"].as_bool().unwrap_or(false) {
                "✓"
            } else {
                ""
            };
            let mut desc = p["description"].as_str().unwrap_or("").to_string();
            if let Some(e) = p["enum"].as_array() {
                let vals: Vec<_> = e.iter().filter_map(Value::as_str).collect();
                desc.push_str(&format!(" ({})", vals.join("|")));
            }
            if let Some(d) = p.get("default") {
                if !d.is_null() {
                    desc.push_str(&format!(" [default {d}]"));
                }
            }
            out.push_str(&format!("| `{k}` | {ty} | {req} | {desc} |\n"));
        }
        out.push('\n');
    }
    out.push_str(&format!(
        "**Returns**: {}\n",
        c["returns"].as_str().unwrap_or("{}")
    ));
    if let Some(errs) = c["errors"].as_array() {
        if !errs.is_empty() {
            let list: Vec<_> = errs.iter().filter_map(Value::as_str).collect();
            out.push_str(&format!("**Errors**: {}\n", list.join(", ")));
        }
    }
    if let Some(ex) = c["examples"].as_array() {
        if !ex.is_empty() {
            out.push_str("\n```bash\n");
            for e in ex.iter().filter_map(Value::as_str) {
                out.push_str(e);
                out.push('\n');
            }
            out.push_str("```\n");
        }
    }
    out
}

fn run_help(cmd: &str) -> ExitCode {
    match fetch_commands() {
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
        Ok(cmds) => match cmds.iter().find(|c| c["name"] == cmd) {
            Some(c) => {
                println!("{}", format_command_md(c));
                // 같은 도메인의 형제 명령 — help 는 명시적 탐색의 자리이므로 여기서만 넓힌다
                // (응답 hint 는 문맥 신호 전용 — 불변 상식의 반복 부착은 소음).
                // 플러그인 명령(plugin.<id>.…)은 그 플러그인 전체가 탐색 단위, 코어는 도메인.
                let domain: String = if cmd.starts_with("plugin.") {
                    cmd.splitn(3, '.').take(2).collect::<Vec<_>>().join(".")
                } else {
                    cmd.rsplit_once('.')
                        .map(|(d, _)| d)
                        .unwrap_or(cmd)
                        .to_string()
                };
                let prefix = format!("{domain}.");
                let siblings: Vec<&str> = cmds
                    .iter()
                    .filter_map(|c| c["name"].as_str())
                    .filter(|n| *n != cmd && n.starts_with(&prefix))
                    .collect();
                if !siblings.is_empty() {
                    println!("같은 묶음의 명령: {}", siblings.join(", "));
                }
                ExitCode::SUCCESS
            }
            None => {
                eprintln!("알 수 없는 명령: {cmd} (sok commands 로 목록 확인)");
                ExitCode::FAILURE
            }
        },
    }
}

fn run_docs(core_only: bool, format: &str, lang: &str) -> ExitCode {
    // 원천 = 코어 자동화 명령 command.docs(전체 표면 단일 반환) — CLI 는 마크다운 표현만 담당.
    // 플러그인 명령 스키마는 창-로컬 등록이라, 창 미지정이면 워크스페이스 창(w-*)을 자동 선택해
    // 어느 창(오케스트레이터 포함)에서 불러도 같은 전체 레퍼런스가 나온다.
    let v = match send_request(
        "command.docs",
        json!({ "lang": lang }),
        None,
        pick_catalog_window(),
        None,
    ) {
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
        Ok(v) => v,
    };
    if format == "json" {
        // 기계용 — 자동화 원천(command.docs)의 응답 그대로(md 와 동일 내용, 형식만 다름).
        println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
        return ExitCode::SUCCESS;
    }
    if format != "md" {
        eprintln!("사용: sok docs [--core] [--format md|json] [--lang en|ko]");
        return ExitCode::FAILURE;
    }
    let data = v.get("data").cloned().unwrap_or(Value::Null);
    let core = data
        .get("core")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    println!("# soksak 명령 레퍼런스\n");
    println!(
        "> 자동 생성 문서 — 원천은 `command.docs`(앱 Command Registry + 레지스트리 카탈로그).\n"
    );
    println!("모든 명령: `sok <command> [값 | '{{JSON}}']` — 값 하나는 유일한 필수 매개변수로 전달(기본형). 대상 id 생략 시 호출 컨텍스트($SOKSAK_PANE) 기본.\n");
    if core_only {
        println!(
            "코어 명령만 수록한다(--core — 리포지토리 문서용, 설치본 무관). 전체는 `sok docs`.\n"
        );
    } else {
        println!("가능한 명령 전체(코어 + 모든 플러그인)를 하나의 목록으로 수록한다.\n");
    }
    for c in &core {
        println!("{}", format_command_md(c));
    }
    if core_only {
        return ExitCode::SUCCESS;
    }
    // 플러그인 명령 — 가능한 전체를 하나의 흐름으로. 런타임 등록 스키마가 있으면 전문을,
    // 아니면 카탈로그 선언(제목·위험 분류)과 호출형을 수록한다. 출처 구분은 두지 않는다.
    let mut runtime: std::collections::BTreeMap<String, &Value> = std::collections::BTreeMap::new();
    if let Some(plugins) = data.get("plugins").and_then(Value::as_object) {
        for list in plugins.values() {
            for c in list.as_array().map(|a| a.iter()).into_iter().flatten() {
                if let Some(n) = c.get("name").and_then(Value::as_str) {
                    runtime.insert(n.to_string(), c);
                }
            }
        }
    }
    let entries = data
        .get("registry")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut printed: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for e in &entries {
        let id = e["id"].as_str().unwrap_or("?");
        for c in e["commands"]
            .as_array()
            .map(|a| a.iter())
            .into_iter()
            .flatten()
        {
            let n = c["name"].as_str().unwrap_or("?");
            let full = format!("plugin.{id}.{n}");
            printed.insert(full.clone());
            if let Some(spec) = runtime.get(&full) {
                println!("{}", format_command_md(spec));
            } else {
                // title 은 command.docs 가 요청 lang 으로 이미 평문 해소해 돌려준다(언어 맵 선택 불필요).
                let t = c["title"].as_str().unwrap_or("");
                let dg = c["danger"]
                    .as_str()
                    .map(|d| format!(" (danger: {d})"))
                    .unwrap_or_default();
                println!("## `{full}`\n\n{t}{dg}\n");
                println!("```bash\nsok {full} ['{{JSON}}']\n```\n");
            }
        }
    }
    // 카탈로그 밖 런타임 명령(dev 전용 플러그인 등)도 가능한 명령이다 — 빠짐없이.
    for (name, spec) in &runtime {
        if !printed.contains(name) {
            println!("{}", format_command_md(spec));
        }
    }
    ExitCode::SUCCESS
}

// ── MCP stdio 서버 (Model Context Protocol 2024-11-05) ──────────────────────
// `sok mcp` — stdin/stdout JSON-RPC 로 MCP 클라이언트(claude 등)에 soksak 전 기능을
// tool 로 노출한다. tool 목록은 앱 registry(state.commands)에서 동적 생성(단일 진실).
// MCP tool 이름은 [a-zA-Z0-9_-] 만 허용 → 명령 이름의 "." 을 "_" 로 양방향 치환.
// 직접 구현 사유: 카탈로그가 런타임 동적이라 정적 매크로 SDK 보다 소형 핸들러가
// 정확하고, 추가 의존성이 없다(프로토콜은 newline-delimited JSON-RPC 2.0).

// 발견형 메타툴 3개(P3). 전 명령(~347)을 eager tool 로 평탄 노출하지 않는다 — 명령 수가 늘어도
// tool 수 불변. MCP tool 이름은 [a-zA-Z0-9_-] 만 → 점 대신 밑줄(soksak_commands). 발견 경로를
// description 에 박는다(트리거 = description, P5). 핸들러 로직 0 — 전부 substrate 위임(P7).
fn meta_tools() -> Vec<Value> {
    vec![
        json!({
            "name": "soksak_commands",
            "description": "Discover soksak commands — the domain map + catalog (name + composed description). Reach for this whenever the user acts on anything inside the soksak app: split/arrange/close panels & tabs, open/run/read terminals, open or automate the embedded browser (navigate, click, fill, eval), draw or annotate on the screen, design a DB schema/ERD, manage windows, files, bookmarks, clipboard. If the user says they marked/drew/showed something \"on screen\" or \"in the browser\", it is almost certainly a soksak overlay/view — start here. Pass `domain` to filter (panel, browser, term, window, pin, erd…).",
            "inputSchema": {"type": "object", "properties": {
                "domain": {"type": "string", "description": "domain prefix filter (omit = all)"}
            }},
        }),
        json!({
            "name": "soksak_help",
            "description": "Get one soksak command's schema (params/returns/errors/examples). Call after soksak_commands, before running.",
            "inputSchema": {"type": "object", "required": ["name"], "properties": {
                "name": {"type": "string", "description": "command name, e.g. panel.split"}
            }},
        }),
        json!({
            "name": "soksak_run",
            "description": "Run any soksak command. `command` is a name discovered via soksak_commands/soksak_help; `params` is that command's parameters.",
            "inputSchema": {"type": "object", "required": ["command"], "properties": {
                "command": {"type": "string", "description": "command name, e.g. panel.split"},
                "params": {"type": "object", "description": "command parameters"},
                "window": {"type": "string", "description": "target window label (omit = active)"},
                "pane": {"type": "string", "description": "target pane id (omit = default)"},
                "timeoutMs": {"type": "number", "description": "response wait cap (ms)"}
            }},
        }),
    ]
}

// 메타툴 디스패치. 반환 (text, is_error). substrate(state.commands/socket)만 호출 — thin(P7).
fn mcp_call_meta(name: &str, args: &Value) -> Result<(String, bool), String> {
    match name {
        "soksak_commands" => {
            let cmds = fetch_commands()?;
            let domain = args["domain"].as_str();
            let brief: Vec<Value> = cmds
                .iter()
                .filter(|c| match domain {
                    Some(d) => c["name"]
                        .as_str()
                        .is_some_and(|n| n == d || n.starts_with(&format!("{d}."))),
                    None => true,
                })
                // 발견용 — 이름+설명만. 파라미터 전량은 soksak_help 가 온디맨드(P3·P5).
                .map(|c| json!({ "name": c["name"], "description": c["description"] }))
                .collect();
            let text = format!(
                "# 도메인 지도\n{}\n# 명령 {}{}\n{}",
                domain_map(&cmds),
                brief.len(),
                domain.map(|d| format!(" (domain={d})")).unwrap_or_default(),
                serde_json::to_string_pretty(&brief).unwrap_or_default(),
            );
            Ok((text, false))
        }
        "soksak_help" => {
            let cmd = args["name"].as_str().ok_or("name 필수")?;
            let cmds = fetch_commands()?;
            match cmds.iter().find(|c| c["name"] == cmd) {
                Some(c) => Ok((format_command_md(c), false)),
                None => Ok((
                    format!("알 수 없는 명령: {cmd} (soksak_commands 로 목록 확인)"),
                    true,
                )),
            }
        }
        "soksak_run" => {
            let command = args["command"].as_str().ok_or("command 필수")?;
            let params = args.get("params").cloned().unwrap_or(Value::Null);
            let window = args["window"].as_str().map(String::from);
            let pane = args["pane"].as_str().map(String::from);
            let timeout = args["timeoutMs"].as_u64();
            let v = send_request(command, params, pane, window, timeout)?;
            let ok = v.get("ok").and_then(Value::as_bool).unwrap_or(false);
            let text = serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string());
            Ok((text, !ok))
        }
        other => Err(format!("알 수 없는 도구: {other}")),
    }
}

fn mcp_reply(id: &Value, result: Value) {
    println!("{}", json!({"jsonrpc": "2.0", "id": id, "result": result}));
    use std::io::Write as _;
    let _ = std::io::stdout().flush();
}

fn mcp_error(id: &Value, code: i64, message: &str) {
    println!(
        "{}",
        json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
    );
    use std::io::Write as _;
    let _ = std::io::stdout().flush();
}

fn run_mcp() -> ExitCode {
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            continue; // 파싱 불가 라인은 무시(스펙: 응답 불가)
        };
        let id = msg.get("id").cloned();
        let method = msg["method"].as_str().unwrap_or("");
        match (method, id) {
            ("initialize", Some(id)) => {
                let ver = msg["params"]["protocolVersion"]
                    .as_str()
                    .unwrap_or("2024-11-05")
                    .to_string();
                mcp_reply(
                    &id,
                    json!({
                        "protocolVersion": ver,
                        "capabilities": {"tools": {}, "resources": {}},
                        "serverInfo": {"name": "soksak", "version": env!("CARGO_PKG_VERSION")},
                    }),
                );
            }
            ("ping", Some(id)) => mcp_reply(&id, json!({})),
            // 발견형 메타툴 3개 고정(P3). 명령 카탈로그는 soksak_commands 가 온디맨드.
            ("tools/list", Some(id)) => mcp_reply(&id, json!({ "tools": meta_tools() })),
            ("tools/call", Some(id)) => {
                let name = msg["params"]["name"].as_str().unwrap_or("");
                let args = &msg["params"]["arguments"];
                match mcp_call_meta(name, args) {
                    Err(e) => mcp_error(&id, -32000, &e),
                    Ok((text, is_error)) => mcp_reply(
                        &id,
                        json!({
                            "content": [{"type": "text", "text": text}],
                            "isError": is_error,
                        }),
                    ),
                }
            }
            // 라이브 SKILL.md 를 stdio 로 서빙(P8 — 파일/심링크/FUSE 0).
            ("resources/list", Some(id)) => mcp_reply(
                &id,
                json!({ "resources": [{
                    "uri": "soksak://skill",
                    "name": "soksak-control",
                    "description": "soksak 제어 스킬(라이브 도메인 지도, sok commands 파생)",
                    "mimeType": "text/markdown",
                }]}),
            ),
            ("resources/read", Some(id)) => {
                let uri = msg["params"]["uri"].as_str().unwrap_or("");
                if uri == "soksak://skill" {
                    mcp_reply(
                        &id,
                        json!({ "contents": [{
                            "uri": uri,
                            "mimeType": "text/markdown",
                            "text": skill_doc(&pin_env().unwrap_or_else(|_| "app".into()), Some(SKILL_AUTHORED_BODY)),
                        }]}),
                    );
                } else {
                    mcp_error(&id, -32002, &format!("알 수 없는 리소스: {uri}"));
                }
            }
            (_, None) => {} // notification(initialized 등) — 무응답
            (_, Some(id)) => mcp_error(&id, -32601, &format!("지원하지 않는 메서드: {method}")),
        }
    }
    ExitCode::SUCCESS
}

// ── MCP 클라이언트 등록(sok mcp install) ─────────────────────────────────────
// `sok mcp` 서버를 외부 에이전트(claude/codex/gemini)의 MCP 클라이언트 config 에 배선한다.
// 네이티브 CLI(`<tool> mcp add`)를 셸아웃 — 각 도구가 자기 config 포맷·병합·멱등을 소유(P7·P10).
// 우리가 TOML/JSON 직접 병합하면 사용자 config 손상 위험. env SOKSAK_SOCKET 핀 = 환경 묶임(P9) 일관.

// 설치 핀 환경 = 이 바이너리의 컴파일 환경. 환경은 정체성이라 다른 채널이 없다(P9).
fn pin_env() -> Result<String, String> {
    validate_env(default_env()).map(String::from)
}

// env 토큰 → MCP 서버 이름(클라이언트에서 세 환경 공존). app→soksak, dev→soksak-dev, debug→soksak-debug.
fn server_name_for_env(env: &str) -> String {
    match env {
        "app" => "soksak".to_string(),
        other => format!("soksak-{other}"),
    }
}

// `<tool> mcp add` argv 빌더(순수). 조사 확정 문법(2026 공식문서). server=서버명, sock=핀 소켓, sok=sok 절대경로.
fn mcp_add_argv(
    tool: &str,
    server: &str,
    sock: &str,
    sok: &str,
) -> Result<(String, Vec<String>), String> {
    let envpair = format!("SOKSAK_SOCKET={sock}");
    let v = |xs: &[&str]| xs.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    match tool {
        // claude mcp add --scope user --env K=V <name> -- <sok> mcp
        "claude" => Ok((
            "claude".into(),
            v(&[
                "mcp", "add", "--scope", "user", "--env", &envpair, server, "--", sok, "mcp",
            ]),
        )),
        // codex mcp add <name> --env K=V -- <sok> mcp
        "codex" => Ok((
            "codex".into(),
            v(&["mcp", "add", server, "--env", &envpair, "--", sok, "mcp"]),
        )),
        // gemini mcp add <name> -e K=V -s user <sok> mcp  (flags before command, per docs)
        "gemini" => Ok((
            "gemini".into(),
            v(&[
                "mcp", "add", server, "-e", &envpair, "-s", "user", sok, "mcp",
            ]),
        )),
        other => Err(format!("알 수 없는 도구: {other}")),
    }
}

fn run_mcp_install(args: &[String]) -> ExitCode {
    let (mut claude, mut codex, mut gemini) = (false, false, false);
    for a in args {
        match a.as_str() {
            "--claude" => claude = true,
            "--codex" => codex = true,
            "--gemini" => gemini = true,
            "--all" => {
                claude = true;
                codex = true;
                gemini = true;
            }
            other => {
                eprintln!("알 수 없는 옵션: {other}");
                eprintln!("사용: sok mcp install [--claude|--codex|--gemini|--all]");
                return ExitCode::FAILURE;
            }
        }
    }
    if !claude && !codex && !gemini {
        claude = true;
        codex = true;
        gemini = true; // 기본 --all
    }

    let env = match pin_env() {
        Ok(e) => e,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    let server = server_name_for_env(&env);
    let sock = match socket_path_for_env(&env) {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    // sok 절대경로(현재 실행 파일). env SOKSAK_SOCKET 핀이 환경을 결정하므로 어느 sok 든 무방.
    let sok = std::env::current_exe()
        .ok()
        .and_then(|p| p.to_str().map(String::from))
        .unwrap_or_else(|| "sok".to_string());

    let mut failed = false;
    for (tool, on) in [("claude", claude), ("codex", codex), ("gemini", gemini)] {
        if !on {
            continue;
        }
        let (prog, argv) = match mcp_add_argv(tool, &server, &sock, &sok) {
            Ok(x) => x,
            Err(e) => {
                eprintln!("{tool}  ✗ {e}");
                failed = true;
                continue;
            }
        };
        match std::process::Command::new(&prog).args(&argv).status() {
            Ok(st) if st.success() => println!("{tool}  ✓ {server} → SOKSAK_SOCKET={sock}"),
            Ok(st) => {
                eprintln!("{tool}  ✗ {prog} 종료코드 {:?}", st.code());
                failed = true;
            }
            Err(e) => {
                eprintln!("{tool}  ✗ {prog} 실행 실패(미설치?): {e}");
                failed = true;
            }
        }
    }
    if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

// ── 트리거 스킬(라이브 도메인 지도) ──────────────────────────────────────────
// 스킬은 오리엔테이션이다(P5) — 멘탈 모델·주소 모델·검증 워크플로 + 도메인 지도(목차)만 담고,
// per-command 카탈로그(이름/params/returns)는 `sok commands`/`sok help`(목차의 본문)에 맡긴다.
// 도메인 지도는 손으로 나열(P1 위반)하지 않고 install/serve 시 라이브 카탈로그에서 파생한다.

// frontmatter description 이 트리거(자연어 자동발동, P5). Claude·Codex·Gemini 동일 포맷.
const SKILL_DESCRIPTION_DEFAULT: &str = "Control the soksak terminal app via the `sok` CLI — discover and run any soksak command. Reach for this whenever the user acts on anything inside soksak: split/merge/close panels & tabs, open terminals/browsers/editors, run and read terminal output, drive TUIs, automate the embedded browser (navigate/click/fill/eval), draw or annotate on the screen, manage windows/files/bookmarks/clipboard. If the user says they marked/drew/showed/annotated something \"on screen\" or \"in the browser\", it is almost certainly a soksak overlay or view — start here, not an external design tool. 화면/브라우저에 표시·낙서·주석·그림, 패널 나누기, 터미널 실행도 여기.";

// frontmatter 조립 — 저작 본문(소스 BODY.md)이 자기 frontmatter 를 가지면 그대로 채택하되
// name 은 환경 이름으로 강제한다(세 환경 공존 시 발동 충돌 방지). 없으면 기본 description.
fn skill_frontmatter(skill_name: &str, env: &str, directives_fm: Option<&str>) -> String {
    if let Some(fm) = directives_fm {
        let mut lines: Vec<String> = Vec::new();
        let mut named = false;
        for l in fm.lines() {
            if l.trim_start().starts_with("name:") {
                lines.push(format!("name: {skill_name}"));
                named = true;
            } else {
                lines.push(l.to_string());
            }
        }
        if !named {
            lines.insert(0, format!("name: {skill_name}"));
        }
        // 발동 구분은 생성기 책임(저작은 환경 중립) — 접힌 description 블록 끝에 환경 문장을 잇는다.
        if env != "app" {
            lines.push(format!(
                "  This is the {env} environment (home ~/.soksak-{env}) — use it when working against that environment's app."
            ));
        }
        return format!("---\n{}\n---\n", lines.join("\n"));
    }
    let env_tag = if env == "app" {
        String::new()
    } else {
        format!(" This is the {env} environment (home ~/.soksak-{env}) — use it when working on projects inside that environment's app.")
    };
    format!("---\nname: {skill_name}\ndescription: {SKILL_DESCRIPTION_DEFAULT}{env_tag}\n---\n")
}

// 이 환경의 호출 방법 — 생성 시점의 CLI 실경로를 핀한다(미설치 개발 환경에서도 즉시 동작).
// 재작성 때마다 갱신되므로 이사·리빌드에 썩지 않는다.
fn env_pin_block(env: &str) -> String {
    let alias = if env == "app" {
        "sok".to_string()
    } else {
        format!("sok-{env}")
    };
    let exe = std::env::current_exe()
        .ok()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "sok".into());
    let sock = socket_path_for_env(env)
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let pinned = exe; // 이름별 실물 바이너리 — 환경은 컴파일 고정이라 프리픽스가 없다.
    format!(
        "## This environment (pinned at generation)\n\n\
         - Environment: **{env}** — socket `{sock}`\n\
         - Invoke: `{alias}` if it is on PATH; otherwise the pinned CLI: `{pinned}`\n\
         - Every `sok …` example below means this binary. Do not substitute another environment's binary — each environment has its own app, socket, and plugin set.\n\n"
    )
}

const SKILL_BODY_HEAD: &str = r#"# Controlling soksak with `sok`

> AUTO-GENERATED by `sok skill install` — edits are overwritten. Source of truth is `sok commands`.

Orientation only. `sok commands` (catalog) and `sok help <cmd>` (one command's schema) are the
live single source of truth — this file is a map, not the full catalog.

soksak is a terminal app with a 3-level layout: projects (t*) -> spaces (c*, tabs of split
grids) -> panels (g*, split groups) holding views (v*: terminal / file editor / browser;
terminals contain panes p*). Every feature is a `sok` command.

Two window kinds: workspace windows (label `w-*`) host projects and load plugins/programs;
the control-plane window (label `main`, the orchestrator) loads none by design. If
`program.list` / `plugin.list` return empty with a control-plane note, you queried `main` —
target a workspace window (`--window w-…`) instead of installing anything. Opening a project
while on `main` routes to a new workspace window automatically (returns `routedWindow`).

## Address model (targeting)

- `sok state.tree` returns every id plus each panel's on-screen rect (%) — the address book.
- Inside a soksak terminal, `$SOKSAK_PANE` marks your pane. Omit target ids and commands
  default to your own location. `sok state.context` shows where you are.
- Pass explicit ids to act anywhere: `sok panel.split '{"panel":"g3","side":"right"}'`.

## Workflow — always verify

1. `sok commands` (or `sok commands '{"domain":"panel"}'`) to discover; `sok help <cmd>` for one schema.
2. `sok state.tree` to discover live targets.
3. Run the command. Mutations return resulting ids/state, e.g. panel.split ->
   `{"ok":true,"panelId":"g4","viewId":"v5","paneId":"p6"}`.
4. Verify from the response; cross-check with `sok state.tree` or `sok term.read`.
5. Errors are structured: `{"ok":false,"code":"TARGET_NOT_FOUND|LAST_ITEM|INVALID_PARAMS|TIMEOUT","message":...}`.

## Domain map (table of contents — full schemas via `sok commands` / `sok help <cmd>`)

"#;

const SKILL_BODY_TAIL: &str = r#"
## Recipes

- Split right and run claude: `sok panel.split '{"side":"right","program":"claude"}'`
- Run a command and read output: `sok term.exec '{"cmd":"git status"}'` then `sok term.read '{"lines":40}'`
- Drive a TUI: `sok term.send` with JSON text like `[B` (arrow down), `\r` (enter), `` (ctrl-c)
- Browser automation: `sok browser.open` -> `sok browser.dom.fill` -> `sok browser.dom.click` -> `sok browser.dom.waitFor` -> `sok browser.dom.text`

## Orchestration (multi-window, monitors, live feed)

- Windows are first-class: `sok window.open '{"root":"/abs/path"}'` opens a project in its own
  window (P6 single-open: an already-open root focuses its window and returns `existingWindow`).
  `sok window.open '{"mode":"orchestrator"}'` opens the observation window (idempotent).
- Placement: `sok window.monitors` (facts: monitor rects/scale + every window's frame) ->
  `sok layout.suggest '{"strategy":"spread","roles":{"orch-1":"orchestrator"}}'` (pure strategy)
  -> `sok window.place '{"label":...,"x":...,"y":...,"w":...,"h":...}'` (execute, physical px).
- Watch everything that runs: `sok activity.recent '{"limit":50}'` (cursor with `since`), or
  follow live: `sok events --kinds command,terminal --since 0` (JSONL push stream; every `sok`
  call you make is itself recorded as `command.executed`).
- WINDOW TARGETING TRAP: commands route to the focused window by default. After opening the
  orchestrator window it usually holds focus, so terminal/panel commands would land there and
  fail (TARGET_NOT_FOUND). Always pass `"window":"main"` (or the project window's label) in the
  request envelope — or set it per call: `sok state.tree` first, then target explicitly.

## Cautions

- close commands are destructive: panel.close removes every tab in the panel; the last project/space/view/pane is protected (LAST_ITEM error).
- term.send writes raw bytes to the PTY; term.exec appends Enter.
- browser.eval runs arbitrary JS in the page; `return` a JSON-serializable value.
"#;

// 앱 미가동(소켓 없음) 시 fallback 도메인 지도 — 코어 도메인만(플러그인은 라이브일 때만 발견).
const CORE_DOMAIN_MAP: &str = "\
- state: tree, context, commands
- project: list, open, activate, ...
- space: list, create, activate, ...
- panel: split, merge, move, resize, ...
- pane: split, focus, close, ...
- view: open, activate, move, ...
- window: open, list, focus, snapshot, ...
- term: read, send, exec, cwd
- browser: open, navigate, eval, ...
- browser.dom: query, text, click, fill, ...
- editor / explorer / git / bookmark / clipboard / data / secret / schedule / notify / net / theme / settings / ui
- plugin (+ plugin.<id>.*): dynamic — `sok commands` / `sok plugin.list` (app down — live list omitted)
";

// 카탈로그(catalogJson 배열) → 도메인 지도 markdown(순수). 도메인별 1줄(명령 수 + 대표 몇 개).
// 플러그인 명령(plugin.*)은 한 줄로 collapse(동적 — 발견 명령 안내). P5 — per-command 전량 아님.
fn domain_map(cmds: &[Value]) -> String {
    use std::collections::BTreeMap;
    let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for c in cmds {
        let Some(name) = c["name"].as_str() else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        let domain = if name.starts_with("plugin.") {
            "plugin".to_string()
        } else if name.starts_with("browser.dom.") {
            "browser.dom".to_string()
        } else {
            name.split('.').next().unwrap_or(name).to_string()
        };
        let short = name
            .strip_prefix(&format!("{domain}."))
            .unwrap_or(name)
            .to_string();
        groups.entry(domain).or_default().push(short);
    }
    let mut out = String::new();
    for (domain, mut names) in groups {
        names.sort();
        if domain == "plugin" {
            out.push_str(&format!(
                "- plugin ({}): dynamic — `sok commands` / `sok plugin.list`\n",
                names.len()
            ));
            continue;
        }
        let reps: Vec<&str> = names.iter().take(3).map(String::as_str).collect();
        let more = if names.len() > 3 { ", ..." } else { "" };
        out.push_str(&format!(
            "- {domain} ({}): {}{}\n",
            names.len(),
            reps.join(", "),
            more
        ));
    }
    out
}

// 저작 조각(SKILL.src.md) 분해 — 선두 frontmatter(있으면)와 본문을 나눈다.
fn split_directives(text: &str) -> (Option<String>, String) {
    let t = text.trim_start_matches('\u{feff}');
    if let Some(rest) = t.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---") {
            let fm = rest[..end].to_string();
            let body = rest[end + 4..].trim_start_matches('\n').to_string();
            return (Some(fm), body);
        }
    }
    (None, t.to_string())
}

// SKILL.md 전문 조립(순수) — frontmatter + 환경 핀 + 저작 지시어(있으면) + 오리엔테이션 + 지도.
// 소유권: 대상 폴더는 순수 산출물. 저작 정본(SKILL.src.md·references/)은 identity 홈 skill/ 에 살고
// 저작물은 건드리지 않는다 — 저작 조각은 합성의 입력이다.
fn skill_doc_with(map: &str, env: &str, directives: Option<&str>) -> String {
    let skill_name = server_name_for_env(env);
    let (fm, body) = match directives {
        Some(d) => {
            let (fm, body) = split_directives(d);
            (fm, body)
        }
        None => (None, String::new()),
    };
    let directives_block = if body.trim().is_empty() {
        String::new()
    } else {
        format!("## Working style (authored)\n\n{}\n\n", body.trim())
    };
    format!(
        "{}\n{}{}{}{}{}",
        skill_frontmatter(&skill_name, env, fm.as_deref()),
        env_pin_block(env),
        directives_block,
        SKILL_BODY_HEAD,
        map,
        SKILL_BODY_TAIL
    )
}

// 라이브 SKILL.md. 앱 가동이면 카탈로그에서 도메인 지도 파생, 미가동이면 코어 지도 fallback.
fn skill_doc(env: &str, directives: Option<&str>) -> String {
    let map = match fetch_commands() {
        Ok(cmds) => domain_map(&cmds),
        Err(_) => CORE_DOMAIN_MAP.to_string(),
    };
    skill_doc_with(&map, env, directives)
}

// 제어 스킬 한 벌 생성 — 정본(identity 홈 skill/SKILL.src.md)에서 읽은 저작 조각을 합성한다.
// 소유권은 SKILL.md 하나: 저작 조각·references/ 등 폴더의 다른 파일은 건드리지 않는다.
// 저작 본문·부속은 소스다 — 레포(src-tauri/cli/skill/)에 살고 바이너리에 담겨, install/refresh 가
// 산출한다. 레포 밖 파일은 개명 sweep 이 못 훑어 썩는다 — 소스면 코드와 같은 커밋으로 고쳐진다.
const SKILL_AUTHORED_BODY: &str = include_str!("../skill/BODY.md");
const SKILL_REF_COMMANDS: &str = include_str!("../skill/references/commands.md");

fn write_control_skill(path: &Path, env: &str) -> Result<(), String> {
    let doc = skill_doc(env, Some(SKILL_AUTHORED_BODY));
    write_skill(path, &doc)?;
    // 부속(references/) 산출 — 스킬 본문이 상대 경로로 참조한다.
    if let Some(target_dir) = path.parent() {
        let refs = target_dir.join("references");
        std::fs::create_dir_all(&refs).map_err(|e| e.to_string())?;
        std::fs::write(refs.join("commands.md"), SKILL_REF_COMMANDS).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// 재생성 매니페스트 — identity 홈(소켓 곁)에 {cli, env, targets[]} 를 남긴다. 앱이 레지스트리
// 변화를 감지하면 이 CLI 를 `skill refresh` 로 스폰해 스킬을 다시 쓴다(렌더 단일 진실 = CLI).
fn write_refresh_manifest(env: &str, targets: &[(&str, PathBuf)]) -> Result<(), String> {
    let sock = socket_path_for_env(env)?;
    let home = sock.parent().ok_or("홈 경로 해석 실패")?;
    let cli = std::env::current_exe().map_err(|e| e.to_string())?;
    let paths: Vec<String> = targets
        .iter()
        .filter_map(|(_, p)| p.canonicalize().ok().or_else(|| Some(p.clone())))
        .map(|p| p.display().to_string())
        .collect();
    let v = serde_json::json!({ "cli": cli.display().to_string(), "env": env, "targets": paths });
    std::fs::write(
        home.join("skill-refresh.json"),
        serde_json::to_string_pretty(&v).unwrap_or_default(),
    )
    .map_err(|e| e.to_string())
}

// `sok skill refresh` — 매니페스트대로 제어 스킬을 재생성한다(앱이 변화 시 스폰).
fn run_skill_refresh() -> ExitCode {
    let env = match pin_env() {
        Ok(e) => e,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    let Ok(sock) = socket_path_for_env(&env) else {
        eprintln!("소켓 경로 해석 실패");
        return ExitCode::FAILURE;
    };
    let manifest = sock.parent().map(|h| h.join("skill-refresh.json"));
    let Some(manifest) = manifest.filter(|p| p.exists()) else {
        eprintln!("매니페스트 없음 — 먼저 sok skill install 을 실행하십시오");
        return ExitCode::FAILURE;
    };
    let Ok(txt) = std::fs::read_to_string(&manifest) else {
        eprintln!("매니페스트 읽기 실패");
        return ExitCode::FAILURE;
    };
    let Ok(v) = serde_json::from_str::<Value>(&txt) else {
        eprintln!("매니페스트 형식 오류");
        return ExitCode::FAILURE;
    };
    let mut failed = false;
    let paths: Vec<PathBuf> = v["targets"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| t.as_str().map(PathBuf::from))
        .collect();
    for path in &paths {
        match write_control_skill(path, &env) {
            Ok(_) => println!("✓ {}", path.display()),
            Err(e) => {
                eprintln!("✗ {e}");
                failed = true;
            }
        }
    }
    if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

// 트리거 스킬 SKILL.md 를 도구별 경로에 쓴다(P10 — 우리 전용 디렉토리, 전체 재생성).
// claude=.claude/skills/, codex·gemini=.agents/skills/(2026 공식문서 확정, 공유 네임스페이스).
fn write_skill(path: &Path, doc: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, doc).map_err(|e| format!("{} 쓰기 실패: {e}", path.display()))
}

// 발견된 동봉 스킬 — 설치 디렉토리명·플러그인 id·저자 본문(오리엔테이션).
struct PluginSkill {
    dir_name: String,
    plugin_id: String,
    body: String,
}

// 동봉 플러그인 스킬 발견 — ~/.soksak/plugins/<id>/plugin.json 의 contributes.skill.path 가 가리키는
// SKILL.md(오리엔테이션 본문) 를 읽는다. 명령 목록은 본문에 없다 — install 이 레지스트리에서 합성한다
// (단일진실=registry, P1·docs/I18N.md §5). 코어는 플러그인 하드코딩 목록을 들지 않는다(매니페스트 선언만).
fn discover_plugin_skills() -> Vec<PluginSkill> {
    let mut out: Vec<PluginSkill> = Vec::new();
    // identity 홈 준수 — 환경(dev/debug/app)마다 플러그인 폴더가 다르다(.soksak 고정은 옛 결함).
    let env = pin_env().unwrap_or_else(|_| "app".into());
    let Some(base) = socket_path_for_env(&env)
        .ok()
        .and_then(|s| s.parent().map(|h| h.join("plugins")))
    else {
        return out;
    };
    let Ok(entries) = std::fs::read_dir(&base) else {
        return out;
    };
    for e in entries.flatten() {
        let pdir = e.path();
        if !pdir.is_dir() {
            continue;
        }
        let Ok(txt) = std::fs::read_to_string(pdir.join("plugin.json")) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&txt) else {
            continue;
        };
        let id = v["id"].as_str().unwrap_or("").trim().to_string();
        if id.is_empty() {
            continue;
        }
        let Some(rel) = v["contributes"]["skill"]["path"].as_str() else {
            continue;
        };
        // 디렉토리 탈출 방어(스펙도 막지만 CLI 도 독립 방어).
        if rel.starts_with('/') || rel.split('/').any(|s| s == "..") {
            continue;
        }
        let Ok(body) = std::fs::read_to_string(pdir.join(rel)) else {
            continue;
        };
        // 설치 디렉토리 = SKILL.md frontmatter name(Claude 관례: dir==name). 없으면 플러그인 id.
        let dir_name = skill_frontmatter_name(&body).unwrap_or_else(|| id.clone());
        out.push(PluginSkill {
            dir_name,
            plugin_id: id,
            body,
        });
    }
    out.sort_by(|a, b| a.dir_name.cmp(&b.dir_name));
    out
}

// 플러그인 명령 맵 합성 — 라이브 카탈로그에서 plugin.<id>.* 만 추려 `- sub — base` 목록(단일진실=registry).
// base = 합성 description 의 트리거어 앞부분(사람 가독). 카탈로그 미가용(앱 다운)이면 빈 문자열.
fn plugin_command_map(plugin_id: &str) -> String {
    let Ok(cmds) = fetch_commands() else {
        return String::new();
    };
    let prefix = format!("plugin.{plugin_id}.");
    let mut out = String::new();
    for c in &cmds {
        let Some(name) = c["name"].as_str() else {
            continue;
        };
        if let Some(sub) = name.strip_prefix(&prefix) {
            let desc = c["description"].as_str().unwrap_or("");
            let base = desc.split(" | ").next().unwrap_or(desc).trim();
            out.push_str(&format!("- `{sub}` — {base}\n"));
        }
    }
    out
}

// 플러그인 SKILL.md 합성 = 저자 오리엔테이션 본문 + install 시점 명령 맵(레지스트리에서). 본문에
// 명령을 손으로 나열하지 않는다(중복=단일진실 위반). 라이브 목록 포인터도 함께(맵은 스냅샷).
fn compose_plugin_skill(skill: &PluginSkill) -> String {
    let map = plugin_command_map(&skill.plugin_id);
    let body = skill.body.trim_end();
    let prefix = format!("plugin.{}.", skill.plugin_id);
    if map.is_empty() {
        format!(
            "{body}\n\n## Commands\n\n> Live surface (names/params evolve — never guess): `sok commands | grep {prefix}`. One command's schema: `sok help <name>`.\n"
        )
    } else {
        format!(
            "{body}\n\n## Commands (snapshot — live: `sok commands | grep {prefix}`, schema: `sok help <name>`)\n\n{map}"
        )
    }
}

// SKILL.md frontmatter 의 `name:` 추출(첫 --- 블록 안의 name 줄). 안전한 디렉토리명만 허용.
fn skill_frontmatter_name(content: &str) -> Option<String> {
    let mut lines = content.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    for line in lines {
        let t = line.trim();
        if t == "---" {
            break;
        }
        if let Some(rest) = t.strip_prefix("name:") {
            let name = rest.trim().trim_matches(['"', '\'']).trim();
            if !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            {
                return Some(name.to_string());
            }
        }
    }
    None
}

fn run_skill(args: &[String]) -> ExitCode {
    // print = 라이브 SKILL.md 를 stdout 으로(파일 미접촉). 오케스트레이터가 스폰하는 에이전트의
    // system prompt 재료 — --setting-sources "" 헤드리스에선 스킬 자동로드가 없어 프롬프트에 싣는다.
    if args.first().map(String::as_str) == Some("print") {
        let env = pin_env().unwrap_or_else(|_| "app".into());
        print!("{}", skill_doc(&env, Some(SKILL_AUTHORED_BODY)));
        return ExitCode::SUCCESS;
    }
    // refresh = 설치 매니페스트(skill-refresh.json)대로 재생성 — 앱이 레지스트리 변화 시 스폰한다.
    if args.first().map(String::as_str) == Some("refresh") {
        return run_skill_refresh();
    }
    if args.first().map(String::as_str) != Some("install") {
        eprintln!("사용: sok skill install [--claude|--gemini|--codex|--all] [--dir DIR] | sok skill print | sok skill refresh");
        return ExitCode::FAILURE;
    }
    let mut claude = false;
    let mut gemini = false;
    let mut codex = false;
    let mut dir = PathBuf::from(".");
    let mut it = args[1..].iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--claude" => claude = true,
            "--gemini" => gemini = true,
            "--codex" => codex = true,
            "--all" => {
                claude = true;
                gemini = true;
                codex = true;
            }
            "--dir" => match it.next() {
                Some(d) => dir = PathBuf::from(d),
                None => {
                    eprintln!("--dir 에 경로가 필요");
                    return ExitCode::FAILURE;
                }
            },
            other => {
                eprintln!("알 수 없는 옵션: {other}");
                return ExitCode::FAILURE;
            }
        }
    }
    if !claude && !gemini && !codex {
        claude = true;
        gemini = true;
        codex = true; // 기본 --all
    }

    let env = match pin_env() {
        Ok(e) => e,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    let skill_dir = server_name_for_env(&env); // soksak | soksak-dev | soksak-debug
                                               // codex·gemini 는 같은 .agents/skills/ 경로(공유) — 한 번만 쓰면 둘 다 커버.
    let mut targets: Vec<(&str, PathBuf)> = Vec::new();
    if claude {
        targets.push((
            "claude",
            dir.join(format!(".claude/skills/{skill_dir}/SKILL.md")),
        ));
    }
    if codex || gemini {
        let label = if codex && gemini {
            "codex+gemini"
        } else if codex {
            "codex"
        } else {
            "gemini"
        };
        targets.push((
            label,
            dir.join(format!(".agents/skills/{skill_dir}/SKILL.md")),
        ));
    }

    let mut failed = false;
    for (label, path) in &targets {
        // 옛 이름(soksak-control) 잔재 정리 — 발동 충돌 방지(전면 개명, 별칭 없음).
        if let Some(root) = path.parent().and_then(Path::parent) {
            let _ = std::fs::remove_dir_all(root.join("soksak-control"));
        }
        match write_control_skill(path, &env) {
            Ok(_) => println!("{label}  ✓ {}", path.display()),
            Err(e) => {
                eprintln!("{label}  ✗ {e}");
                failed = true;
            }
        }
    }
    // 재생성 매니페스트 — 앱이 레지스트리 변화 때 `sok skill refresh` 를 스폰할 재료.
    if let Err(e) = write_refresh_manifest(&env, &targets) {
        eprintln!("매니페스트 기록 실패(재생성 자동화 불가): {e}");
    }

    // 동봉 플러그인 스킬 — 매니페스트 contributes.skill 선언분을 도구별 디렉토리(.claude/skills/,
    // .agents/skills/) 아래 <name>/SKILL.md 로 설치. 본문 = 저자 오리엔테이션 + 레지스트리에서 합성한
    // 명령 맵(손 전사 금지 — 단일진실=registry). 명령 맵은 install 시점 1회 합성하면 도구별로 동일하다.
    let plugin_skills = discover_plugin_skills();
    for skill in &plugin_skills {
        let doc = compose_plugin_skill(skill);
        for (label, control_path) in &targets {
            // control SKILL.md 의 부모의 부모 = skills 루트(.claude/skills 또는 .agents/skills).
            let Some(skills_root) = control_path.parent().and_then(Path::parent) else {
                continue;
            };
            let path = skills_root.join(&skill.dir_name).join("SKILL.md");
            match write_skill(&path, &doc) {
                Ok(_) => println!("{label}  ✓ {} (plugin)", path.display()),
                Err(e) => {
                    eprintln!("{label}  ✗ {e}");
                    failed = true;
                }
            }
        }
    }

    if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // SKILL.md frontmatter name 추출 — 설치 디렉토리명(dir==name 관례).
    #[test]
    fn skill_frontmatter_name_parses() {
        assert_eq!(
            skill_frontmatter_name("---\nname: soksak-erd\ndescription: x\n---\nbody"),
            Some("soksak-erd".to_string())
        );
        // 따옴표·공백 허용
        assert_eq!(
            skill_frontmatter_name("---\nname:  \"my-skill\" \n---\n"),
            Some("my-skill".to_string())
        );
        // frontmatter 없음 → None
        assert_eq!(skill_frontmatter_name("# 제목\nname: x"), None);
        // 안전하지 않은 문자(경로 주입) 거부
        assert_eq!(skill_frontmatter_name("---\nname: ../evil\n---\n"), None);
    }

    // 기본 환경은 이름별 실물 바이너리가 컴파일 타임에 주입한다(P9) — argv0 추론은 폐기.
    #[test]
    fn 기본_환경은_컴파일_타임_주입이다() {
        let _ = DEFAULT_ENV.set("debug");
        assert_eq!(default_env(), "debug");
    }

    #[test]
    fn 저작_조각_분해와_이름_강제() {
        let (fm, body) = split_directives("---\nname: x\ndescription: d\n---\n\n본문");
        assert_eq!(fm.as_deref(), Some("name: x\ndescription: d"));
        assert_eq!(body, "본문");
        let out = skill_frontmatter("soksak-dev", "dev", fm.as_deref());
        assert!(out.contains("name: soksak-dev"));
        assert!(out.contains("description: d"));
        let (fm2, body2) = split_directives("frontmatter 없는 본문");
        assert!(fm2.is_none());
        assert_eq!(body2, "frontmatter 없는 본문");
    }

    // ── 프로토콜 협상(판 선언 + system.hello 판정) ───────────────────────────

    // 모든 소켓 요청 봉투는 자기 판을 선언한다 — 앱 쪽 VERSION_SKEW 게이트의 재료.
    // 라이브 실측 RED(2026-07-11): 현행 sok 요청에 protocol 필드가 없다(레거시=0 취급만 가능).
    #[test]
    fn every_request_declares_protocol() {
        let req = build_request("state.tree", Value::Null, None, None, None, None);
        assert_eq!(req["protocol"], soksak_spec_socket::SOCKET_PROTOCOL_VERSION);
        assert_eq!(req["method"], "state.tree");
        // 구독(장수 연결)도 같은 빌더를 지난다 — 게이트에 빠짐없이 걸린다.
        let sub = build_request(
            "events.subscribe",
            json!({"kinds":["command"]}),
            None,
            None,
            None,
            None,
        );
        assert_eq!(sub["protocol"], soksak_spec_socket::SOCKET_PROTOCOL_VERSION);
    }

    // 봉투 계약: 선택 필드는 값이 있을 때만 — 빌더 추출이 기존 배선을 보존함을 고정한다.
    #[test]
    fn envelope_optional_fields_only_when_present() {
        let bare = build_request("state.tree", Value::Null, None, None, None, None);
        for k in ["pane", "window", "parent", "timeoutMs"] {
            assert!(bare.get(k).is_none(), "{k} 는 값 없으면 실리지 않는다");
        }
        let full = build_request(
            "term.read",
            json!({"lines": 5}),
            Some("p1".into()),
            Some("w-abc".into()),
            Some("turn-7".into()),
            Some(30_000),
        );
        assert_eq!(full["pane"], "p1");
        assert_eq!(full["window"], "w-abc");
        assert_eq!(full["parent"], "turn-7");
        assert_eq!(full["timeoutMs"], 30_000);
    }

    // 같은 판은 호환. 협상 이전 앱(hello 를 프론트로 흘려 ok:false)은 판 0 — floor 0 인 동안 호환.
    #[test]
    fn hello_verdict_compatible_for_current_and_legacy() {
        use soksak_spec_socket::Lang;
        let modern = json!({"ok": true, "protocol": soksak_spec_socket::SOCKET_PROTOCOL_VERSION});
        let summary = judge_hello_reply(&modern, Lang::En).expect("같은 판은 호환");
        assert!(
            summary.contains("compatible"),
            "요약에 판정 명시: {summary}"
        );
        let legacy = json!({"ok": false, "code": "UNKNOWN_COMMAND", "message": "unknown"});
        let summary =
            judge_hello_reply(&legacy, Lang::En).expect("floor 0 인 동안 구세대 앱은 호환");
        assert!(summary.contains('0'), "구세대=판 0 명시: {summary}");
    }

    // 사람 표면: 요약 문장은 이 셸의 로케일로 해소한다 — ko 로케일이면 한국어.
    // 판 숫자는 언어 독립(같은 자리에 그대로).
    #[test]
    fn hello_summary_resolves_to_shell_locale() {
        use soksak_spec_socket::{Lang, SOCKET_PROTOCOL_VERSION};
        let modern = json!({"ok": true, "protocol": SOCKET_PROTOCOL_VERSION});
        let ko = judge_hello_reply(&modern, Lang::Ko).expect("같은 판은 호환");
        assert!(ko.contains("호환됨"), "ko 로케일은 한국어로 해소: {ko}");
        assert!(
            !ko.contains("compatible"),
            "ko 로케일에 영어 문장이 새면 안 된다: {ko}"
        );
        assert!(
            ko.contains(&SOCKET_PROTOCOL_VERSION.to_string()),
            "판 숫자는 언어 독립: {ko}"
        );
        // 협상 이전 앱(ok:false)은 판 0 으로 판별 — 그 사실도 해소된 언어로 붙는다.
        let legacy = json!({"ok": false, "code": "UNKNOWN_COMMAND", "message": "unknown"});
        let ko = judge_hello_reply(&legacy, Lang::Ko).expect("floor 0 인 동안 구세대 앱은 호환");
        assert!(
            ko.contains("hello 이전 앱"),
            "구세대 앱 사실을 한국어로 고지: {ko}"
        );
    }

    // 앱이 더 새 판이면 sok 이 낡은 쪽 — 방향 명시 문장으로 거부.
    #[test]
    fn hello_verdict_rejects_newer_app() {
        use soksak_spec_socket::Lang;
        let reply = json!({"ok": true, "protocol": 999});
        let err = judge_hello_reply(&reply, Lang::En).expect_err("판이 앞선 앱은 거부");
        assert!(err.contains("999"), "앱 판 숫자: {err}");
        assert!(
            err.contains(&soksak_spec_socket::SOCKET_PROTOCOL_VERSION.to_string()),
            "sok 판 숫자: {err}"
        );
        assert!(err.contains("update this sok"), "낡은 쪽 명시: {err}");
    }

    // 스큐 거부 문장도 사람 표면 — ko 로케일이면 한국어로 해소한다(영어 골격 미누출).
    #[test]
    fn hello_skew_sentence_resolves_to_korean() {
        use soksak_spec_socket::Lang;
        let reply = json!({"ok": true, "protocol": 999});
        let err = judge_hello_reply(&reply, Lang::Ko).expect_err("판이 앞선 앱은 거부");
        assert!(err.contains("999"), "앱 판 숫자: {err}");
        assert!(err.contains("소켓 프로토콜"), "한국어 골격: {err}");
        assert!(
            err.contains("업데이트하세요"),
            "낡은 쪽을 한국어로 명시: {err}"
        );
        assert!(
            !err.contains("speaks socket protocol"),
            "영어 골격 미누출: {err}"
        );
    }

    // env 토큰 검증 — dev|debug|app 만.
    #[test]
    fn env_validation_rejects_unknown() {
        assert!(validate_env("dev").is_ok());
        assert!(validate_env("debug").is_ok());
        assert!(validate_env("app").is_ok());
        assert!(validate_env("prod").is_err());
        assert!(validate_env("release").is_err());
        assert!(validate_env("").is_err());
    }

    // env 토큰 → 소켓 파일명(identifier 와 일치).
    #[test]
    fn socket_name_per_env() {
        assert_eq!(socket_name_for_env("dev"), "com.soksak.dev.sock");
        assert_eq!(socket_name_for_env("debug"), "com.soksak.debug.sock");
        assert_eq!(socket_name_for_env("app"), "com.soksak.app.sock");
    }

    #[test]
    fn socket_peer_must_match_compiled_cli_identity() {
        assert_eq!(identity_for_env("app").unwrap(), "com.soksak.app");
        assert_eq!(identity_for_env("dev").unwrap(), "com.soksak.dev");
        assert_eq!(identity_for_env("debug").unwrap(), "com.soksak.debug");

        let app = json!({"ok": true, "identity": "com.soksak.app"});
        assert!(validate_peer_identity(&app, "com.soksak.app").is_ok());
        let err = validate_peer_identity(&app, "com.soksak.dev").unwrap_err();
        assert!(err.contains("ENVIRONMENT_MISMATCH"));
        assert!(err.contains("com.soksak.dev"));
        assert!(err.contains("com.soksak.app"));

        let unverified = json!({"ok": true});
        assert!(validate_peer_identity(&unverified, "com.soksak.app").is_err());
    }

    #[test]
    fn identity_preflight_and_command_use_one_session() {
        let request = build_request("state.tree", Value::Null, None, None, None, None);
        let mut methods = Vec::new();
        let reply = authenticated_exchange("com.soksak.app", "state.tree", &request, |message| {
            let method = message["method"].as_str().unwrap().to_string();
            methods.push(method.clone());
            match method.as_str() {
                "system.hello" => Ok(json!({"ok": true, "identity": "com.soksak.app"})),
                "state.tree" => Ok(json!({"ok": true, "data": {"tree": []}})),
                _ => Err(format!("unexpected method: {method}")),
            }
        })
        .expect("authenticated command");
        assert_eq!(reply["ok"], true);
        assert_eq!(methods, ["system.hello", "state.tree"]);
    }

    // 소켓 위치는 주입값 또는 컴파일 identity 홈에서 결정한다. 주입값도 identity 검증을 우회하지 못한다.
    #[test]
    fn 환경은_정체성이다() {
        // 앱이 주입한 SOKSAK_SOCKET은 위치 힌트다. 실제 권위는 뒤따르는 hello identity 검증이다.
        match resolve_target(Some("/x.sock".into())) {
            SockTarget::Explicit(p) => assert_eq!(p, "/x.sock"),
            _ => panic!("앱 주입 소켓 위치가 선택되어야"),
        }
        // 주입이 없으면 컴파일된 자기 환경(테스트 프로세스의 설정값).
        match resolve_target(None) {
            SockTarget::Env(e) => assert_eq!(e, default_env()),
            _ => panic!("컴파일 환경이어야"),
        }
        // 빈 문자열 주입은 무시.
        match resolve_target(Some(String::new())) {
            SockTarget::Env(e) => assert_eq!(e, default_env()),
            _ => panic!("빈 값 무시여야"),
        }
    }

    // 도메인 지도: 도메인별 1줄, 플러그인 collapse, per-command params 미포함(P5).
    #[test]
    fn domain_map_groups_and_collapses() {
        let cmds = vec![
            json!({"name":"panel.split","params":{"side":{"type":"string"}}}),
            json!({"name":"panel.merge"}),
            json!({"name":"browser.navigate"}),
            json!({"name":"browser.dom.click"}),
            json!({"name":"plugin.soksak-plugin-clip.clip.capture"}),
            json!({"name":"plugin.soksak-plugin-clip.clip.list"}),
        ];
        let map = domain_map(&cmds);
        assert!(map.contains("- panel (2): merge, split"), "{map}");
        assert!(map.contains("- browser (1): navigate"), "{map}");
        assert!(map.contains("- browser.dom (1): click"), "{map}");
        assert!(map.contains("- plugin (2): dynamic"), "{map}");
        assert!(
            !map.contains("clip.capture"),
            "플러그인 per-command 가 새면 안 됨: {map}"
        );
        assert!(
            !map.contains("\"type\""),
            "params 가 지도에 포함되면 안 됨: {map}"
        );
    }

    // skill_doc_with: frontmatter(name+description) + 주입된 도메인 지도. per-command 카탈로그 없음.
    #[test]
    fn skill_doc_has_frontmatter_and_map_no_catalog() {
        let doc = skill_doc_with("- panel (2): merge, split\n", "dev", None);
        assert!(
            doc.starts_with("---\nname: soksak-dev\n"),
            "frontmatter 누락(환경 이름)"
        );
        assert!(doc.contains("description:"), "description 트리거 누락");
        assert!(doc.contains("Environment: **dev**"), "환경 핀 블록 누락");
        assert!(
            doc.contains("- panel (2): merge, split"),
            "도메인 지도 주입 누락"
        );
        assert!(doc.contains("AUTO-GENERATED"), "생성 헤더 누락(P10)");
        assert!(doc.contains("`sok commands`"), "발견 명령 안내 누락(P5)");
        assert!(
            !doc.contains("\"params\""),
            "per-command params 가 스킬에 새면 안 됨"
        );
    }

    // env 토큰 → MCP 서버 이름(세 환경 공존).
    #[test]
    fn server_name_per_env() {
        assert_eq!(server_name_for_env("app"), "soksak");
        assert_eq!(server_name_for_env("dev"), "soksak-dev");
        assert_eq!(server_name_for_env("debug"), "soksak-debug");
    }

    // `<tool> mcp add` argv 빌더(2026 공식문서 문법). env SOKSAK_SOCKET 핀.
    #[test]
    fn mcp_add_argv_per_tool() {
        let (p, a) = mcp_add_argv("claude", "soksak-dev", "/s.sock", "/bin/sok").unwrap();
        assert_eq!(p, "claude");
        assert_eq!(
            a,
            vec![
                "mcp",
                "add",
                "--scope",
                "user",
                "--env",
                "SOKSAK_SOCKET=/s.sock",
                "soksak-dev",
                "--",
                "/bin/sok",
                "mcp"
            ]
        );

        let (p, a) = mcp_add_argv("codex", "soksak", "/s.sock", "/bin/sok").unwrap();
        assert_eq!(p, "codex");
        assert_eq!(
            a,
            vec![
                "mcp",
                "add",
                "soksak",
                "--env",
                "SOKSAK_SOCKET=/s.sock",
                "--",
                "/bin/sok",
                "mcp"
            ]
        );

        let (p, a) = mcp_add_argv("gemini", "soksak-debug", "/s.sock", "/bin/sok").unwrap();
        assert_eq!(p, "gemini");
        assert_eq!(
            a,
            vec![
                "mcp",
                "add",
                "soksak-debug",
                "-e",
                "SOKSAK_SOCKET=/s.sock",
                "-s",
                "user",
                "/bin/sok",
                "mcp"
            ]
        );

        assert!(mcp_add_argv("unknown", "x", "y", "z").is_err());
    }

    // 전역 --env 플래그 추출(어느 위치든) + 제거.
    #[test]
    fn take_flag_extracts_and_removes() {
        let mut a = vec!["--env".to_string(), "dev".into(), "state.tree".into()];
        assert_eq!(take_flag_value(&mut a, "--env"), Some("dev".into()));
        assert_eq!(a, vec!["state.tree".to_string()]);

        // 명령 뒤에 와도 추출.
        let mut b = vec![
            "mcp".to_string(),
            "install".into(),
            "--env".into(),
            "debug".into(),
        ];
        assert_eq!(take_flag_value(&mut b, "--env"), Some("debug".into()));
        assert_eq!(b, vec!["mcp".to_string(), "install".into()]);

        // 없으면 None, 원본 보존.
        let mut c = vec!["state.tree".to_string()];
        assert_eq!(take_flag_value(&mut c, "--env"), None);
        assert_eq!(c, vec!["state.tree".to_string()]);

        // 값 없는 --env 는 제거하고 None.
        let mut d = vec!["state.tree".to_string(), "--env".into()];
        assert_eq!(take_flag_value(&mut d, "--env"), None);
        assert_eq!(d, vec!["state.tree".to_string()]);
    }
}
