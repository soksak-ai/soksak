// 범용 미디어 스트리밍 프록시 — 루프백 HTTP 서버(127.0.0.1, OS 할당 포트). webview 의 hls.js/<video>
// 는 forbidden header(Referer)를 못 박고 cross-origin CORS 에 막혀서 hotlink 보호 미디어(HLS m3u8 +
// 바이너리 .ts/fMP4 세그먼트, Range 가 걸린 mp4)를 직접 못 받는다. 이 프록시가 호출자가 준 헤더로
// 업스트림에서 바이트를 받아 CORS-안전(ACAO:*)하게 다시 내보낸다. 코어 network.http 가 문자열 body
// 전용이라 비어있던 바이너리/스트리밍/Range 자리를 메우는 범용 primitive다.
//
// 특정 사이트 지식 0(R3): url + referer/ua 만 받는다. 어떤 사이트를 프록시할지는 호출자(플러그인)가
// 정한다. command registry 의 media.proxy.* 가 표면. 순수 std TcpListener + wreq 스트리밍
// (신규 의존성 0 — http.rs 와 같은 blocking 스택). 경로 토큰으로 로컬 타 프로세스 접근을 막는다(127.0.0.1
// 바인드가 1차 방어, 토큰이 2차).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::OnceLock;
use std::time::Duration;

use rand::Rng;
use url::Url;
use wreq_util::Emulation;

static PROXY_PORT: OnceLock<u16> = OnceLock::new();
static PROXY_TOKEN: OnceLock<String> = OnceLock::new();

// 모든 응답 공통 CORS — hls.js xhr 가 cross-origin 프록시를 읽으려면 필수.
const CORS: &str = "Access-Control-Allow-Origin: *\r\n\
Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
Access-Control-Allow-Headers: range, content-type\r\n\
Access-Control-Expose-Headers: content-length, content-range, accept-ranges, content-type\r\n";

#[derive(serde::Serialize, Debug)]
pub struct MediaProxyInfo {
    pub base: String,
    pub port: u16,
    pub token: String,
}

// 기동된 프록시의 (포트, 토큰). 미기동이면 None.
pub fn info() -> Option<(u16, String)> {
    match (PROXY_PORT.get(), PROXY_TOKEN.get()) {
        (Some(p), Some(t)) => Some((*p, t.clone())),
        _ => None,
    }
}

// 플러그인은 이 base 로 프록시 URL 을 자체 조립한다: {base}/m3u8?url=&referer=&ua= / {base}/stream?...
#[tauri::command]
pub fn media_proxy_info() -> Result<MediaProxyInfo, String> {
    let (port, token) = info().ok_or("media proxy 미기동")?;
    Ok(MediaProxyInfo {
        base: format!("http://127.0.0.1:{port}/{token}"),
        port,
        token,
    })
}

fn gen_token() -> String {
    let mut r = rand::thread_rng();
    (0..32)
        .map(|_| char::from_digit(r.gen_range(0..16), 16).unwrap())
        .collect()
}

// 루프백 서버 기동(멱등). OS 할당 포트 + 세션 랜덤 토큰. 기동 실패는 호출측이 로깅(재생만 실패, 앱은 산다).
pub fn start() -> Result<(), String> {
    if PROXY_PORT.get().is_some() {
        return Ok(()); // 멱등.
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = gen_token();
    let _ = PROXY_PORT.set(port);
    let _ = PROXY_TOKEN.set(token.clone());
    std::thread::spawn(move || serve(listener, port, token));
    Ok(())
}

// 종료 시 정리할 파일/소켓 0 — 루프백 TCP 는 프로세스 종료 시 OS 가 회수. ipc::cleanup 과 대칭으로 둔다.
pub fn cleanup() {}

// accept 루프 — 연결마다 스레드(로컬 미디어 프록시는 동시 세그먼트 몇 개뿐, thread-per-conn 으로 충분).
fn serve(listener: TcpListener, port: u16, token: String) {
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let token = token.clone();
        std::thread::spawn(move || {
            let _ = handle_conn(stream, port, &token);
        });
    }
}

