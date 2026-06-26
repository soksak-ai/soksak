// AI 세션 계보(단계⑤) — 터미널에서 실행된 claude/codex 의 세션 파일을 식별·파싱해 (viewId, sessionId,
// kind) 를 잇는다. 우리는 AI agent 특화 터미널이라, 돌던 세션을 복원 후 '이어가기' 할 수 있어야 한다(R9).
//
// 세션 파일 포맷(실측):
//   claude: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl — 줄마다 "sessionId", "cwd" 는 있는 줄에.
//   codex:  ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl — 첫 줄 type="session_meta"
//           의 payload.{id, cwd}.
//
// 이 모듈은 순수 파싱만(파일 IO·watch 는 watcher.rs 가 offset tail 로 호출). doc 문자열 조립 금지 —
// sessionId 는 화이트리스트 포맷(UUID)만 통과시켜 위조 history→공격자 resume 을 차단한다(R9, blocker high).

use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
}

impl AgentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentKind::Claude => "claude",
            AgentKind::Codex => "codex",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionInfo {
    pub kind: AgentKind,
    pub session_id: String,
    pub cwd: String,
}

// sessionId 화이트리스트 — UUID 포맷(36자, 하이픈 8-13-18-23, 나머지 hex). v4/v7 모두 충족.
// 임의 문자열을 sessionId 로 받아 doc 에 조립하면 위조 history 로 공격자 resume 이 가능해진다(R9) →
// 엄격 포맷만 통과. 이 검사를 통과 못 한 값은 추적·resume 양쪽에서 거부한다.
pub fn is_valid_session_id(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    for (i, c) in b.iter().enumerate() {
        match i {
            8 | 13 | 18 | 23 => {
                if *c != b'-' {
                    return false;
                }
            }
            _ => {
                if !c.is_ascii_hexdigit() {
                    return false;
                }
            }
        }
    }
    true
}

// 터미널 명령이 추적 대상 에이전트인가 — commandLine 첫 토큰의 basename 이 claude/codex.
// 경로 실행("/usr/local/bin/claude")·인자 동반("codex --model …")도 잡는다. 그 외는 None.
pub fn detect_agent(command_line: &str) -> Option<AgentKind> {
    let first = command_line.split_whitespace().next()?;
    let bin = first.rsplit('/').next().unwrap_or(first);
    match bin {
        "claude" => Some(AgentKind::Claude),
        "codex" => Some(AgentKind::Codex),
        _ => None,
    }
}

// claude 세션 jsonl 내용 → SessionInfo. sessionId(유효 포맷)와 cwd 를 각각 처음 나오는 줄에서 취한다.
// 깨진 줄(tail 중간 truncation 등)은 건너뛴다. 둘 다 못 찾으면 None.
pub fn parse_claude(content: &str) -> Option<SessionInfo> {
    let mut session_id: Option<String> = None;
    let mut cwd: Option<String> = None;
    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if session_id.is_none() {
            if let Some(s) = v.get("sessionId").and_then(|x| x.as_str()) {
                if is_valid_session_id(s) {
                    session_id = Some(s.to_string());
                }
            }
        }
        if cwd.is_none() {
            if let Some(c) = v.get("cwd").and_then(|x| x.as_str()) {
                if !c.is_empty() {
                    cwd = Some(c.to_string());
                }
            }
        }
        if session_id.is_some() && cwd.is_some() {
            break;
        }
    }
    Some(SessionInfo { kind: AgentKind::Claude, session_id: session_id?, cwd: cwd? })
}

// codex 세션 jsonl 내용 → SessionInfo. 첫 type="session_meta" 줄의 payload.{id, cwd}.
pub fn parse_codex(content: &str) -> Option<SessionInfo> {
    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|x| x.as_str()) != Some("session_meta") {
            continue;
        }
        let p = v.get("payload")?;
        let id = p.get("id").and_then(|x| x.as_str()).filter(|s| is_valid_session_id(s))?;
        let cwd = p.get("cwd").and_then(|x| x.as_str()).filter(|c| !c.is_empty())?;
        return Some(SessionInfo { kind: AgentKind::Codex, session_id: id.to_string(), cwd: cwd.to_string() });
    }
    None
}

