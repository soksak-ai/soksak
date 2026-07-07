// sok — soksak 원격 제어 CLI (kitty @ / tmux 모델).
// 실행 중인 soksak 앱의 Unix 소켓(JSON-RPC)으로 명령을 보낸다. 전 기능 카탈로그는
// 앱의 Command Registry 가 단일 진실이며, 이 CLI 는 전송 + 매뉴얼 포맷터일 뿐이다.
//
// 사용:
//   sok <command> ['{"k":"v"}']   # 예: sok panel.split '{"side":"right"}'
//   sok commands                  # 전체 카탈로그(JSON)
//   sok help <command>            # 단일 명령 매뉴얼
//   sok docs                      # 전체 매뉴얼 마크다운(stdout)
//   sok skill install [--claude|--gemini|--codex|--all] [--dir DIR]
//
// 컨텍스트: soksak 터미널 안에서는 $SOKSAK_PANE/$SOKSAK_SOCKET 이 자동 주입되어
// 대상 id 를 생략하면 "내 위치"가 기본이 된다.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::OnceLock;

use serde_json::{json, Value};

fn main() -> ExitCode {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    // 전역 --env 추출(환경 묶임 P9). 명령 파싱 전에 제거 → 위치 인자 구조 보존.
    let _ = ENV_OVERRIDE.set(take_flag_value(&mut args, "--env"));
    // 전역 --window 추출 — env(SOKSAK_WINDOW)보다 우선하는 창 명시 타겟. AI 에이전트는 셸 권한이
    // `sok …` prefix 로만 열리므로(env 프리픽스 불가) 플래그가 유일한 창 지정 수단이다.
    let _ = WINDOW_OVERRIDE.set(take_flag_value(&mut args, "--window"));
    match args.first().map(String::as_str) {
        None | Some("-h") | Some("--help") => {
            print_usage();
            ExitCode::SUCCESS
        }
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
            run_docs(rest.iter().any(|a| a == "--core"), format.as_deref().unwrap_or("md"))
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
  sok <command> ['{{JSON params}}']    명령 실행 (예: sok panel.split '{{\"side\":\"right\"}}')
  sok state.tree                      전체 구조(주소록): 모든 id + 패널 rect
  sok commands                        전체 명령 카탈로그(JSON)
  sok help <command>                  단일 명령 매뉴얼
  sok docs [--core] [--format md|json] 가능한 명령 전체 레퍼런스(기본 md; json=기계용)
  sok events [--kinds a,b] [--since N] 활동 스트림 팔로우(JSONL, Ctrl-C 종료)
  sok skill install [--claude|--gemini|--codex|--all] [--dir DIR]
                                      AI 에이전트 트리거 스킬 설치(soksak 제어법)
  sok skill print                     라이브 SKILL.md 를 stdout 으로(프롬프트 재료)
  sok mcp install [--claude|--codex|--gemini|--all] [--env dev|debug|app]
                                      MCP 서버 등록(네이티브 mcp add, SOKSAK_SOCKET 핀)

컨텍스트:
  soksak 터미널 안에서는 $SOKSAK_PANE 이 자동 주입되어, 대상 id 를 생략하면
  호출한 pane 의 위치(패널/컨텐츠/프로젝트)가 기본 대상이 된다.
  멀티 윈도우: sok --window <label> <command> 또는 $SOKSAK_WINDOW 로 특정 창을 지정
  (생략 시 활성 창). 창 목록은 sok window.list, 새 창은 sok window.new.
  상관: $SOKSAK_PARENT 가 있으면 요청에 parent 로 실려 활동 엔트리가 그 턴으로 묶인다.

환경(한 sok 은 한 환경에만 묶인다 — 침묵 cross-env 금지):
  $SOKSAK_SOCKET(앱이 PTY 에 주입) > --env dev|debug|app > $SOKSAK_ENV > 설치명
  (sok-dev→dev, sok-debug→debug, sok→release). 그 환경 미실행이면 에러(다른 환경 대체 안 함)."
    );
}

