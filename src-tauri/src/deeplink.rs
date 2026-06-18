// 딥링크 command URI 라우팅 — soksak://run?cmd=<명령>&p=<JSON> 을 registry 명령 실행으로 푼다.
// 알림 클릭·외부 진입(open soksak://...)이 한 명령을 실행하는 단일 경로다. 실행은 CmdBridge
// (ipc::request_command)로 프론트 registry 에 위임한다 — Rust 는 파싱·라우팅만(R8 단일 실행 경로).
//
// 파싱은 순수(url crate)라 테스트 가능하다. OS 스킴 등록(tauri.conf deep-link)·on_open_url 배선은
// lib.rs(부수효과). 클릭→명령은 이 URI 가 외부에서 열릴 때 동작한다(데스크톱 알림 자체의 per-click
// 액션은 플랫폼 미지원 — 딥링크가 그 자리를 메운다).

use serde_json::Value;
use url::Url;

/// soksak://run?cmd=NAME&p=JSON → (명령 이름, params 오브젝트). 스킴≠soksak·호스트≠run·cmd 없음/빈값이면
/// None. p 는 URL-인코딩된 JSON 오브젝트(생략·비오브젝트면 빈 오브젝트). 미지 query 키는 무시.
pub fn parse_command_url(raw: &str) -> Option<(String, Value)> {
    let u = Url::parse(raw).ok()?;
    if u.scheme() != "soksak" || u.host_str() != Some("run") {
        return None;
    }
    let mut cmd: Option<String> = None;
    let mut params = Value::Object(serde_json::Map::new());
    for (k, v) in u.query_pairs() {
        match k.as_ref() {
            "cmd" => cmd = Some(v.to_string()),
            "p" => {
                if let Ok(parsed) = serde_json::from_str::<Value>(&v) {
                    if parsed.is_object() {
                        params = parsed;
                    }
                }
            }
            _ => {}
        }
    }
    let cmd = cmd?;
    if cmd.is_empty() {
        return None;
    }
    Some((cmd, params))
}

#[cfg(test)]
mod tests {
    use super::*;

    // (a) cmd + URL-인코딩 JSON params 파싱.
    #[test]
    fn parses_cmd_and_params() {
        // p = {"a":1,"b":"x"} URL-인코딩.
        let url = "soksak://run?cmd=plugin.x.foo&p=%7B%22a%22%3A1%2C%22b%22%3A%22x%22%7D";
        let (cmd, params) = parse_command_url(url).unwrap();
        assert_eq!(cmd, "plugin.x.foo");
        assert_eq!(params["a"], 1);
        assert_eq!(params["b"], "x");
    }

    // (b) params 없는 명령 → 빈 오브젝트.
    #[test]
    fn cmd_without_params() {
        let (cmd, params) = parse_command_url("soksak://run?cmd=state.context").unwrap();
        assert_eq!(cmd, "state.context");
        assert!(params.as_object().unwrap().is_empty());
    }

    // (c) 스킴/호스트 불일치 거부.
    #[test]
    fn wrong_scheme_or_host_rejected() {
        assert!(parse_command_url("https://run?cmd=x").is_none());
        assert!(parse_command_url("soksak://other?cmd=x").is_none());
        assert!(parse_command_url("not a url").is_none());
    }

    // (d) cmd 없음/빈값 거부(미치환 명령 실행 0).
    #[test]
    fn missing_or_empty_cmd_rejected() {
        assert!(parse_command_url("soksak://run?p=%7B%7D").is_none());
        assert!(parse_command_url("soksak://run?cmd=").is_none());
    }
}
