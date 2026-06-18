// 범용 HTTP 요청 capability — runbook api 실행타입의 코어 실행기. method/url/headers/query/body 를
// 받아 {status, headers, body} 를 돌려준다. webview JS 는 임의 출처로 raw HTTP 를 못 보내(CORS/보안)
// 코어가 제공하는 범용 기능이다(특정 API 락인 0). command registry 의 net.http.request + ns 격리
// 표면 app.network.http 가 이 실행기를 부른다.
//
// 시크릿은 Rust 경계에서만 치환한다(평문 JS·history·lastResponse 무노출 R2): secret_subst{placeholder→
// secretKey} 를 ns 볼트에서 해소해 url/headers/body 의 placeholder 를 실값으로 바꾼 뒤 전송한다. 잠김/
// 미존재면 전송 전에 Err(미해소 시크릿이 요청으로 안 나간다). reqwest blocking(자체 런타임) + rustls.

use crate::secrets::{self, SecretsState};
use std::collections::HashMap;
use tauri::State;

#[derive(serde::Serialize, Debug)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

// placeholder→실값 치환 — url/header/body 단일 규칙(모든 출현). placeholder 는 NUL 래핑 마커라
// 사용자 텍스트와 충돌 0.
fn substitute(text: &str, subst: &HashMap<String, String>) -> String {
    let mut out = text.to_string();
    for (ph, val) in subst {
        out = out.replace(ph, val);
    }
    out
}

// secret_subst(placeholder→secretKey)를 ns 볼트에서 placeholder→평문 으로 해소. 비면 빈 맵.
// 비어있지 않으면 ns 필수. 하나라도 잠김/미존재면 Err(미해소 시크릿이 요청으로 안 나간다).
fn resolve_secret_subst(
    secrets_state: &SecretsState,
    ns: Option<&str>,
    secret_subst: &Option<HashMap<String, String>>,
) -> Result<HashMap<String, String>, String> {
    match secret_subst {
        Some(map) if !map.is_empty() => {
            let ns = ns.ok_or("secret_subst 주입에는 ns 필수")?;
            let mut out = HashMap::new();
            for (ph, key) in map {
                out.insert(ph.clone(), secrets::resolve(secrets_state, ns, key)?);
            }
            Ok(out)
        }
        _ => Ok(HashMap::new()),
    }
}

// 실제 HTTP 전송(reqwest blocking). 치환 완료된 순수 입력 → 응답. State 비의존(테스트 직접 호출).
fn send_http(
    method: &str,
    url: &str,
    headers: &HashMap<String, String>,
    query: &HashMap<String, String>,
    body: Option<&str>,
    content_type: Option<&str>,
) -> Result<HttpResponse, String> {
    let m = reqwest::Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|e| format!("HTTP method 불량: {e}"))?;
    let client = reqwest::blocking::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.request(m, url);
    if !query.is_empty() {
        let q: Vec<(&String, &String)> = query.iter().collect();
        req = req.query(&q);
    }
    for (k, v) in headers {
        req = req.header(k, v);
    }
    if let Some(ct) = content_type {
        req = req.header("content-type", ct);
    }
    if let Some(b) = body {
        req = req.body(b.to_string());
    }
    let resp = req.send().map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let mut hmap = HashMap::new();
    for (k, v) in resp.headers() {
        hmap.insert(k.as_str().to_string(), v.to_str().unwrap_or("").to_string());
    }
    let body = resp.text().map_err(|e| e.to_string())?;
    Ok(HttpResponse {
        status,
        headers: hmap,
        body,
    })
}

// 시크릿은 ns 볼트에서만 해소한다 — ns 는 app.network.http 가 manifest.id 로 주입(타 ns 시크릿
// 탈취 차단 R2/R6). CLI/E2E 는 명시 ns(운영자 신뢰).
#[tauri::command]
pub fn network_http_request(
    method: String,
    url: String,
    headers: Option<HashMap<String, String>>,
    query: Option<HashMap<String, String>>,
    body: Option<String>,
    content_type: Option<String>,
    ns: Option<String>,
    secret_subst: Option<HashMap<String, String>>,
    secrets_state: State<'_, SecretsState>,
) -> Result<HttpResponse, String> {
    let subst = resolve_secret_subst(&secrets_state, ns.as_deref(), &secret_subst)?;
    let url = substitute(&url, &subst);
    let headers: HashMap<String, String> = headers
        .unwrap_or_default()
        .into_iter()
        .map(|(k, v)| (k, substitute(&v, &subst)))
        .collect();
    let query: HashMap<String, String> = query
        .unwrap_or_default()
        .into_iter()
        .map(|(k, v)| (k, substitute(&v, &subst)))
        .collect();
    let body = body.map(|b| substitute(&b, &subst));
    send_http(
        &method,
        &url,
        &headers,
        &query,
        body.as_deref(),
        content_type.as_deref(),
    )
}

