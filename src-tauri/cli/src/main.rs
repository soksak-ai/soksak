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

use serde_json::{json, Value};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
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
        Some("docs") => run_docs(),
        Some("skill") => run_skill(&args[1..]),
        Some("mcp") => run_mcp(),
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
  sok docs                            전체 매뉴얼 마크다운 출력
  sok skill install [--claude|--gemini|--codex|--all] [--dir DIR]
                                      AI 에이전트 스킬 설치(soksak 제어법)

컨텍스트:
  soksak 터미널 안에서는 $SOKSAK_PANE 이 자동 주입되어, 대상 id 를 생략하면
  호출한 pane 의 위치(패널/컨텐츠/프로젝트)가 기본 대상이 된다.
  소켓: $SOKSAK_SOCKET 또는 ~/.soksak/*.sock 자동 탐색."
    );
}

// ── 소켓 ────────────────────────────────────────────────────────────────────

fn find_socket() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("SOKSAK_SOCKET") {
        return Ok(PathBuf::from(p));
    }
    let home = std::env::var("HOME").map_err(|_| "HOME 없음".to_string())?;
    let dir = PathBuf::from(home).join(".soksak");
    let mut alive: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().is_some_and(|x| x == "sock")
                && UnixStream::connect(&p).is_ok()
            {
                alive.push(p);
            }
        }
    }
    match alive.len() {
        0 => Err("실행 중인 soksak 을 찾지 못함(소켓 없음). 앱을 먼저 실행하세요.".into()),
        1 => Ok(alive.remove(0)),
        _ => Err(format!(
            "soksak 인스턴스가 여러 개입니다. SOKSAK_SOCKET 으로 지정하세요:\n{}",
            alive
                .iter()
                .map(|p| format!("  {}", p.display()))
                .collect::<Vec<_>>()
                .join("\n")
        )),
    }
}

fn request(method: &str, params: Value) -> Result<Value, String> {
    let sock = find_socket()?;
    let mut stream =
        UnixStream::connect(&sock).map_err(|e| format!("소켓 연결 실패({}): {e}", sock.display()))?;
    let req = json!({
        "id": 1,
        "method": method,
        "params": params,
        "pane": std::env::var("SOKSAK_PANE").ok(),
    });
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
    v.get("commands")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "카탈로그 응답 형식 오류".into())
}

fn format_command_md(c: &Value) -> String {
    let name = c["name"].as_str().unwrap_or("?");
    let mut out = format!("## `{name}`\n\n{}\n\n", c["description"].as_str().unwrap_or(""));
    let params = c["params"].as_object();
    if params.is_some_and(|p| !p.is_empty()) {
        out.push_str("| 파라미터 | 타입 | 필수 | 설명 |\n|---|---|---|---|\n");
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
                    desc.push_str(&format!(" [기본 {d}]"));
                }
            }
            out.push_str(&format!("| `{k}` | {ty} | {req} | {desc} |\n"));
        }
        out.push('\n');
    }
    out.push_str(&format!("**반환**: {}\n", c["returns"].as_str().unwrap_or("{}")));
    if let Some(errs) = c["errors"].as_array() {
        if !errs.is_empty() {
            let list: Vec<_> = errs.iter().filter_map(Value::as_str).collect();
            out.push_str(&format!("**에러**: {}\n", list.join(", ")));
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

fn run_docs() -> ExitCode {
    match fetch_commands() {
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
        Ok(cmds) => {
            println!("# soksak 명령 레퍼런스\n");
            println!("> 자동 생성 문서 — 원천은 앱 Command Registry(`sok docs` 로 재생성).\n");
            println!("모든 명령: `sok <command> ['{{JSON}}']`. 대상 id 생략 시 호출 컨텍스트($SOKSAK_PANE) 기본.\n");
            for c in &cmds {
                println!("{}", format_command_md(c));
            }
            ExitCode::SUCCESS
        }
    }
}

// ── MCP stdio 서버 (Model Context Protocol 2024-11-05) ──────────────────────
// `sok mcp` — stdin/stdout JSON-RPC 로 MCP 클라이언트(claude 등)에 soksak 전 기능을
// tool 로 노출한다. tool 목록은 앱 registry(state.commands)에서 동적 생성(단일 진실).
// MCP tool 이름은 [a-zA-Z0-9_-] 만 허용 → 명령 이름의 "." 을 "_" 로 양방향 치환.
// 직접 구현 사유: 카탈로그가 런타임 동적이라 정적 매크로 SDK 보다 소형 핸들러가
// 정확하고, 추가 의존성이 없다(프로토콜은 newline-delimited JSON-RPC 2.0).

fn mcp_input_schema(params: &Value) -> Value {
    let mut props = serde_json::Map::new();
    let mut required: Vec<String> = Vec::new();
    if let Some(obj) = params.as_object() {
        for (k, p) in obj {
            let desc = p["description"].as_str().unwrap_or("");
            let mut schema = match p["type"].as_str().unwrap_or("string") {
                "number" => json!({"type": "number"}),
                "boolean" => json!({"type": "boolean"}),
                "string[]" => json!({"type": "array", "items": {"type": "string"}}),
                "number[]" => json!({"type": "array", "items": {"type": "number"}}),
                "json" => json!({}),
                _ => json!({"type": "string"}),
            };
            if let Some(o) = schema.as_object_mut() {
                o.insert("description".into(), json!(desc));
                if let Some(e) = p.get("enum") {
                    if !e.is_null() {
                        o.insert("enum".into(), e.clone());
                    }
                }
            }
            props.insert(k.clone(), schema);
            if p["required"].as_bool().unwrap_or(false) {
                required.push(k.clone());
            }
        }
    }
    json!({"type": "object", "properties": props, "required": required})
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
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "soksak", "version": env!("CARGO_PKG_VERSION")},
                    }),
                );
            }
            ("ping", Some(id)) => mcp_reply(&id, json!({})),
            ("tools/list", Some(id)) => match fetch_commands() {
                Err(e) => mcp_error(&id, -32000, &e),
                Ok(cmds) => {
                    let tools: Vec<Value> = cmds
                        .iter()
                        .map(|c| {
                            let name = c["name"].as_str().unwrap_or("").replace('.', "_");
                            json!({
                                "name": name,
                                "description": c["description"].as_str().unwrap_or(""),
                                "inputSchema": mcp_input_schema(&c["params"]),
                            })
                        })
                        .collect();
                    mcp_reply(&id, json!({"tools": tools}));
                }
            },
            ("tools/call", Some(id)) => {
                let name = msg["params"]["name"].as_str().unwrap_or("");
                let method = name.replace('_', ".");
                let args = msg["params"]["arguments"].clone();
                match request(&method, args) {
                    Err(e) => mcp_error(&id, -32000, &e),
                    Ok(v) => {
                        let ok = v.get("ok").and_then(Value::as_bool).unwrap_or(false);
                        let text =
                            serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string());
                        mcp_reply(
                            &id,
                            json!({
                                "content": [{"type": "text", "text": text}],
                                "isError": !ok,
                            }),
                        );
                    }
                }
            }
            (_, None) => {} // notification(initialized 등) — 무응답
            (_, Some(id)) => mcp_error(&id, -32601, &format!("지원하지 않는 메서드: {method}")),
        }
    }
    ExitCode::SUCCESS
}

// ── 스킬 설치(Claude/Gemini/Codex) ───────────────────────────────────────────

const SKILL_BODY: &str = r#"soksak is a terminal app with a 3-level layout: projects (t*) → contents (c*, tabs of
split grids) → panels (g*, split groups) holding views (v*: terminal / file editor /
browser; terminals contain panes p*). Every feature is exposed as a `sok` CLI command.

## Address model (targeting)

- `sok state.tree` returns every id plus each panel's on-screen rect (%) — the address book.
- Inside a soksak terminal, `$SOKSAK_PANE` marks your pane. Omit target ids and commands
  default to your own location. `sok state.context` shows where you are.
- Pass explicit ids to act anywhere: `sok panel.split '{"group":"g3","side":"right"}'`.

## Workflow — always verify

1. `sok state.tree` to discover targets.
2. Run the command. Mutations return resulting ids/state, e.g. panel.split →
   `{"ok":true,"groupId":"g4","viewId":"v5","paneId":"p6"}`.
3. Verify from the response; cross-check with `sok state.tree` or `sok term.read`.
4. Errors are structured: `{"ok":false,"code":"TARGET_NOT_FOUND|LAST_ITEM|INVALID_PARAMS|TIMEOUT","message":...}`.

## Command domains (full schemas: `sok commands`, one command: `sok help <cmd>`)

- state: tree, context, commands
- project: list, create, close, activate, rename, sidebar.toggle
- content: list, create, close, activate, rename (tabs of split grids; `+` menu equivalent)
- panel: list, split, merge, move, close, focus, resize (split-window management)
- view: list, open, close, activate, move (tabs inside a panel: terminal/claude/codex/browser)
- pane: list, split, close, focus (splits inside one terminal view)
- term: read, send, exec, cwd (terminal I/O — your eyes and hands)
- browser: open, navigate, back, forward, reload, eval (returns JSON result)
- browser.dom: text, html, query, click, fill, submit, waitFor (DOM control, all return results)
- bookmark: list, add, remove / editor: open, save, close / settings: get, set / theme.set

## Recipes

- Split right and run claude: `sok panel.split '{"side":"right","program":"claude"}'`
- Run a command and read output: `sok term.exec '{"cmd":"git status"}'` then
  `sok term.read '{"lines":40}'`
- Drive a TUI: `sok term.send '{"text":"\u001b[B"}'` (arrow down), `'{"text":"\r"}'` (enter),
  `'{"text":"\u0003"}'` (ctrl-c)
- Browser automation: `sok browser.open '{"url":"https://example.com"}'` →
  `sok browser.dom.fill '{"selector":"input[name=q]","text":"hello"}'` →
  `sok browser.dom.click '{"selector":"button[type=submit]"}'` →
  `sok browser.dom.waitFor '{"selector":".results"}'` → `sok browser.dom.text`

## Cautions

- close commands are destructive: panel.close removes every tab in the panel; the last
  project/content/view/pane is protected (LAST_ITEM error).
- term.send writes raw bytes to the PTY; term.exec appends Enter.
- browser.eval runs arbitrary JS in the page; `return` a JSON-serializable value.
"#;

const MARKER_START: &str = "<!-- soksak-control:start -->";
const MARKER_END: &str = "<!-- soksak-control:end -->";

fn skill_md() -> String {
    format!(
        "---\nname: soksak-control\ndescription: Control the soksak terminal app via the `sok` CLI — split/merge/close panels, open terminals/browsers, run and read terminal commands, drive TUIs, and automate the embedded browser DOM. Use whenever asked to manipulate the soksak window layout or automate anything inside soksak.\n---\n\n# Controlling soksak with `sok`\n\n{SKILL_BODY}"
    )
}

fn marker_section() -> String {
    format!("{MARKER_START}\n## Controlling soksak with `sok`\n\n{SKILL_BODY}{MARKER_END}\n")
}

// 마커 블록을 추가/교체(멱등). 파일이 없으면 생성.
fn upsert_marker(path: &Path) -> Result<(), String> {
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    let section = marker_section();
    let next = match (existing.find(MARKER_START), existing.find(MARKER_END)) {
        (Some(s), Some(e)) if e > s => {
            let after = e + MARKER_END.len();
            // 기존 블록만 교체(마커 뒤 개행 하나까지 흡수).
            let tail = existing[after..].strip_prefix('\n').unwrap_or(&existing[after..]);
            format!("{}{}{}", &existing[..s], section, tail)
        }
        _ => {
            if existing.is_empty() {
                section
            } else {
                format!("{}\n{}", existing.trim_end(), section)
            }
        }
    };
    std::fs::write(path, next).map_err(|e| format!("{} 쓰기 실패: {e}", path.display()))
}

fn run_skill(args: &[String]) -> ExitCode {
    if args.first().map(String::as_str) != Some("install") {
        eprintln!("사용: sok skill install [--claude|--gemini|--codex|--all] [--dir DIR]");
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

    let mut failed = false;
    if claude {
        let p = dir.join(".claude/skills/soksak-control/SKILL.md");
        let r = std::fs::create_dir_all(p.parent().unwrap())
            .map_err(|e| e.to_string())
            .and_then(|_| std::fs::write(&p, skill_md()).map_err(|e| e.to_string()));
        match r {
            Ok(_) => println!("claude  ✓ {}", p.display()),
            Err(e) => {
                eprintln!("claude  ✗ {e}");
                failed = true;
            }
        }
    }
    if gemini {
        let p = dir.join("GEMINI.md");
        match upsert_marker(&p) {
            Ok(_) => println!("gemini  ✓ {}", p.display()),
            Err(e) => {
                eprintln!("gemini  ✗ {e}");
                failed = true;
            }
        }
    }
    if codex {
        let p = dir.join("AGENTS.md");
        match upsert_marker(&p) {
            Ok(_) => println!("codex   ✓ {}", p.display()),
            Err(e) => {
                eprintln!("codex   ✗ {e}");
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