fn handle_conn(stream: TcpStream, port: u16, token: &str) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut writer = stream;

    // 요청 라인: "GET /{token}/{kind}?{query} HTTP/1.1".
    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(());
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("").to_string();

    // 헤더는 Range 만 관심(나머지는 흘린다). 빈 줄까지 읽어 요청을 비운다.
    let mut range: Option<String> = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        let t = line.trim_end();
        if t.is_empty() {
            break;
        }
        if let Some((k, v)) = t.split_once(':') {
            if k.trim().eq_ignore_ascii_case("range") {
                range = Some(v.trim().to_string());
            }
        }
    }

    if method.eq_ignore_ascii_case("OPTIONS") {
        return write_preflight(&mut writer);
    }
    let head = method.eq_ignore_ascii_case("HEAD");

    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p, q),
        None => (target.as_str(), ""),
    };

    // 토큰 검증(2차 방어).
    let prefix = format!("/{token}/");
    if !path.starts_with(&prefix) {
        return write_simple(&mut writer, 404, "not found");
    }
    let kind = &path[prefix.len()..];

    let params = parse_query(query);
    let url = match params.get("url") {
        Some(u) if !u.is_empty() => u.clone(),
        _ => return write_simple(&mut writer, 400, "missing url"),
    };
    let referer = params.get("referer").map(|s| s.as_str());
    let ua = params.get("ua").map(|s| s.as_str());

    match kind {
        "m3u8" => serve_m3u8(&mut writer, &url, referer, ua, port, token, head),
        "stream" => serve_stream(&mut writer, &url, referer, range.as_deref(), head),
        _ => write_simple(&mut writer, 404, "not found"),
    }
}


// ── 임퍼소네이션 클라이언트(wreq/BoringSSL) — fingerprint 봇차단 CDN(Cloudflare/Akamai)이 TLS(JA3)+HTTP/2 ──
// 로 비-브라우저를 403. wreq 가 Chrome 핸드셰이크를 정밀 위조해 통과(라이브 증명: 비-위장 403, wreq 200) —
// 차단 CDN + 일반 CDN 모두 1요청에 통과하므로 미디어 프록시는 이 위장 클라이언트만 쓴다. wreq 가 연결 자체를
// 못 한 드문 경우에 두 번째 TLS 스택(reqwest/OpenSSL)으로 폴백하지 않는다 — 그 이중 스택이 Linux 정적 링크를
// 깨던 결함의 근치(SSL_* 심볼 충돌 제거). 연결 실패는 502 로 정직히 실패한다. wreq 는 모든 OS 동일 핑거프린트
// (BoringSSL 벤더링) + async 전용 → 공용 tokio 런타임(OnceLock)으로 sync 프록시 스레드에서 block_on.
static ASYNC_RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
static WREQ_CLIENT: OnceLock<wreq::Client> = OnceLock::new();

fn wreq_rt() -> Option<&'static tokio::runtime::Runtime> {
    if ASYNC_RT.get().is_none() {
        if let Ok(rt) = tokio::runtime::Runtime::new() {
            let _ = ASYNC_RT.set(rt);
        }
    }
    ASYNC_RT.get()
}

fn wreq_client() -> Option<&'static wreq::Client> {
    if WREQ_CLIENT.get().is_none() {
        if let Ok(c) = wreq::Client::builder()
            .emulation(Emulation::Chrome136)
            .build()
        {
            let _ = WREQ_CLIENT.set(c);
        }
    }
    WREQ_CLIENT.get()
}

// 임퍼소네이션 fetch → (status, content-* 헤더, 바디 바이트). referer/origin/range 동일 주입.
fn wreq_fetch(
    url: &str,
    referer: Option<&str>,
    range: Option<&str>,
) -> Result<(u16, Vec<(String, String)>, Vec<u8>), String> {
    let rt = wreq_rt().ok_or("wreq runtime")?;
    let client = wreq_client().ok_or("wreq client")?;
    rt.block_on(async {
        let mut rb = client.get(url);
        if let Some(r) = referer {
            rb = rb.header("referer", r);
            if let Some(o) = origin_of(r) {
                rb = rb.header("origin", o);
            }
        }
        if let Some(rg) = range {
            rb = rb.header("range", rg);
        }
        let resp = rb.send().await.map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        let headers: Vec<(String, String)> = [
            "content-type",
            "content-length",
            "content-range",
            "accept-ranges",
        ]
        .iter()
        .filter_map(|h| {
            resp.headers()
                .get(*h)
                .and_then(|v| v.to_str().ok())
                .map(|v| ((*h).to_string(), v.to_string()))
        })
        .collect();
        let body = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
        Ok::<_, String>((status, headers, body))
    })
}