// ── 소켓 ────────────────────────────────────────────────────────────────────

// 환경 묶임(배신 차단, docs/AI-CONTROL.md P9). 앱 정체성 3개(com.soksak.{dev|debug|app})로
// 소켓이 분리된다. sok 은 정확히 한 환경에 묶이고, 의도치 않은 다른 환경에 침묵으로 붙지 않는다.
// 우선순위: SOKSAK_SOCKET(앱이 PTY 에 주입, 권위) > --env/SOKSAK_ENV > argv0 접미사
// (sok-dev→dev, sok-debug→debug, sok→app). env 가 정해지면 그 소켓만 — 없으면 에러(다른 env 대체 금지).
// "살아있는-1개-잡기" 는 폐기(어느 env 든 말없이 잡던 배신 지점).

// --env 전역 플래그(있으면). main 이 1회 설정.
static ENV_OVERRIDE: OnceLock<Option<String>> = OnceLock::new();
// --window 전역 플래그(있으면). main 이 1회 설정 — send_request 의 창 해소에서 env 보다 우선.
static WINDOW_OVERRIDE: OnceLock<Option<String>> = OnceLock::new();

// argv0 basename → 기본 env 토큰. busybox 패턴: 설치명이 곧 환경.
fn env_from_prog(prog: &str) -> &'static str {
    let base = prog.rsplit(['/', '\\']).next().unwrap_or(prog);
    if base.ends_with("-dev") {
        "dev"
    } else if base.ends_with("-debug") {
        "debug"
    } else {
        "app"
    }
}

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

// env 토큰 → 소켓 절대경로(존재·생존 검사 없음 — 핀 용도). validate_env 통과 전제.
// identity 홈 계약(코어 home.rs 와 동일, docs/ARCHITECTURE.md): app=~/.soksak, 그 외
// env=~/.soksak-<env>. 데이터·플러그인·소켓이 identity 별로 완전 분리되므로 소켓도 그 홈에 산다.
// SOKSAK_HOME env 가 최우선(테스트 격리) — sok 는 독립 busybox 바이너리라 계약을 자체 구현한다.
fn home_for_env(env: &str) -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("SOKSAK_HOME") {
        if !p.is_empty() {
            return Ok(PathBuf::from(p));
        }
    }
    let home = std::env::var("HOME").map_err(|_| "HOME 없음".to_string())?;
    let suffix = if env == "app" { String::new() } else { format!("-{env}") };
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

fn resolve_target(
    soksak_socket: Option<String>,
    env_flag: Option<String>,
    soksak_env: Option<String>,
    prog: &str,
) -> SockTarget {
    if let Some(p) = soksak_socket.filter(|s| !s.is_empty()) {
        return SockTarget::Explicit(p);
    }
    if let Some(e) = env_flag.filter(|s| !s.is_empty()) {
        return SockTarget::Env(e);
    }
    if let Some(e) = soksak_env.filter(|s| !s.is_empty()) {
        return SockTarget::Env(e);
    }
    SockTarget::Env(env_from_prog(prog).to_string())
}