// kind 에 맞는 파서 디스패치(watcher.rs 가 파일 경로의 디렉토리로 kind 판정 후 호출).
pub fn parse(kind: AgentKind, content: &str) -> Option<SessionInfo> {
    match kind {
        AgentKind::Claude => parse_claude(content),
        AgentKind::Codex => parse_codex(content),
    }
}

// claude 세션 디렉토리 — cwd 의 각 '/'·'.' 를 '-' 로 치환(실측: /Users/max/ai/cli/vsterm-tauri →
// -Users-max-ai-cli-vsterm-tauri, /Users/x/soksak/.cache → -Users-x-soksak--cache, / → -). 이 디렉토리
// 아래 <sessionId>.jsonl 이 생긴다. 터미널이 이 cwd 에서 claude 를 돌리면 여기 새 파일이 나타난다.
pub fn claude_session_dir(home: &str, cwd: &str) -> PathBuf {
    let enc: String = cwd.chars().map(|c| if c == '/' || c == '.' { '-' } else { c }).collect();
    Path::new(home).join(".claude").join("projects").join(enc)
}

// ── 세션 전이 추적(R8 watch — claude 가 분기를 파일에 안 남기므로 우리가 관찰) ──────────
// claude 는 /clear·/resume 분기를 파일 간 링크로 안 남긴다(실측: 49세션 분기링크 0). compact 만 같은
// 파일 compactMetadata. 그래서 viewId 가 claude 실행 중 그 cwd 세션 디렉토리를 watch 하고, 디렉토리
// 스냅샷(sessionId→mtime) 변화로 '지금 쓰이는 세션' 을 잡아 (prev→new) 전이를 우리가 구성한다.

// 세션 디렉토리 스냅샷 — 디렉토리의 <sessionId>.jsonl 들을 sessionId→mtime(ms) 로. watch 콜백이 매
// fs-change 마다 다시 찍어 직전 스냅샷과 비교한다.
pub fn snapshot_dir(dir: &Path) -> std::collections::BTreeMap<String, i64> {
    let mut snap = std::collections::BTreeMap::new();
    let Ok(rd) = std::fs::read_dir(dir) else {
        return snap;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !is_valid_session_id(stem) {
            continue; // 파일명이 UUID(sessionId)인 것만 — 위조/잡파일 배제(R9)
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        snap.insert(stem.to_string(), mtime);
    }
    snap
}

// prev→cur 스냅샷에서 '지금 쓰이는 세션' = 새로 생기거나 mtime 이 증가한 것 중 가장 최근(claude 가 방금
// 쓴 세션). 변화 없으면 None. 이게 viewId 의 현재 세션이고, 직전 현재 세션과 다르면 전이다.
pub fn active_session(
    prev: &std::collections::BTreeMap<String, i64>,
    cur: &std::collections::BTreeMap<String, i64>,
) -> Option<String> {
    let mut best: Option<(i64, String)> = None;
    for (sid, &m) in cur {
        let changed = prev.get(sid).is_none_or(|&pm| m > pm);
        if changed && best.as_ref().is_none_or(|(bm, _)| m > *bm) {
            best = Some((m, sid.clone()));
        }
    }
    best.map(|(_, s)| s)
}

// 디렉토리에서 가장 최근(mtime) .jsonl 경로. 없으면 None.
fn newest_jsonl(dir: &Path) -> Option<PathBuf> {
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(m) = entry.metadata().and_then(|md| md.modified()) else {
            continue;
        };
        if newest.as_ref().is_none_or(|(t, _)| m > *t) {
            newest = Some((m, path));
        }
    }
    newest.map(|(_, p)| p)
}

// ── 전이 추적 상태(watch 구동 — 폴링 아님, notify fs-change 이벤트가 호출) ─────────────
// dir(세션 디렉토리)별 직전 스냅샷을 들고, 프론트가 fs-change 이벤트를 받을 때마다 active(dir) 를 호출하면
// 직전과 비교해 '방금 쓰인 세션' 을 돌려준다. 주기 조회 0 — OS 가 파일 변경을 알릴 때만 깬다.
#[derive(Default)]
pub struct SessionTracker {
    snaps: Mutex<HashMap<String, BTreeMap<String, i64>>>,
}