// net.http.request 의 impersonate:"chrome" 백엔드 — 위장 client 를 한 군데(여기)만 소유하고, http.rs 는
// 이 helper 로 재사용한다(신규 wreq client 인스턴스 0, 이미 떠 있는 WREQ_CLIENT/ASYNC_RT 싱글톤 그대로).
// http.rs 의 정직(off) 경로와 응답 shape 동일: (status, 전체 헤더, 바디 문자열). 시크릿 치환은
// 호출 전 http.rs 가 이미 끝낸다 — 여기는 순수 전송기(임퍼소네이션 백엔드)일 뿐.
pub(crate) fn impersonated_request(
    method: &str,
    url: &str,
    headers: &HashMap<String, String>,
    query: &HashMap<String, String>,
    body: Option<&str>,
    content_type: Option<&str>,
) -> Result<(u16, HashMap<String, String>, String), String> {
    let rt = wreq_rt().ok_or("wreq runtime")?;
    let client = wreq_client().ok_or("wreq client")?;
    let m = wreq::Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|e| format!("HTTP method 불량: {e}"))?;
    let target = build_target(url, query);
    rt.block_on(async {
        let mut rb = client.request(m, target.as_str());
        for (k, v) in headers {
            rb = rb.header(k.as_str(), v.as_str());
        }
        if let Some(ct) = content_type {
            rb = rb.header("content-type", ct);
        }
        if let Some(b) = body {
            rb = rb.body(b.to_string());
        }
        let resp = rb.send().await.map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        let mut hmap = HashMap::new();
        for (k, v) in resp.headers() {
            hmap.insert(k.as_str().to_string(), v.to_str().unwrap_or("").to_string());
        }
        let text = resp.text().await.map_err(|e| e.to_string())?;
        Ok::<_, String>((status, hmap, text))
    })
}

// query 를 URL 에 직접 붙인다 — wreq 의 .query() 는 "query" feature 게이트라(미활성) 새 feature 켜는 대신
// 이미 쓰는 url::form_urlencoded 로 인코딩(정직/임퍼소네이션 두 경로 공용, 단일 진실).
fn build_target(url: &str, query: &HashMap<String, String>) -> String {
    if query.is_empty() {
        return url.to_string();
    }
    let mut enc = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in query {
        enc.append_pair(k, v);
    }
    let qs = enc.finish();
    let sep = if url.contains('?') { '&' } else { '?' };
    format!("{url}{sep}{qs}")
}

// 정직("off") 전송 클라이언트 — emulation 없는 wreq(BoringSSL). first-party 호출은 브라우저 위장을 하지
// 않는 게 올바른 기본값이다. cert 검증은 wreq 기본값(on). 코어는 이 BoringSSL 스택 한 벌만 쓴다 — reqwest
// (OpenSSL)를 제거해 wreq 와의 SSL_* 심볼 충돌(Linux 정적 링크 불가)을 근절한다.
static WREQ_HONEST_CLIENT: OnceLock<wreq::Client> = OnceLock::new();
fn wreq_honest_client() -> Option<&'static wreq::Client> {
    if WREQ_HONEST_CLIENT.get().is_none() {
        // 무한 대기 금지 — stall 한 원격이 호출자를 영원히 붙잡지 못한다(설치 클로저 다중 fetch 의 근치).
        if let Ok(c) = wreq::Client::builder().timeout(Duration::from_secs(60)).build() {
            let _ = WREQ_HONEST_CLIENT.set(c);
        }
    }
    WREQ_HONEST_CLIENT.get()
}

// net.http.request 의 "off"(정직) 백엔드 — impersonated_request 와 응답 shape 동일, 위장만 없다. Authorization
// 이 실린 요청은 리다이렉트를 따르지 않는다(검증된 대상 URL 밖으로 자격증명이 새지 않게 — HTTPS→HTTP 강등 포함).
pub(crate) fn honest_request(
    method: &str,
    url: &str,
    headers: &HashMap<String, String>,
    query: &HashMap<String, String>,
    body: Option<&str>,
    content_type: Option<&str>,
) -> Result<(u16, HashMap<String, String>, String), String> {
    let rt = wreq_rt().ok_or("wreq runtime")?;
    let client = wreq_honest_client().ok_or("wreq client")?;
    let m = wreq::Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|e| format!("HTTP method 불량: {e}"))?;
    let target = build_target(url, query);
    let no_redirect = headers.keys().any(|k| k.eq_ignore_ascii_case("authorization"));
    rt.block_on(async {
        let mut rb = client.request(m, target.as_str());
        if no_redirect {
            rb = rb.redirect(wreq::redirect::Policy::none());
        }
        for (k, v) in headers {
            rb = rb.header(k.as_str(), v.as_str());
        }
        if let Some(ct) = content_type {
            rb = rb.header("content-type", ct);
        }
        if let Some(b) = body {
            rb = rb.body(b.to_string());
        }
        let resp = rb.send().await.map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        let mut hmap = HashMap::new();
        for (k, v) in resp.headers() {
            hmap.insert(k.as_str().to_string(), v.to_str().unwrap_or("").to_string());
        }
        let text = resp.text().await.map_err(|e| e.to_string())?;
        Ok::<_, String>((status, hmap, text))
    })
}