// 묶인 환경의 소켓 경로. env 가 정해졌으면 그 소켓만 — 살아있지 않으면 에러(다른 env 로 대체 안 함).
fn resolve_socket() -> Result<PathBuf, String> {
    let target = resolve_target(
        std::env::var("SOKSAK_SOCKET").ok(),
        ENV_OVERRIDE.get().cloned().flatten(),
        std::env::var("SOKSAK_ENV").ok(),
        &std::env::args().next().unwrap_or_default(),
    );
    match target {
        SockTarget::Explicit(p) => Ok(PathBuf::from(p)),
        SockTarget::Env(env) => {
            let path = socket_path_for_env(&env)?;
            if UnixStream::connect(&path).is_ok() {
                Ok(path)
            } else {
                Err(format!(
                    "soksak({env}) 미실행 — 소켓 없음: {}\n다른 환경은 SOKSAK_ENV=dev|debug|app 또는 설치명(sok-dev) 으로 지정.",
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
    let stream = match UnixStream::connect(&sock) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("소켓 연결 실패({}): {e}", sock.display());
            return ExitCode::FAILURE;
        }
    };
    let mut w = stream.try_clone().expect("소켓 클론 실패");
    let req = json!({ "id": 1, "method": "events.subscribe", "params": params });
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
    let mut stream =
        UnixStream::connect(&sock).map_err(|e| format!("소켓 연결 실패({}): {e}", sock.display()))?;
    let mut req = json!({ "id": 1, "method": method, "params": params });
    if let Some(p) = pane.or_else(|| std::env::var("SOKSAK_PANE").ok()) {
        req["pane"] = json!(p);
    }
    // 멀티 윈도우 타겟 창: 명시 > --window > SOKSAK_WINDOW. 생략 시 코어가 활성 창으로 라우팅.
    if let Some(w) = window
        .or_else(|| WINDOW_OVERRIDE.get().cloned().flatten())
        .or_else(|| std::env::var("SOKSAK_WINDOW").ok())
    {
        req["window"] = json!(w);
    }
    // 상관 부모(SOKSAK_PARENT — 오케스트레이터가 스폰한 에이전트에 주입). 이 실행에서 비롯된
    // 활동 엔트리가 그 대화 턴(parentId)으로 묶인다. pane/window 와 같은 env 컨텍스트 모델.
    if let Some(p) = std::env::var("SOKSAK_PARENT").ok().filter(|s| !s.is_empty()) {
        req["parent"] = json!(p);
    }
    if let Some(t) = timeout_ms {
        req["timeoutMs"] = json!(t);
    }
    writeln!(stream, "{req}").map_err(|e| format!("요청 전송 실패: {e}"))?;
    let mut line = String::new();
    BufReader::new(stream)
        .read_line(&mut line)
        .map_err(|e| format!("응답 수신 실패: {e}"))?;
    serde_json::from_str(&line).map_err(|e| format!("응답 파싱 실패: {e}"))
}

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

fn fetch_commands() -> Result<Vec<Value>, String> {
    let v = request("state.commands", Value::Null)?;
    // 응답 봉투(MESSAGE-PROTOCOL) — 기계 페이로드는 data 에 중첩된다.
    v.get("data")
        .and_then(|d| d.get("commands"))
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "카탈로그 응답 형식 오류".into())
}

fn format_command_md(c: &Value) -> String {
    let name = c["name"].as_str().unwrap_or("?");
    let mut out = format!("## `{name}`\n\n{}\n\n", c["description"].as_str().unwrap_or(""));
    let params = c["params"].as_object();
    if params.is_some_and(|p| !p.is_empty()) {
        out.push_str("| Parameter | Type | Required | Description |\n|---|---|---|---|\n");
        for (k, p) in params.unwrap() {
            let ty = p["type"].as_str().unwrap_or("?");
            let req = if p["required"].as_bool().unwrap_or(false) { "✓" } else { "" };
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
    out.push_str(&format!("**Returns**: {}\n", c["returns"].as_str().unwrap_or("{}")));
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
                ExitCode::SUCCESS
            }
            None => {
                eprintln!("알 수 없는 명령: {cmd} (sok commands 로 목록 확인)");
                ExitCode::FAILURE
            }
        },
    }
}

fn run_docs(core_only: bool, format: &str) -> ExitCode {
    // 원천 = 코어 자동화 명령 command.docs(전체 표면 단일 반환) — CLI 는 마크다운 표현만 담당.
    // 플러그인 명령 스키마는 창-로컬 등록이라, 창 미지정이면 워크스페이스 창(w-*)을 자동 선택해
    // 어느 창(오케스트레이터 포함)에서 불러도 같은 전체 레퍼런스가 나온다.
    let window = WINDOW_OVERRIDE.get().cloned().flatten().or_else(|| {
        request("window.list", Value::Null)
            .ok()
            .and_then(|v| {
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
    });
    let v = match send_request("command.docs", Value::Null, None, window, None) {
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
        eprintln!("사용: sok docs [--core] [--format md|json]");
        return ExitCode::FAILURE;
    }
    let data = v.get("data").cloned().unwrap_or(Value::Null);
    let core = data.get("core").and_then(Value::as_array).cloned().unwrap_or_default();
    println!("# soksak 명령 레퍼런스\n");
    println!("> 자동 생성 문서 — 원천은 `command.docs`(앱 Command Registry + 레지스트리 카탈로그).\n");
    println!("모든 명령: `sok <command> ['{{JSON}}']`. 대상 id 생략 시 호출 컨텍스트($SOKSAK_PANE) 기본.\n");
    if core_only {
        println!("코어 명령만 수록한다(--core — 리포지토리 문서용, 설치본 무관). 전체는 `sok docs`.\n");
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
    let entries = data.get("registry").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut printed: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for e in &entries {
        let id = e["id"].as_str().unwrap_or("?");
        for c in e["commands"].as_array().map(|a| a.iter()).into_iter().flatten() {
            let n = c["name"].as_str().unwrap_or("?");
            let full = format!("plugin.{id}.{n}");
            printed.insert(full.clone());
            if let Some(spec) = runtime.get(&full) {
                println!("{}", format_command_md(spec));
            } else {
                let t = c["title"]["ko"]
                    .as_str()
                    .or_else(|| c["title"]["en"].as_str())
                    .unwrap_or("");
                let dg = c["danger"].as_str().map(|d| format!(" (danger: {d})")).unwrap_or_default();
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
                None => Ok((format!("알 수 없는 명령: {cmd} (soksak_commands 로 목록 확인)"), true)),
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
    println!(
        "{}",
        json!({"jsonrpc": "2.0", "id": id, "result": result})
    );
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
                            "text": skill_doc(),
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

// 설치 핀 환경(ENV_OVERRIDE=--env > SOKSAK_ENV > argv0). SOKSAK_SOCKET 절대경로는 핀 대상 아님(env 토큰 필요).
fn pin_env() -> Result<String, String> {
    let e = ENV_OVERRIDE
        .get()
        .cloned()
        .flatten()
        .or_else(|| std::env::var("SOKSAK_ENV").ok().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| {
            env_from_prog(&std::env::args().next().unwrap_or_default()).to_string()
        });
    validate_env(&e).map(String::from)
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
            v(&["mcp", "add", "--scope", "user", "--env", &envpair, server, "--", sok, "mcp"]),
        )),
        // codex mcp add <name> --env K=V -- <sok> mcp
        "codex" => Ok((
            "codex".into(),
            v(&["mcp", "add", server, "--env", &envpair, "--", sok, "mcp"]),
        )),
        // gemini mcp add <name> -e K=V -s user <sok> mcp  (flags before command, per docs)
        "gemini" => Ok((
            "gemini".into(),
            v(&["mcp", "add", server, "-e", &envpair, "-s", "user", sok, "mcp"]),
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
                eprintln!("사용: sok mcp install [--claude|--codex|--gemini|--all] [--env dev|debug|app]");
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
const SKILL_FRONTMATTER: &str = "---\nname: soksak-control\ndescription: Control the soksak terminal app via the `sok` CLI — discover and run any soksak command. Reach for this whenever the user acts on anything inside soksak: split/merge/close panels & tabs, open terminals/browsers/editors, run and read terminal output, drive TUIs, automate the embedded browser (navigate/click/fill/eval), draw or annotate on the screen, manage windows/files/bookmarks/clipboard. If the user says they marked/drew/showed/annotated something \"on screen\" or \"in the browser\", it is almost certainly a soksak overlay or view — start here, not an external design tool. 화면/브라우저에 표시·낙서·주석·그림, 패널 나누기, 터미널 실행도 여기.\n---\n";

const SKILL_BODY_HEAD: &str = r#"# Controlling soksak with `sok`

> AUTO-GENERATED by `sok skill install` — edits are overwritten. Source of truth is `sok commands`.

Orientation only. `sok commands` (catalog) and `sok help <cmd>` (one command's schema) are the
live single source of truth — this file is a map, not the full catalog.

soksak is a terminal app with a 3-level layout: projects (t*) -> contents (c*, tabs of split
grids) -> panels (g*, split groups) holding views (v*: terminal / file editor / browser;
terminals contain panes p*). Every feature is a `sok` command.

## Address model (targeting)

- `sok state.tree` returns every id plus each panel's on-screen rect (%) — the address book.
- Inside a soksak terminal, `$SOKSAK_PANE` marks your pane. Omit target ids and commands
  default to your own location. `sok state.context` shows where you are.
- Pass explicit ids to act anywhere: `sok panel.split '{"group":"g3","side":"right"}'`.

## Workflow — always verify

1. `sok commands` (or `sok commands '{"domain":"panel"}'`) to discover; `sok help <cmd>` for one schema.
2. `sok state.tree` to discover live targets.
3. Run the command. Mutations return resulting ids/state, e.g. panel.split ->
   `{"ok":true,"groupId":"g4","viewId":"v5","paneId":"p6"}`.
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

- Windows are first-class: `sok window.new '{"root":"/abs/path"}'` opens a project in its own
  window (P6 single-open: an already-open root focuses its window and returns `existingWindow`).
  `sok window.new '{"mode":"orchestrator"}'` opens the observation window (idempotent).
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

- close commands are destructive: panel.close removes every tab in the panel; the last project/content/view/pane is protected (LAST_ITEM error).
- term.send writes raw bytes to the PTY; term.exec appends Enter.
- browser.eval runs arbitrary JS in the page; `return` a JSON-serializable value.
"#;

// 앱 미가동(소켓 없음) 시 fallback 도메인 지도 — 코어 도메인만(플러그인은 라이브일 때만 발견).
const CORE_DOMAIN_MAP: &str = "\
- state: tree, context, commands
- project: list, create, activate, ...
- content: list, create, activate, ...
- panel: split, merge, move, resize, ...
- pane: split, focus, close, ...
- view: open, activate, move, ...
- window: new, list, focus, snapshot, ...
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
        let Some(name) = c["name"].as_str() else { continue };
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

// 도메인 지도(주입)로 SKILL.md 전문 조립(순수). frontmatter + 오리엔테이션 본문 + 지도.
fn skill_doc_with(map: &str) -> String {
    format!("{SKILL_FRONTMATTER}\n{SKILL_BODY_HEAD}{map}{SKILL_BODY_TAIL}")
}

// 라이브 SKILL.md. 앱 가동이면 카탈로그에서 도메인 지도 파생, 미가동이면 코어 지도 fallback.
fn skill_doc() -> String {
    let map = match fetch_commands() {
        Ok(cmds) => domain_map(&cmds),
        Err(_) => CORE_DOMAIN_MAP.to_string(),
    };
    skill_doc_with(&map)
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
    let Ok(home) = std::env::var("HOME") else { return out };
    let base = PathBuf::from(home).join(".soksak").join("plugins");
    let Ok(entries) = std::fs::read_dir(&base) else { return out };
    for e in entries.flatten() {
        let pdir = e.path();
        if !pdir.is_dir() {
            continue;
        }
        let Ok(txt) = std::fs::read_to_string(pdir.join("plugin.json")) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&txt) else { continue };
        let id = v["id"].as_str().unwrap_or("").trim().to_string();
        if id.is_empty() {
            continue;
        }
        let Some(rel) = v["contributes"]["skill"]["path"].as_str() else { continue };
        // 디렉토리 탈출 방어(스펙도 막지만 CLI 도 독립 방어).
        if rel.starts_with('/') || rel.split('/').any(|s| s == "..") {
            continue;
        }
        let Ok(body) = std::fs::read_to_string(pdir.join(rel)) else { continue };
        // 설치 디렉토리 = SKILL.md frontmatter name(Claude 관례: dir==name). 없으면 플러그인 id.
        let dir_name = skill_frontmatter_name(&body).unwrap_or_else(|| id.clone());
        out.push(PluginSkill { dir_name, plugin_id: id, body });
    }
    out.sort_by(|a, b| a.dir_name.cmp(&b.dir_name));
    out
}

// 플러그인 명령 맵 합성 — 라이브 카탈로그에서 plugin.<id>.* 만 추려 `- sub — base` 목록(단일진실=registry).
// base = 합성 description 의 트리거어 앞부분(사람 가독). 카탈로그 미가용(앱 다운)이면 빈 문자열.
fn plugin_command_map(plugin_id: &str) -> String {
    let Ok(cmds) = fetch_commands() else { return String::new() };
    let prefix = format!("plugin.{plugin_id}.");
    let mut out = String::new();
    for c in &cmds {
        let Some(name) = c["name"].as_str() else { continue };
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
                && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
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
        print!("{}", skill_doc());
        return ExitCode::SUCCESS;
    }
    if args.first().map(String::as_str) != Some("install") {
        eprintln!("사용: sok skill install [--claude|--gemini|--codex|--all] [--dir DIR] | sok skill print");
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

    let doc = skill_doc();
    // codex·gemini 는 같은 .agents/skills/ 경로(공유) — 한 번만 쓰면 둘 다 커버.
    let mut targets: Vec<(&str, PathBuf)> = Vec::new();
    if claude {
        targets.push(("claude", dir.join(".claude/skills/soksak-control/SKILL.md")));
    }
    if codex || gemini {
        let label = if codex && gemini {
            "codex+gemini"
        } else if codex {
            "codex"
        } else {
            "gemini"
        };
        targets.push((label, dir.join(".agents/skills/soksak-control/SKILL.md")));
    }

    let mut failed = false;
    for (label, path) in &targets {
        match write_skill(path, &doc) {
            Ok(_) => println!("{label}  ✓ {}", path.display()),
            Err(e) => {
                eprintln!("{label}  ✗ {e}");
                failed = true;
            }
        }
    }

    // 동봉 플러그인 스킬 — 매니페스트 contributes.skill 선언분을 도구별 디렉토리(.claude/skills/,
    // .agents/skills/) 아래 <name>/SKILL.md 로 설치. 본문 = 저자 오리엔테이션 + 레지스트리에서 합성한
    // 명령 맵(손 전사 금지 — 단일진실=registry). 명령 맵은 install 시점 1회 합성하면 도구별로 동일하다.
    let plugin_skills = discover_plugin_skills();
    for skill in &plugin_skills {
        let doc = compose_plugin_skill(skill);
        for (label, control_path) in &targets {
            // control SKILL.md 의 부모의 부모 = skills 루트(.claude/skills 또는 .agents/skills).
            let Some(skills_root) = control_path.parent().and_then(Path::parent) else { continue };
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

    // argv0 접미사 → env 토큰(busybox 디스패치). 경로 접두 무시.
    #[test]
    fn argv0_maps_to_env() {
        assert_eq!(env_from_prog("sok"), "app");
        assert_eq!(env_from_prog("/usr/local/bin/sok"), "app");
        assert_eq!(env_from_prog("sok-dev"), "dev");
        assert_eq!(env_from_prog("/path/to/sok-dev"), "dev");
        assert_eq!(env_from_prog("sok-debug"), "debug");
        assert_eq!(env_from_prog("target/debug/sok-debug"), "debug");
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

    // 소켓 타겟 우선순위: SOKSAK_SOCKET > --env > SOKSAK_ENV > argv0.
    #[test]
    fn resolve_priority() {
        // SOKSAK_SOCKET(명시 경로) 최우선.
        match resolve_target(Some("/x.sock".into()), Some("dev".into()), Some("debug".into()), "sok-dev") {
            SockTarget::Explicit(p) => assert_eq!(p, "/x.sock"),
            _ => panic!("SOKSAK_SOCKET 이 최우선이어야"),
        }
        // --env 가 SOKSAK_ENV·argv0 보다 우선.
        match resolve_target(None, Some("dev".into()), Some("debug".into()), "sok-debug") {
            SockTarget::Env(e) => assert_eq!(e, "dev"),
            _ => panic!("--env 우선이어야"),
        }
        // SOKSAK_ENV 가 argv0 보다 우선.
        match resolve_target(None, None, Some("debug".into()), "sok-dev") {
            SockTarget::Env(e) => assert_eq!(e, "debug"),
            _ => panic!("SOKSAK_ENV 우선이어야"),
        }
        // 아무것도 없으면 argv0 가 결정.
        match resolve_target(None, None, None, "sok-dev") {
            SockTarget::Env(e) => assert_eq!(e, "dev"),
            _ => panic!("argv0 fallback 이어야"),
        }
        // 빈 문자열은 무시(설정 안 된 것으로 취급).
        match resolve_target(Some(String::new()), Some(String::new()), None, "sok") {
            SockTarget::Env(e) => assert_eq!(e, "app"),
            _ => panic!("빈 값 무시 후 argv0 여야"),
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
        assert!(!map.contains("clip.capture"), "플러그인 per-command 가 새면 안 됨: {map}");
        assert!(!map.contains("\"type\""), "params 가 지도에 포함되면 안 됨: {map}");
    }

    // skill_doc_with: frontmatter(name+description) + 주입된 도메인 지도. per-command 카탈로그 없음.
    #[test]
    fn skill_doc_has_frontmatter_and_map_no_catalog() {
        let doc = skill_doc_with("- panel (2): merge, split\n");
        assert!(doc.starts_with("---\nname: soksak-control\n"), "frontmatter 누락");
        assert!(doc.contains("description:"), "description 트리거 누락");
        assert!(doc.contains("- panel (2): merge, split"), "도메인 지도 주입 누락");
        assert!(doc.contains("AUTO-GENERATED"), "생성 헤더 누락(P10)");
        assert!(doc.contains("`sok commands`"), "발견 명령 안내 누락(P5)");
        assert!(!doc.contains("\"params\""), "per-command params 가 스킬에 새면 안 됨");
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
                "mcp", "add", "--scope", "user", "--env", "SOKSAK_SOCKET=/s.sock", "soksak-dev",
                "--", "/bin/sok", "mcp"
            ]
        );

        let (p, a) = mcp_add_argv("codex", "soksak", "/s.sock", "/bin/sok").unwrap();
        assert_eq!(p, "codex");
        assert_eq!(
            a,
            vec!["mcp", "add", "soksak", "--env", "SOKSAK_SOCKET=/s.sock", "--", "/bin/sok", "mcp"]
        );

        let (p, a) = mcp_add_argv("gemini", "soksak-debug", "/s.sock", "/bin/sok").unwrap();
        assert_eq!(p, "gemini");
        assert_eq!(
            a,
            vec![
                "mcp", "add", "soksak-debug", "-e", "SOKSAK_SOCKET=/s.sock", "-s", "user",
                "/bin/sok", "mcp"
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
        let mut b = vec!["mcp".to_string(), "install".into(), "--env".into(), "debug".into()];
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