impl SessionTracker {
    // dir 의 현재 활성 세션(직전 스냅샷 대비 새/갱신 중 최신) + 내부 스냅샷 갱신. 변화 없으면 None.
    pub fn active(&self, dir: &str) -> Option<String> {
        let cur = snapshot_dir(Path::new(dir));
        let mut g = self.snaps.lock().ok()?;
        let prev = g.get(dir).cloned().unwrap_or_default();
        let active = active_session(&prev, &cur);
        g.insert(dir.to_string(), cur);
        active
    }

    // watch 종료 시 dir 스냅샷 폐기(누수 방지).
    pub fn forget(&self, dir: &str) {
        if let Ok(mut g) = self.snaps.lock() {
            g.remove(dir);
        }
    }
}

// ── 점검 커맨드(R0) ──────────────────────────────────────────────────────────

// cwd → claude 세션 디렉토리 경로(프론트가 watch_dir 대상으로 쓴다). 인코딩 단일진실(claude_session_dir).
#[tauri::command]
pub fn ai_session_dir(cwd: String) -> Result<String, String> {
    if cwd.is_empty() {
        return Err("cwd 필요".to_string());
    }
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    Ok(claude_session_dir(&home, &cwd).to_string_lossy().into_owned())
}

// fs-change 이벤트 시 호출 — dir 에서 방금 쓰인 세션(직전 대비 새/갱신). 프론트가 직전 활성과 비교해
// 전이를 기록한다. 폴링 아님(notify 이벤트가 구동). 변화 없으면 null.
#[tauri::command]
pub fn ai_session_active(dir: String, tracker: State<'_, SessionTracker>) -> Option<String> {
    tracker.active(&dir)
}

// watch 종료 — dir 스냅샷 폐기.
#[tauri::command]
pub fn ai_session_untrack(dir: String, tracker: State<'_, SessionTracker>) {
    tracker.forget(&dir);
}

// 세션 계보 조회 — cwd(scope)의 전이 레코드를 시간순(created)으로. 각 레코드 = {viewId, fromSession,
// toSession, kind, time}. 시간순 from→to 가 곧 흐름이고, 같은 fromSession 에서 여러 toSession 이면 분기다.
// 저장은 sessionLineage(watch)가, 조회는 app.data 단일 경로(store::query)로 — 단일진실.
#[tauri::command]
pub fn ai_session_lineage(
    cwd: String,
    view_id: Option<String>,
    state: State<'_, crate::data::DbState>,
) -> Result<Vec<Value>, String> {
    if cwd.is_empty() {
        return Err("cwd 필요".to_string());
    }
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB 미초기화")?;
    let where_obj = view_id.filter(|v| !v.is_empty()).map(|v| serde_json::json!({ "viewId": v }));
    crate::data::store::query(
        conn,
        "core",
        "ai_session_lineage",
        Some(&cwd),
        where_obj.as_ref(),
        Some("created"),
        false,
        Some(1000),
        None,
        None, // lineage 는 평문(전이 메타) — 복호 resolver 불요
    )
}

// ── 식별 커맨드(R0) ──────────────────────────────────────────────────────────

// cwd 로 claude 세션을 on-demand 조회 — 그 cwd 의 세션 디렉토리에서 가장 최근 세션 파일을 식별한다.
// 프론트가 에이전트 명령 turn.ended 시 1회 호출해 블록에 sessionId 를 채운다(상시 watch 대신 on-demand
// = 부하 최소, 폴링 없음). codex 는 date-dir 라 cwd 로 못 좁혀 후속(전체 스캔). 못 찾으면 None.
#[tauri::command]
pub fn ai_session_find(cwd: String) -> Result<Option<SessionInfo>, String> {
    if cwd.is_empty() {
        return Ok(None);
    }
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = claude_session_dir(&home, &cwd);
    if !dir.is_dir() {
        return Ok(None);
    }
    let Some(path) = newest_jsonl(&dir) else {
        return Ok(None);
    };
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let head: String = content.chars().take(65536).collect(); // 헤더만(전체 재파싱 금지, R8)
    Ok(parse(AgentKind::Claude, &head))
}

// 터미널 명령이 추적 대상 에이전트인가 — "claude"/"codex"/null. 프론트가 command.started 의
// commandLine 으로 호출해 블록의 agentKind 를 채운다(sessionId 는 watch 통합 후속).
#[tauri::command]
pub fn ai_session_detect(command_line: String) -> Option<String> {
    detect_agent(&command_line).map(|k| k.as_str().to_string())
}