// fetch reach 다운로드용 정직 GET(바디 바이트) — runtime_dep 이 sha256 핀 검증에 쓴다(무결성 우선).
pub(crate) fn honest_get_bytes(url: &str) -> Result<Vec<u8>, String> {
    let rt = wreq_rt().ok_or("wreq runtime")?;
    let client = wreq_honest_client().ok_or("wreq client")?;
    rt.block_on(async {
        let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
        let body = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
        Ok::<_, String>(body)
    })
}

// wreq 스트리밍 결과. SendFailed = send 실패(아직 아무것도 안 씀 → native 폴백 가능). Io = 헤더/바디 쓰는 중
// 실패(이미 부분 전송됨 → 폴백 불가, 그대로 에러).
enum WreqStreamErr {
    SendFailed,
    Io(std::io::Error),
}

// 임퍼소네이션 스트리밍 — send 성공 시 status+content-* 헤더를 쓰고 바디를 청크 스트리밍(전체 버퍼링 0,
// native 의 io::copy 동급). Range 도 전달. 큰 mp4(Range 0-)도 메모리에 안 쌓는다.
fn wreq_stream_to(
    writer: &mut TcpStream,
    url: &str,
    referer: Option<&str>,
    range: Option<&str>,
    head: bool,
) -> Result<(), WreqStreamErr> {
    let rt = wreq_rt().ok_or(WreqStreamErr::SendFailed)?;
    let client = wreq_client().ok_or(WreqStreamErr::SendFailed)?;
    rt.block_on(async {
        let mut rb = client.get(url);
        if let Some(r) = referer {
            rb = rb.header("referer", r);
            if let Some(o) = origin_of(r) {
                rb = rb.header("origin", o);
            }
        }
        if let Some(rg) = range {
            rb = rb.header("range", rg);
        }
        let resp = rb.send().await.map_err(|_| WreqStreamErr::SendFailed)?;
        let status = resp.status().as_u16();
        let mut out = format!("HTTP/1.1 {status} {}\r\n", reason(status));
        for h in [
            "content-type",
            "content-length",
            "content-range",
            "accept-ranges",
        ] {
            if let Some(v) = resp.headers().get(h).and_then(|v| v.to_str().ok()) {
                out.push_str(&format!("{h}: {v}\r\n"));
            }
        }
        out.push_str(CORS);
        out.push_str("Connection: close\r\n\r\n");
        writer
            .write_all(out.as_bytes())
            .map_err(WreqStreamErr::Io)?;
        if !head {
            use futures_util::StreamExt;
            let mut stream = resp.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| WreqStreamErr::Io(std::io::Error::other(e)))?;
                writer.write_all(&chunk).map_err(WreqStreamErr::Io)?;
            }
        }
        writer.flush().map_err(WreqStreamErr::Io)
    })
}

// 바이너리 패스스루: wreq 1차(청크 스트리밍) → 연결 실패 시 native-tls(io::copy) 폴백. Range 전달.
fn serve_stream(
    writer: &mut TcpStream,
    url: &str,
    referer: Option<&str>,
    range: Option<&str>,
    head: bool,
) -> std::io::Result<()> {
    // wreq(임퍼소네이션 = Chrome JA3/UA) 로 청크 스트리밍(전체 버퍼링 0). 코어는 BoringSSL 스택 한 벌만 쓴다 —
    // wreq 가 연결 자체를 못 한 드문 경우에 두 번째 TLS 스택(reqwest/OpenSSL)으로 폴백하지 않는다(502 로 정직히
    // 실패). 이 이중 스택이 Linux 정적 링크를 깨던 결함의 근치(SSL_* 심볼 충돌 제거).
    match wreq_stream_to(writer, url, referer, range, head) {
        Ok(()) => Ok(()),
        Err(WreqStreamErr::Io(e)) => Err(e), // 이미 부분 전송 — 회복 불가
        Err(WreqStreamErr::SendFailed) => write_simple(writer, 502, "upstream 연결 실패"),
    }
}

// m3u8: 텍스트로 받아 세그먼트/키 URL 을 프록시 자기 자신으로 리라이트 후 반환.
fn serve_m3u8(
    writer: &mut TcpStream,
    url: &str,
    referer: Option<&str>,
    ua: Option<&str>,
    port: u16,
    token: &str,
    head: bool,
) -> std::io::Result<()> {
    // wreq(임퍼소네이션 = Chrome) 로 본문 취득. 코어 단일 BoringSSL 스택 — wreq 가 연결 자체를 못 한 드문
    // 경우에 second-TLS-stack(reqwest/OpenSSL) 폴백을 두지 않는다(502). 상태코드(403/404)는 그대로 반환.
    let body = match wreq_fetch(url, referer, None) {
        Ok((st, _, b)) if (200..300).contains(&st) => String::from_utf8_lossy(&b).into_owned(),
        Ok((st, _, _)) => return write_simple(writer, st, "upstream m3u8"),
        Err(_) => return write_simple(writer, 502, "upstream m3u8 연결 실패"),
    };
    let proxy_base = format!("http://127.0.0.1:{port}/{token}");
    let rewritten = rewrite_m3u8(&body, url, &proxy_base, referer, ua);

    let mut out = String::from("HTTP/1.1 200 OK\r\n");
    out.push_str("Content-Type: application/vnd.apple.mpegurl\r\n");
    out.push_str(&format!("Content-Length: {}\r\n", rewritten.len()));
    out.push_str(CORS);
    out.push_str("Cache-Control: no-store\r\nConnection: close\r\n\r\n");
    writer.write_all(out.as_bytes())?;
    if !head {
        writer.write_all(rewritten.as_bytes())?;
    }
    writer.flush()
}