// ── 테스트(로컬 HTTP 서버 — 외부망 비의존, R10) ─────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::time::Duration;

    // 1회 요청을 받는 최소 HTTP 서버 — 받은 raw 요청을 채널로 돌려주고 고정 응답을 쓴다.
    fn spawn_once_server(response: &'static str) -> (u16, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let _ = tx.send(req);
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        (port, rx)
    }

    const OK_RESP: &str =
        "HTTP/1.1 200 OK\r\nContent-Length: 13\r\nContent-Type: application/json\r\n\r\n{\"v\":\"hello\"}";

    // (a) GET — 상태/바디 캡처 + 서버가 method/path 수신.
    #[test]
    fn get_captures_status_and_body() {
        let (port, rx) = spawn_once_server(OK_RESP);
        let url = format!("http://127.0.0.1:{port}/path");
        let resp = send_http("GET", &url, &HashMap::new(), &HashMap::new(), None, None).unwrap();
        assert_eq!(resp.status, 200);
        assert!(resp.body.contains("hello"));
        let received = rx.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(received.starts_with("GET /path"));
    }

    // (b) POST — 헤더·바디·content-type 전송.
    #[test]
    fn post_sends_header_body_contenttype() {
        let (port, rx) = spawn_once_server(OK_RESP);
        let url = format!("http://127.0.0.1:{port}/x");
        let mut headers = HashMap::new();
        headers.insert("x-test".to_string(), "abc".to_string());
        let resp = send_http(
            "POST",
            &url,
            &headers,
            &HashMap::new(),
            Some("payload-123"),
            Some("application/json"),
        )
        .unwrap();
        assert_eq!(resp.status, 200);
        let received = rx.recv_timeout(Duration::from_secs(3)).unwrap().to_lowercase();
        assert!(received.starts_with("post /x"));
        assert!(received.contains("x-test: abc"));
        assert!(received.contains("payload-123"));
        assert!(received.contains("content-type: application/json"));
    }

    // (c) 시크릿 치환 — secret_subst{placeholder→key} 가 ns 볼트의 실값으로 바뀌어 헤더로 나간다
    //     (R2: placeholder 는 평문 아님, 실값은 Rust 경계에서만).
    #[test]
    fn secret_substituted_into_header_at_boundary() {
        let dir = std::env::temp_dir().join(format!(
            "soksak-http-secret-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let state = secrets::test_state_with_secret(
            dir.join("secrets.vault"),
            "pw",
            "plugin-a",
            "apiKey",
            "sk-secret-xyz",
        );

        let mut subst_map = HashMap::new();
        subst_map.insert("\0secret:apiKey\0".to_string(), "apiKey".to_string());
        let resolved =
            resolve_secret_subst(&state, Some("plugin-a"), &Some(subst_map)).unwrap();
        let header_val = substitute("Bearer \0secret:apiKey\0", &resolved);
        assert_eq!(header_val, "Bearer sk-secret-xyz", "placeholder→실값");

        let (port, rx) = spawn_once_server(OK_RESP);
        let url = format!("http://127.0.0.1:{port}/y");
        let mut headers = HashMap::new();
        headers.insert("authorization".to_string(), header_val);
        let resp = send_http("GET", &url, &headers, &HashMap::new(), None, None).unwrap();
        assert_eq!(resp.status, 200);
        let received = rx.recv_timeout(Duration::from_secs(3)).unwrap().to_lowercase();
        assert!(
            received.contains("authorization: bearer sk-secret-xyz"),
            "실값이 헤더로 전송됨(Rust 경계 주입)"
        );
    }

    // (d) 미가용 시크릿 → 전송 전 Err(미해소 시크릿 누출 0).
    #[test]
    fn missing_secret_rejected_before_send() {
        let state = SecretsState::default(); // 잠김.
        let mut subst_map = HashMap::new();
        subst_map.insert("\0secret:apiKey\0".to_string(), "apiKey".to_string());
        let r = resolve_secret_subst(&state, Some("plugin-a"), &Some(subst_map));
        assert!(r.is_err(), "잠김 볼트 → Err(전송 안 함)");
    }

    // (e) secret_subst 있는데 ns 없음 → Err.
    #[test]
    fn secret_subst_without_ns_rejected() {
        let state = SecretsState::default();
        let mut subst_map = HashMap::new();
        subst_map.insert("\0secret:k\0".to_string(), "k".to_string());
        assert!(resolve_secret_subst(&state, None, &Some(subst_map)).is_err());
    }
}