// 세션 파일 식별 — 경로(claude/codex 세션만 허용)의 헤더를 읽어 SessionInfo. 임의 파일 읽기는 거부
// (세션 디렉토리 경로 외 차단). 헤더(sessionId/cwd)는 파일 앞에 있어 앞부분만 읽는다(전체 재파싱 금지, R8).
#[tauri::command]
pub fn ai_session_inspect(path: String) -> Result<Option<SessionInfo>, String> {
    let is_codex = path.contains("/.codex/sessions/");
    let is_claude = path.contains("/.claude/projects/");
    if !is_codex && !is_claude {
        return Err("claude/codex 세션 경로가 아님 — 임의 파일 읽기 거부".to_string());
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let head: String = content.chars().take(65536).collect(); // 헤더만(전체 재파싱 금지)
    let kind = if is_codex { AgentKind::Codex } else { AgentKind::Claude };
    Ok(parse(kind, &head))
}

#[cfg(test)]
mod tests {
    use super::*;

    // sessionId 화이트리스트 — 실측 UUID 통과, 위조/잘못된 포맷 거부.
    #[test]
    fn session_id_whitelist() {
        assert!(is_valid_session_id("accd937f-5c22-48c6-b83d-70a2e0f2e4aa")); // claude v4
        assert!(is_valid_session_id("019d09a1-6bc4-7691-9458-088bde7fca3d")); // codex v7
        assert!(!is_valid_session_id("not-a-uuid"));
        assert!(!is_valid_session_id("'; DROP TABLE records;--"));
        assert!(!is_valid_session_id("accd937f5c2248c68b3d70a2e0f2e4aa")); // 하이픈 없음
        assert!(!is_valid_session_id("accd937f-5c22-48c6-b83d-70a2e0f2e4a")); // 35자
        assert!(!is_valid_session_id("zzzz937f-5c22-48c6-b83d-70a2e0f2e4aa")); // 비-hex
        assert!(!is_valid_session_id(""));
    }

    // 에이전트 탐지 — 경로·인자 동반 명령에서 basename 으로 판정.
    #[test]
    fn agent_detection() {
        assert_eq!(detect_agent("claude"), Some(AgentKind::Claude));
        assert_eq!(detect_agent("claude --resume"), Some(AgentKind::Claude));
        assert_eq!(detect_agent("/usr/local/bin/codex --model gpt"), Some(AgentKind::Codex));
        assert_eq!(detect_agent("codex"), Some(AgentKind::Codex));
        assert_eq!(detect_agent("vim file.txt"), None);
        assert_eq!(detect_agent("npm run claude"), None); // 첫 토큰만(npm) — false positive 방지
        assert_eq!(detect_agent(""), None);
    }

    // claude 파싱 — 실측 포맷(첫 줄 cwd 없음, 다른 줄에 cwd). sessionId/cwd 각각 첫 등장 줄에서.
    #[test]
    fn parse_claude_real_shape() {
        let content = r#"{"leafUuid":"x","sessionId":"accd937f-5c22-48c6-b83d-70a2e0f2e4aa","type":"summary"}
{"type":"attachment","cwd":"/Users/max/ai/cli/vsterm-tauri","sessionId":"accd937f-5c22-48c6-b83d-70a2e0f2e4aa"}"#;
        let info = parse_claude(content).unwrap();
        assert_eq!(info.kind, AgentKind::Claude);
        assert_eq!(info.session_id, "accd937f-5c22-48c6-b83d-70a2e0f2e4aa");
        assert_eq!(info.cwd, "/Users/max/ai/cli/vsterm-tauri");
    }

    // codex 파싱 — session_meta 줄의 payload.{id, cwd}. 이후 response_item 줄은 무시.
    #[test]
    fn parse_codex_real_shape() {
        let content = r#"{"payload":{"id":"019d09a1-6bc4-7691-9458-088bde7fca3d","cwd":"/Users/max/proj","cli_version":"x"},"timestamp":"t","type":"session_meta"}
{"payload":{"content":[],"role":"user","type":"message"},"timestamp":"t","type":"response_item"}"#;
        let info = parse_codex(content).unwrap();
        assert_eq!(info.kind, AgentKind::Codex);
        assert_eq!(info.session_id, "019d09a1-6bc4-7691-9458-088bde7fca3d");
        assert_eq!(info.cwd, "/Users/max/proj");
    }

    // 세션 전이 감지 — 두 스냅샷 비교로 '지금 쓰이는 세션'(새/갱신 중 최신). 전이 시퀀스의 코어.
    #[test]
    fn active_session_transition() {
        use std::collections::BTreeMap;
        let a = "accd937f-5c22-48c6-b83d-70a2e0f2e4aa".to_string();
        let b = "019d09a1-6bc4-7691-9458-088bde7fca3d".to_string();
        // 시작: A 만 존재 → A 활성.
        let s0: BTreeMap<String, i64> = BTreeMap::new();
        let s1 = BTreeMap::from([(a.clone(), 1000)]);
        assert_eq!(active_session(&s0, &s1), Some(a.clone()), "새 세션 A 등장 → 활성");
        // 변화 없음 → None(전이 아님).
        assert_eq!(active_session(&s1, &s1), None, "변화 없으면 전이 아님");
        // /clear: 새 파일 B 생성(A 그대로) → B 활성 = A→B 전이.
        let s2 = BTreeMap::from([(a.clone(), 1000), (b.clone(), 2000)]);
        assert_eq!(active_session(&s1, &s2), Some(b.clone()), "새 세션 B → 전이");
        // /resume A: 기존 A 파일 갱신(mtime↑) → A 활성 = B→A 전이.
        let s3 = BTreeMap::from([(a.clone(), 3000), (b.clone(), 2000)]);
        assert_eq!(active_session(&s2, &s3), Some(a.clone()), "기존 A 갱신 → 재활성 전이");
    }

    // 스냅샷 — sessionId(UUID) 파일명만, 위조/잡파일 배제.
    #[test]
    fn snapshot_filters_non_session() {
        let dir = std::env::temp_dir().join(format!("soksak-aisess-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("accd937f-5c22-48c6-b83d-70a2e0f2e4aa.jsonl"), "{}").unwrap();
        std::fs::write(dir.join("not-a-session.jsonl"), "{}").unwrap(); // UUID 아님 → 배제
        std::fs::write(dir.join("readme.txt"), "x").unwrap(); // .jsonl 아님 → 배제
        let snap = snapshot_dir(&dir);
        assert_eq!(snap.len(), 1, "sessionId UUID .jsonl 만");
        assert!(snap.contains_key("accd937f-5c22-48c6-b83d-70a2e0f2e4aa"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // claude 세션 디렉토리 인코딩 — 실측 규칙('/'·'.' → '-'). watch/find 대상 경로.
    #[test]
    fn claude_dir_encoding() {
        assert_eq!(
            claude_session_dir("/home/u", "/Users/max/ai/cli/vsterm-tauri"),
            Path::new("/home/u/.claude/projects/-Users-max-ai-cli-vsterm-tauri")
        );
        // '/.' → '--' (실측: soksak/.cache → soksak--cache).
        assert_eq!(
            claude_session_dir("/h", "/Users/max/soksak/.cache"),
            Path::new("/h/.claude/projects/-Users-max-soksak--cache")
        );
        // 루트 cwd → "-".
        assert_eq!(claude_session_dir("/h", "/"), Path::new("/h/.claude/projects/-"));
    }

    // 깨진 줄(truncated tail)·위조 sessionId 는 건너뛰고 유효 줄에서 sessionId+cwd 를 취한다.
    #[test]
    fn skips_broken_and_forged() {
        // 1줄 깨진 JSON(skip), 2줄 위조 sessionId(거부) + cwd 없음, 3줄 유효.
        let content = "broken {not json\n{\"sessionId\":\"forged-not-uuid\",\"type\":\"x\"}\n{\"sessionId\":\"accd937f-5c22-48c6-b83d-70a2e0f2e4aa\",\"cwd\":\"/real\",\"type\":\"attachment\"}";
        let info = parse_claude(content).unwrap();
        assert_eq!(info.session_id, "accd937f-5c22-48c6-b83d-70a2e0f2e4aa");
        assert_eq!(info.cwd, "/real");
        // 유효 sessionId 가 한 줄도 없으면 None(위조만 있는 파일).
        assert!(parse_claude("{\"sessionId\":\"forged\",\"cwd\":\"/x\"}").is_none());
        // session_meta 없는 codex 내용 → None.
        assert!(parse_codex("{\"type\":\"response_item\",\"payload\":{}}").is_none());
    }
}