// ── 순수 헬퍼(테스트 직접 호출) ──────────────────────────────────────────────

fn enc(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

fn parse_query(q: &str) -> HashMap<String, String> {
    url::form_urlencoded::parse(q.as_bytes())
        .into_owned()
        .collect()
}

fn origin_of(u: &str) -> Option<String> {
    let p = Url::parse(u).ok()?;
    let host = p.host_str()?;
    let port = p.port().map(|x| format!(":{x}")).unwrap_or_default();
    Some(format!("{}://{}{}", p.scheme(), host, port))
}

// playlist_url → (origin, dir). origin=scheme://host[:port], dir=쿼리 제거 후 마지막 '/' 이전.
fn split_base(playlist_url: &str) -> (String, String) {
    let no_q = playlist_url.split('?').next().unwrap_or(playlist_url);
    let dir = match no_q.rfind('/') {
        Some(i) => &no_q[..i],
        None => no_q,
    };
    let origin = origin_of(playlist_url).unwrap_or_default();
    (origin, dir.to_string())
}

// m3u8 라인 URL 을 절대화: 절대(http) 그대로 / scheme-relative(//) / root(/) / 상대.
fn join_url(origin: &str, dir: &str, line: &str) -> String {
    if line.starts_with("http://") || line.starts_with("https://") {
        line.to_string()
    } else if let Some(rest) = line.strip_prefix("//") {
        let scheme = origin.split(':').next().unwrap_or("https");
        format!("{scheme}://{rest}")
    } else if line.starts_with('/') {
        format!("{origin}{line}")
    } else {
        format!("{dir}/{line}")
    }
}

fn build_proxied(
    proxy_base: &str,
    kind: &str,
    abs: &str,
    referer: Option<&str>,
    ua: Option<&str>,
) -> String {
    let mut s = format!("{proxy_base}/{kind}?url={}", enc(abs));
    if let Some(r) = referer {
        s.push_str(&format!("&referer={}", enc(r)));
    }
    if let Some(u) = ua {
        s.push_str(&format!("&ua={}", enc(u)));
    }
    s
}

// #EXT-X-KEY/#EXT-X-MEDIA/#EXT-X-MAP 의 URI="..." 를 프록시로. 확장자로 분기 — 대체 오디오/자막은
// .m3u8 라 /m3u8(재귀 리라이트), 키/초기화 세그먼트(MAP)는 바이너리라 /stream. 없으면 None(원라인 유지).
fn rewrite_uri_attr(
    line: &str,
    origin: &str,
    dir: &str,
    proxy_base: &str,
    referer: Option<&str>,
    ua: Option<&str>,
) -> Option<String> {
    let needle = "URI=\"";
    let start = line.find(needle)?;
    let vstart = start + needle.len();
    let vend = line[vstart..].find('"')? + vstart;
    let abs = join_url(origin, dir, &line[vstart..vend]);
    let kind = if abs.split('?').next().unwrap_or("").ends_with(".m3u8") {
        "m3u8"
    } else {
        "stream"
    };
    let proxied = build_proxied(proxy_base, kind, &abs, referer, ua);
    Some(format!("{}{}{}", &line[..vstart], proxied, &line[vend..]))
}

// HLS 플레이리스트 리라이트 — 변형(.m3u8)→/m3u8(재귀), 세그먼트/키→/stream. referer/ua 를 모든 줄에 실음.
// 출력은 LF 정규화(HLS 는 LF 허용). 주석은 URI 속성 제외 그대로 통과.
pub fn rewrite_m3u8(
    playlist: &str,
    playlist_url: &str,
    proxy_base: &str,
    referer: Option<&str>,
    ua: Option<&str>,
) -> String {
    let (origin, dir) = split_base(playlist_url);
    let mut out = String::with_capacity(playlist.len() * 2);
    for raw in playlist.lines() {
        let line = raw.trim_end_matches('\r');
        if line.is_empty() {
            out.push('\n');
            continue;
        }
        if line.starts_with('#') {
            match rewrite_uri_attr(line, &origin, &dir, proxy_base, referer, ua) {
                Some(r) => out.push_str(&r),
                None => out.push_str(line),
            }
            out.push('\n');
            continue;
        }
        let abs = join_url(&origin, &dir, line);
        let kind = if abs.split('?').next().unwrap_or("").ends_with(".m3u8") {
            "m3u8"
        } else {
            "stream"
        };
        out.push_str(&build_proxied(proxy_base, kind, &abs, referer, ua));
        out.push('\n');
    }
    out
}

fn reason(s: u16) -> &'static str {
    match s {
        200 => "OK",
        206 => "Partial Content",
        301 => "Moved Permanently",
        302 => "Found",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "OK",
    }
}

fn write_preflight(w: &mut TcpStream) -> std::io::Result<()> {
    let mut out = String::from("HTTP/1.1 204 No Content\r\n");
    out.push_str(CORS);
    out.push_str("Content-Length: 0\r\nConnection: close\r\n\r\n");
    w.write_all(out.as_bytes())?;
    w.flush()
}

fn write_simple(w: &mut TcpStream, status: u16, msg: &str) -> std::io::Result<()> {
    let body = msg.as_bytes();
    let mut out = format!("HTTP/1.1 {status} {}\r\n", reason(status));
    out.push_str("Content-Type: text/plain; charset=utf-8\r\n");
    out.push_str(&format!("Content-Length: {}\r\n", body.len()));
    out.push_str(CORS);
    out.push_str("Connection: close\r\n\r\n");
    w.write_all(out.as_bytes())?;
    w.write_all(body)?;
    w.flush()
}

// ── 테스트(로컬 upstream — 외부망 비의존, R10/R8) ───────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read; // 통합 테스트의 로컬 upstream 이 stream.read 사용(메인 코드는 미사용).

    const PROXY: &str = "http://127.0.0.1:9/t";

    #[test]
    fn rewrite_relative_and_absolute_segments() {
        let pl = "#EXTM3U\n#EXTINF:5,\nseg0.ts\n#EXTINF:5,\nhttps://cdn.other/x/seg1.ts\n";
        let out = rewrite_m3u8(pl, "https://cdn.example/a/b/play.m3u8", PROXY, None, None);
        assert!(out.contains(&format!(
            "{PROXY}/stream?url={}",
            enc("https://cdn.example/a/b/seg0.ts")
        )));
        assert!(out.contains(&format!(
            "{PROXY}/stream?url={}",
            enc("https://cdn.other/x/seg1.ts")
        )));
        // 주석/EXTINF 은 그대로.
        assert!(out.contains("#EXTINF:5,"));
        assert!(out.starts_with("#EXTM3U"));
    }

    // 임퍼소네이션 멱등 검증(네트워크 — 기본 제외, 수동: cargo test -- --ignored ja3). 중립 TLS 핑거프린트
    // 에코(tls.peet.ws)로 native-tls(프록시 1차)와 wreq(프록시 폴백)의 JA3 가 다른지 = 임퍼소네이션이
    // 핑거프린트를 실제로 바꾸는지 확인. 특정 사이트 비의존 — 봇차단 CDN 우회의 핵심 메커니즘만 검증.
    #[test]
    #[ignore = "network: cargo test -- --ignored ja3_impersonation_changes_fingerprint"]
    fn ja3_impersonation_changes_fingerprint() {
        fn ja3(json: &str) -> String {
            // tls.ja3_hash 는 중첩 + pretty-print(공백) → serde_json 으로 파싱.
            serde_json::from_str::<serde_json::Value>(json)
                .ok()
                .and_then(|v| v["tls"]["ja3_hash"].as_str().map(str::to_string))
                .unwrap_or_default()
        }
        let peet = "https://tls.peet.ws/api/all";
        // off = 정직 wreq(비-emulation BoringSSL), imp = Chrome 위장 wreq. 같은 BoringSSL 이라도 emulation 이
        // ClientHello 를 Chrome 으로 정밀 위조하므로 JA3 가 달라진다(위장이 실제로 핑거프린트를 바꾸는지 검증).
        let (_, _, nb) = proxy_req("GET", peet, &[]);
        let honest = String::from_utf8_lossy(&nb).into_owned();
        let (_st, _h, body) = wreq_fetch(peet, None, None).unwrap();
        let imp = String::from_utf8_lossy(&body).into_owned();

        let n = ja3(&honest);
        let w = ja3(&imp);
        assert!(!n.is_empty(), "off(정직 wreq) JA3 비어있음");
        assert!(!w.is_empty(), "wreq JA3 비어있음");
        assert_ne!(n, w, "임퍼소네이션이 JA3 를 안 바꿈(native={n}, wreq={w})");
    }

    #[test]
    fn rewrite_root_relative_segment() {
        let pl = "#EXTM3U\n/v/seg.ts\n";
        let out = rewrite_m3u8(pl, "https://cdn.example/a/b/play.m3u8", PROXY, None, None);
        assert!(out.contains(&enc("https://cdn.example/v/seg.ts")));
    }

    #[test]
    fn rewrite_nested_variant_goes_to_m3u8_route() {
        let pl = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nsub/var.m3u8\n";
        let out = rewrite_m3u8(pl, "https://cdn.example/a/play.m3u8", PROXY, None, None);
        assert!(out.contains(&format!(
            "{PROXY}/m3u8?url={}",
            enc("https://cdn.example/a/sub/var.m3u8")
        )));
    }

    #[test]
    fn rewrite_key_uri_attribute() {
        let pl = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"https://cdn.example/k/key.bin\",IV=0x1\nseg.ts\n";
        let out = rewrite_m3u8(pl, "https://cdn.example/a/play.m3u8", PROXY, None, None);
        assert!(out.contains(&format!(
            "URI=\"{PROXY}/stream?url={}",
            enc("https://cdn.example/k/key.bin")
        )));
        assert!(out.contains("METHOD=AES-128"));
        assert!(out.contains("IV=0x1"));
    }

    #[test]
    fn rewrite_media_audio_uri_routes_to_m3u8() {
        // 대체 오디오 렌디션은 별도 .m3u8 — /m3u8(재귀)로 가야 내부 세그먼트도 리라이트된다.
        let pl = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"audio/eng.m3u8\"\n";
        let out = rewrite_m3u8(pl, "https://cdn.example/a/master.m3u8", PROXY, None, None);
        assert!(out.contains(&format!(
            "URI=\"{PROXY}/m3u8?url={}",
            enc("https://cdn.example/a/audio/eng.m3u8")
        )));
    }

    #[test]
    fn rewrite_carries_referer_and_ua() {
        let pl = "#EXTM3U\nseg.ts\n";
        let out = rewrite_m3u8(
            pl,
            "https://cdn.example/play.m3u8",
            PROXY,
            Some("https://ref.example/page"),
            Some("UA/1"),
        );
        assert!(out.contains(&format!("&referer={}", enc("https://ref.example/page"))));
        assert!(out.contains(&format!("&ua={}", enc("UA/1"))));
    }

    // ── 통합: 로컬 upstream → 프록시 → 클라이언트(wreq honest). Range 중계 + CORS + 토큰 ──

    // Range 를 이해하는 최소 upstream(루프, 연결마다 1응답). 바디 "0123456789A"(11바이트).
    fn spawn_upstream() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_lowercase();
                let full = b"0123456789A";
                let resp = if req.contains("range:") {
                    // bytes=0-3 만 처리(테스트 충분).
                    format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Type: video/mp2t\r\nContent-Range: bytes 0-3/11\r\nAccept-Ranges: bytes\r\nContent-Length: 4\r\nConnection: close\r\n\r\n0123"
                    )
                } else {
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nAccept-Ranges: bytes\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{}",
                        String::from_utf8_lossy(full)
                    )
                };
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
            }
        });
        port
    }

    fn spawn_proxy(token: &str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let token = token.to_string();
        std::thread::spawn(move || serve(listener, port, token));
        port
    }

    fn wait_ready(port: u16) {
        for _ in 0..50 {
            if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    // 테스트 HTTP 클라이언트 — 로컬 프록시(plain HTTP)에 요청. 코어와 같은 wreq 정직 클라이언트를 쓴다
    // (reqwest 없음 — 코어 HTTP 는 wreq 한 스택으로 통일). (status, 헤더맵, 바디 바이트)를 돌려준다.
    fn proxy_req(method: &str, url: &str, headers: &[(&str, &str)]) -> (u16, HashMap<String, String>, Vec<u8>) {
        let rt = wreq_rt().unwrap();
        let client = wreq_honest_client().unwrap();
        let m = wreq::Method::from_bytes(method.as_bytes()).unwrap();
        rt.block_on(async {
            let mut rb = client.request(m, url);
            for (k, v) in headers {
                rb = rb.header(*k, *v);
            }
            let resp = rb.send().await.unwrap();
            let status = resp.status().as_u16();
            let hmap: HashMap<String, String> = resp
                .headers()
                .iter()
                .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
                .collect();
            let body = resp.bytes().await.unwrap().to_vec();
            (status, hmap, body)
        })
    }

    #[test]
    fn stream_relays_range_206_and_cors() {
        let up = spawn_upstream();
        let px = spawn_proxy("testtoken");
        wait_ready(up);
        wait_ready(px);
        let upstream_url = format!("http://127.0.0.1:{up}/seg.ts");
        let proxy_url = format!(
            "http://127.0.0.1:{px}/testtoken/stream?url={}",
            enc(&upstream_url)
        );
        let (status, headers, body) = proxy_req("GET", &proxy_url, &[("range", "bytes=0-3")]);
        assert_eq!(status, 206, "206 중계");
        assert_eq!(headers.get("access-control-allow-origin").unwrap(), "*", "CORS 헤더");
        assert_eq!(headers.get("content-range").unwrap(), "bytes 0-3/11", "Content-Range 중계");
        assert_eq!(String::from_utf8_lossy(&body), "0123", "부분 바디 스트리밍");
    }

    #[test]
    fn stream_full_200_passthrough() {
        let up = spawn_upstream();
        let px = spawn_proxy("testtoken");
        wait_ready(up);
        wait_ready(px);
        let upstream_url = format!("http://127.0.0.1:{up}/seg.ts");
        let proxy_url = format!(
            "http://127.0.0.1:{px}/testtoken/stream?url={}",
            enc(&upstream_url)
        );
        let (status, _, body) = proxy_req("GET", &proxy_url, &[]);
        assert_eq!(status, 200);
        assert_eq!(String::from_utf8_lossy(&body), "0123456789A");
    }

    #[test]
    fn wrong_token_404() {
        let px = spawn_proxy("testtoken");
        wait_ready(px);
        let proxy_url = format!("http://127.0.0.1:{px}/WRONG/stream?url=http://x/y.ts");
        let (status, _, _) = proxy_req("GET", &proxy_url, &[]);
        assert_eq!(status, 404);
    }

    #[test]
    fn options_preflight_204() {
        let px = spawn_proxy("testtoken");
        wait_ready(px);
        let proxy_url = format!("http://127.0.0.1:{px}/testtoken/stream?url=http://x/y.ts");
        let (status, headers, _) = proxy_req("OPTIONS", &proxy_url, &[]);
        assert_eq!(status, 204);
        assert_eq!(headers.get("access-control-allow-methods").unwrap(), "GET, HEAD, OPTIONS");
    }

    #[test]
    fn missing_url_400() {
        let px = spawn_proxy("testtoken");
        wait_ready(px);
        let proxy_url = format!("http://127.0.0.1:{px}/testtoken/stream");
        let (status, _, _) = proxy_req("GET", &proxy_url, &[]);
        assert_eq!(status, 400);
    }

    // 라이브 종단 검증 — 외부 공개 HLS(Apple, 비성인/CORS 친화). 기본 suite 비포함(외부망 의존):
    // `cargo test --lib mediaproxy -- --ignored` 로만. master→변형(.m3u8)→세그먼트(.ts/.m4s) 전 경로가
    // 실제 프록시 코드를 통과하는지 확인한다.
    #[test]
    #[ignore = "live: 외부 공개 HLS 의존, --ignored 로만"]
    fn live_apple_hls_through_proxy() {
        let px = spawn_proxy("livetoken");
        wait_ready(px);
        let master = "https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8";
        let proxied_master = format!("http://127.0.0.1:{px}/livetoken/m3u8?url={}", enc(master));
        let (_, _, mb) = proxy_req("GET", &proxied_master, &[]);
        let master_body = String::from_utf8_lossy(&mb).into_owned();
        assert!(
            master_body.contains("/livetoken/m3u8?url="),
            "변형 플레이리스트가 프록시로 리라이트됨"
        );
        // bare URI 줄만(주석 #EXT-X-MEDIA 의 URI= 가 아닌, 변형 플레이리스트 줄).
        let variant = master_body
            .lines()
            .map(|l| l.trim())
            .find(|l| l.starts_with("http") && l.contains("/livetoken/m3u8?url="))
            .expect("변형 .m3u8")
            .to_string();
        let (_, _, mb2) = proxy_req("GET", &variant, &[]);
        let media_body = String::from_utf8_lossy(&mb2).into_owned();
        assert!(
            media_body.contains("/livetoken/stream?url="),
            "세그먼트가 프록시로 리라이트됨"
        );
        let seg = media_body
            .lines()
            .map(|l| l.trim())
            .find(|l| l.starts_with("http") && l.contains("/livetoken/stream?url="))
            .expect("세그먼트")
            .to_string();
        let (s, _, body) = proxy_req("GET", &seg, &[("range", "bytes=0-1023")]);
        assert!(s == 200 || s == 206, "세그먼트 스트리밍 status={s}");
        assert!(!body.is_empty(), "세그먼트 바이트 수신");
    }
}
