// remote::tunnel 테스트 — 로컬 dev-server reverse-proxy 터널의 보안 불변식(suite E).
//
// RED→GREEN: 각 공격을 재현/가정(방어 전엔 통과=취약)하고, 방어 후 차단을 단언한다. 핵심은
// **REAL E2E**: 진짜 로컬 HTTP 서버를 loopback 포트에 띄우고, 클라이언트가 REAL serve_tunnel 을
// REAL 소켓 위로 통과해 터널을 열어 HTTP 요청/응답이 종단 간 왕복함을 단언한다.
//
// 불변식(HARD):
//   - SSRF 0: allowlist 밖 포트 ⇒ 거부, connect 시도 0.
//   - loopback-only: connect 타겟은 항상 127.0.0.1(non-loopback 도달 경로 0).
//   - phone-cannot-escalate: 어떤 frame 도 allowlist 를 mutate 안 함.
//   - 미페어링 ⇒ 터널 0(Noise 게이트 먼저).
//   - 기밀성: 프록시 HTTP 바이트가 와이어 ciphertext 에 평문으로 안 보임.
//   - graceful: 로컬 미기동 ⇒ clean 에러(패닉 0).

use super::*;
use crate::remote::auth::{CapabilityAssertion, DeviceRegistry, Scope};
use crate::remote::client::{connect_tcp, ClientError, DeviceIdentity};
use crate::remote::noise::{PinnedPeerRegistry, StaticKeypair};
use crate::remote::tcp::bind_loopback;
use crate::remote::transport::{serve_tunnel, SharedAuth};
use ed25519_dalek::{Signer, SigningKey};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

// ===========================================================================
// 테스트 하니스 — 진짜 로컬 HTTP 서버 + 진짜 데스크톱 serve_tunnel + 진짜 폰 클라이언트.
// ===========================================================================

/// 결정적 Ed25519 키(테스트 — 서명/검증 쌍).
fn ed_key(seed: u8) -> SigningKey {
    let mut b = [0u8; 32];
    b[0] = seed;
    b[31] = 0x42;
    SigningKey::from_bytes(&b)
}

/// 진짜 로컬 HTTP/1.1 서버를 127.0.0.1 임의 포트에 띄운다 — dev-server 흉내. 한 연결을 받아
/// HTTP 요청 라인을 읽고(헤더 끝 `\r\n\r\n` 까지), 고정 본문으로 응답한다. 반환: (포트, JoinHandle).
///
/// `body` 가 길면 멀티-청크(여러 write)로 응답해 스트리밍 경로를 행위로 강제한다.
async fn spawn_local_http(body: String, chunked: bool) -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = tokio::spawn(async move {
        if let Ok((mut sock, _)) = listener.accept().await {
            // 요청 헤더 끝까지 읽기(`\r\n\r\n`). 간단한 상태 머신.
            let mut buf = Vec::new();
            let mut tmp = [0u8; 1024];
            loop {
                match sock.read(&mut tmp).await {
                    Ok(0) => break,
                    Ok(n) => {
                        buf.extend_from_slice(&tmp[..n]);
                        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                    Err(_) => return,
                }
            }
            let resp_head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: text/plain\r\n\r\n",
                body.len()
            );
            let _ = sock.write_all(resp_head.as_bytes()).await;
            let _ = sock.flush().await;
            if chunked && body.len() > 8 {
                // 멀티-청크 — 본문을 두 조각으로 나눠 각각 write+flush(스트리밍 경로 강제).
                let mid = body.len() / 2;
                let _ = sock.write_all(&body.as_bytes()[..mid]).await;
                let _ = sock.flush().await;
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                let _ = sock.write_all(&body.as_bytes()[mid..]).await;
                let _ = sock.flush().await;
            } else {
                let _ = sock.write_all(body.as_bytes()).await;
                let _ = sock.flush().await;
            }
            // 응답 끝 — 연결 닫음(서버 EOF → proxy 가 폰에 EOF 전파).
        }
    });
    (port, handle)
}

/// 데스크톱 serve_tunnel 을 진짜 loopback 소켓 위에서 1연결 서비스하는 백그라운드 task 를 띄운다.
/// 페어링: 폰 신원의 두 공개키(pairing_bundle)를 핀닝 + auth.pair(scope). allowlist 주입.
/// (client/tests.rs 의 pair_desktop_with_phone 패턴 — generate 신원의 **공개키만** 데스크톱이 핀닝.)
/// 반환: (서버 주소, desktop static 공개키, JoinHandle).
async fn spawn_serve_tunnel(
    phone: &DeviceIdentity,
    granted: Scope,
    allowlist: PortAllowlist,
) -> (SocketAddr, [u8; 32], tokio::task::JoinHandle<()>) {
    let local = Arc::new(StaticKeypair::generate().unwrap());
    let desktop_pub = local.public_key();
    let bundle = phone.pairing_bundle();
    let mut noise = PinnedPeerRegistry::new();
    noise.pin(&bundle.device_id, &bundle.x25519_public).unwrap();
    let mut auth = DeviceRegistry::new(4);
    auth.pair(&bundle.device_id, &bundle.ed25519_public, granted).unwrap();
    let shared = SharedAuth::new(auth);
    let noise = Arc::new(noise);
    let allowlist = Arc::new(allowlist);

    let listener = bind_loopback(0).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        if let Ok((stream, _)) = listener.accept().await {
            let _ = serve_tunnel(stream, &local, &noise, &shared, &allowlist, || 200u64).await;
        }
    });
    (addr, desktop_pub, handle)
}

/// 폰 신원 + connect_tcp 로 ClientSession 을 만든다(진짜 KK INITIATOR 핸드셰이크). desktop_id="desktop".
async fn phone_session(
    addr: SocketAddr,
    desktop_pub: &[u8; 32],
    phone: &DeviceIdentity,
) -> Result<crate::remote::client::ClientSession<TcpStream>, ClientError> {
    connect_tcp(addr, phone, "desktop", desktop_pub).await
}

// ===========================================================================
// 단위: PortAllowlist — 데스크톱 소유, fail-closed, 포트 0 거부.
// ===========================================================================

#[test]
fn allowlist_default_is_empty_fail_closed() {
    // RED(방어 전): 기본 allowlist 가 무엇이든 허용하면 SSRF. GREEN: 빈 allowlist = 전부 거부.
    let al = PortAllowlist::new();
    assert!(al.is_empty(), "기본 allowlist 는 비어 있다(fail-closed)");
    assert!(!al.is_allowed(3000), "명시 allow 없으면 거부");
    assert!(!al.is_allowed(0), "포트 0 은 절대 통과 안 함(placeholder)");
}

#[test]
fn allowlist_allows_only_listed_ports() {
    let al = PortAllowlist::from_ports([3000, 5173]);
    assert!(al.is_allowed(3000), "명시 포트 허용");
    assert!(al.is_allowed(5173), "명시 포트 허용");
    assert!(!al.is_allowed(22), "비명시 포트 거부(SSRF 0)");
    assert!(!al.is_allowed(8080), "비명시 포트 거부");
    assert_eq!(al.allowed_ports(), vec![3000, 5173], "정렬 노출(RULE 8 observable)");
}

#[test]
fn allowlist_rejects_port_zero_even_if_inserted() {
    let mut al = PortAllowlist::new();
    al.allow(0);
    assert!(al.is_empty(), "포트 0 은 insert 되지 않음");
    assert!(!al.is_allowed(0), "포트 0 거부");
}

// ===========================================================================
// 단위: 터널 요청 코덱 — `tunnel:port` round-trip + malformed 거부(명령 모드와 분리).
// ===========================================================================

#[test]
fn tunnel_request_round_trips_and_is_distinct_from_command() {
    let req = encode_tunnel_request(5173);
    assert_eq!(decode_tunnel_request(&req), Some(5173), "round-trip");
    // 명령 dispatch frame(JSON)은 터널 요청으로 파싱되지 않는다(모드 blur 0).
    assert_eq!(decode_tunnel_request(b"{\"method\":\"ui.tree\"}"), None, "JSON 명령 ≠ 터널 요청");
    assert_eq!(decode_tunnel_request(b"tunnel:"), None, "포트 누락 거부");
    assert_eq!(decode_tunnel_request(b"tunnel:abc"), None, "포트 길이 불량 거부");
    assert_eq!(decode_tunnel_request(b""), None, "빈 요청 거부(패닉 0)");
}

// ===========================================================================
// authorize_tunnel 단위 — SSRF/스코프/기기결속/페어링 게이트(connect 이전, in-memory).
// ===========================================================================

/// authorize_tunnel 단위 테스트용 — 페어링된 registry + 서명 frame 을 만든다.
fn make_authz_inputs(
    phone_id: &str,
    phone_ed: &SigningKey,
    scope: Scope,
    port: u16,
    nonce_seed: u8,
) -> (CapabilityAssertion, Vec<u8>, Vec<u8>) {
    let mut nonce = [0u8; 32];
    nonce[0] = nonce_seed;
    nonce[15] = 0xAB;
    let assertion = CapabilityAssertion {
        device_id: phone_id.to_string(),
        scope,
        nonce,
        issued_at: 100,
        exp: 1000,
    };
    let sig = phone_ed.sign(&assertion.canonical_bytes()).to_bytes().to_vec();
    let request = encode_tunnel_request(port);
    (assertion, sig, request)
}

fn paired_registry(phone_id: &str, phone_ed: &SigningKey, granted: Scope) -> DeviceRegistry {
    let mut reg = DeviceRegistry::new(4);
    reg.pair(phone_id, &phone_ed.verifying_key().to_bytes(), granted).unwrap();
    reg
}

#[test]
fn authorize_refuses_non_allowlisted_port_no_connect() {
    // SSRF: allowlist 밖 포트 ⇒ PortNotAllowed. (이 함수는 connect 안 함 — connect 0 증명은 E2E 에서.)
    let phone_ed = ed_key(1);
    let mut reg = paired_registry("phone-a", &phone_ed, Scope::Write);
    let (a, sig, req) = make_authz_inputs("phone-a", &phone_ed, Scope::Write, 9999, 1);
    let allow = PortAllowlist::from_ports([3000]);
    let dec = authorize_tunnel(&a, &sig, &req, "phone-a", &mut reg, VerifyCtx { now: 200 }, &allow);
    match dec.denied() {
        Some(TunnelDenied::PortNotAllowed(p)) => assert_eq!(*p, 9999, "거부 포트 노출"),
        other => panic!("allowlist 밖 포트는 PortNotAllowed 거부여야 함, got {other:?}"),
    }
}

#[test]
fn authorize_grants_allowlisted_port() {
    let phone_ed = ed_key(1);
    let mut reg = paired_registry("phone-a", &phone_ed, Scope::Write);
    let (a, sig, req) = make_authz_inputs("phone-a", &phone_ed, Scope::Write, 3000, 1);
    let allow = PortAllowlist::from_ports([3000]);
    let dec = authorize_tunnel(&a, &sig, &req, "phone-a", &mut reg, VerifyCtx { now: 200 }, &allow);
    let g = dec.granted().expect("allowlist 안 포트는 Granted");
    assert_eq!(g.port(), 3000, "봉인 포트 = 요청 포트");
}

#[test]
fn authorize_read_only_phone_cannot_open_tunnel() {
    // scope: read-only 폰이 Write(터널) 요청 ⇒ auth 게이트 ScopeEscalation 거부(터널 0).
    let phone_ed = ed_key(1);
    let mut reg = paired_registry("phone-a", &phone_ed, Scope::ReadOnly); // read-only 만 부여.
    let (a, sig, req) = make_authz_inputs("phone-a", &phone_ed, Scope::Write, 3000, 1);
    let allow = PortAllowlist::from_ports([3000]);
    let dec = authorize_tunnel(&a, &sig, &req, "phone-a", &mut reg, VerifyCtx { now: 200 }, &allow);
    assert!(matches!(dec.denied(), Some(TunnelDenied::Unauthorized(_))), "read-only ⇒ Unauthorized(터널 0)");
}

#[test]
fn authorize_unpaired_device_denied() {
    // 미페어링(빈 registry) ⇒ Unauthorized(UnknownDevice). auth 게이트 재사용.
    let phone_ed = ed_key(1);
    let mut reg = DeviceRegistry::new(4); // 페어링 0.
    let (a, sig, req) = make_authz_inputs("phone-a", &phone_ed, Scope::Write, 3000, 1);
    let allow = PortAllowlist::from_ports([3000]);
    let dec = authorize_tunnel(&a, &sig, &req, "phone-a", &mut reg, VerifyCtx { now: 200 }, &allow);
    assert!(matches!(dec.denied(), Some(TunnelDenied::Unauthorized(_))), "미페어링 ⇒ Unauthorized");
}

#[test]
fn authorize_device_mismatch_denied() {
    // 채널 peer 와 assertion device_id 불일치 ⇒ DeviceMismatch(smuggling 차단). nonce 미소비.
    let phone_ed = ed_key(1);
    let mut reg = paired_registry("phone-a", &phone_ed, Scope::Write);
    let (a, sig, req) = make_authz_inputs("phone-a", &phone_ed, Scope::Write, 3000, 1);
    let allow = PortAllowlist::from_ports([3000]);
    // peer_device_id = "phone-b" 인데 assertion 은 "phone-a".
    let dec = authorize_tunnel(&a, &sig, &req, "phone-b", &mut reg, VerifyCtx { now: 200 }, &allow);
    assert!(matches!(dec.denied(), Some(TunnelDenied::DeviceMismatch)), "기기 불일치 ⇒ DeviceMismatch");
}

#[test]
fn authorize_forged_signature_denied() {
    // 위조 서명(타키) ⇒ Unauthorized(BadSignature). verify_strict 재사용.
    let phone_ed = ed_key(1);
    let other_ed = ed_key(9);
    let mut reg = paired_registry("phone-a", &phone_ed, Scope::Write);
    let (a, _good_sig, req) = make_authz_inputs("phone-a", &phone_ed, Scope::Write, 3000, 1);
    let forged = other_ed.sign(&a.canonical_bytes()).to_bytes().to_vec(); // 다른 키 서명.
    let allow = PortAllowlist::from_ports([3000]);
    let dec = authorize_tunnel(&a, &forged, &req, "phone-a", &mut reg, VerifyCtx { now: 200 }, &allow);
    assert!(matches!(dec.denied(), Some(TunnelDenied::Unauthorized(_))), "위조 서명 ⇒ Unauthorized");
}

#[test]
fn authorize_malformed_request_denied_nonce_preserved() {
    // 터널 요청 형식 불량(JSON 명령 모양) ⇒ MalformedRequest. nonce 미소비(재사용 가능).
    let phone_ed = ed_key(1);
    let mut reg = paired_registry("phone-a", &phone_ed, Scope::Write);
    let (a, sig, _req) = make_authz_inputs("phone-a", &phone_ed, Scope::Write, 3000, 1);
    let bad_req = b"{\"method\":\"panel.close\"}".to_vec(); // 명령 모양 — 터널 요청 아님.
    let allow = PortAllowlist::from_ports([3000]);
    let dec = authorize_tunnel(&a, &sig, &bad_req, "phone-a", &mut reg, VerifyCtx { now: 200 }, &allow);
    assert!(matches!(dec.denied(), Some(TunnelDenied::MalformedRequest)), "형식 불량 ⇒ MalformedRequest");
    // nonce 미소비 단언 — 같은 nonce 로 올바른 요청을 다시 내면 통과해야 한다(소비 안 됨).
    let good_req = encode_tunnel_request(3000);
    let dec2 = authorize_tunnel(&a, &sig, &good_req, "phone-a", &mut reg, VerifyCtx { now: 200 }, &allow);
    assert!(dec2.is_granted(), "MalformedRequest 는 nonce 를 태우지 않는다(재사용 통과)");
}

#[test]
fn authorize_replayed_nonce_denied_second_time() {
    // 같은 nonce 재사용(replay) ⇒ 두 번째는 Unauthorized(NonceReplay). auth nonce 원장 재사용.
    let phone_ed = ed_key(1);
    let mut reg = paired_registry("phone-a", &phone_ed, Scope::Write);
    let (a, sig, req) = make_authz_inputs("phone-a", &phone_ed, Scope::Write, 3000, 1);
    let allow = PortAllowlist::from_ports([3000]);
    let d1 = authorize_tunnel(&a, &sig, &req, "phone-a", &mut reg, VerifyCtx { now: 200 }, &allow);
    assert!(d1.is_granted(), "첫 사용 통과");
    let d2 = authorize_tunnel(&a, &sig, &req, "phone-a", &mut reg, VerifyCtx { now: 200 }, &allow);
    assert!(matches!(d2.denied(), Some(TunnelDenied::Unauthorized(_))), "재생 nonce ⇒ Unauthorized");
}

#[test]
fn authorize_does_not_mutate_allowlist_phone_cannot_escalate() {
    // phone-cannot-escalate: authorize_tunnel 은 &PortAllowlist(불변)만 받는다 — 어떤 frame 도
    // allowlist 를 바꿀 수 없다. 거부 후에도 allowlist 는 그대로(타입 시스템이 mutate 를 막는다).
    let phone_ed = ed_key(1);
    let mut reg = paired_registry("phone-a", &phone_ed, Scope::Write);
    let (a, sig, req) = make_authz_inputs("phone-a", &phone_ed, Scope::Write, 9999, 1); // allowlist 밖.
    let allow = PortAllowlist::from_ports([3000]);
    let before = allow.allowed_ports();
    let _ = authorize_tunnel(&a, &sig, &req, "phone-a", &mut reg, VerifyCtx { now: 200 }, &allow);
    assert_eq!(allow.allowed_ports(), before, "터널 요청이 allowlist 를 바꾸지 못함(anti-escalation)");
    assert!(!allow.is_allowed(9999), "폰이 요청한 포트가 allowlist 에 추가되지 않음");
}

// ===========================================================================
// connect_local — loopback-only 단언(non-127.0.0.1 도달 경로 0).
// ===========================================================================

#[tokio::test]
async fn connect_local_targets_loopback_only() {
    // loopback-only: 떠 있는 로컬 서버에 connect 후, peer_addr 가 127.0.0.1 임을 단언(연결 타겟 = loopback).
    let (port, _h) = spawn_local_http("ok".into(), false).await;
    let grant = TunnelGrant_for_test("phone-a", port);
    let stream = connect_local(&grant).await.expect("loopback connect");
    let peer = stream.peer_addr().unwrap();
    assert!(peer.ip().is_loopback(), "connect 타겟은 항상 loopback(127.0.0.1)");
    assert_eq!(peer.ip(), std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), "정확히 127.0.0.1");
    assert_eq!(peer.port(), port, "봉인 포트로 connect");
}

#[tokio::test]
async fn connect_local_unlistening_port_clean_error_no_panic() {
    // graceful: 로컬 포트가 안 떠 있으면 LocalConnect clean 에러(패닉 0).
    // 안 떠 있을 포트 확보 — 임시 리스너를 띄웠다 즉시 닫아 그 포트를 비운다.
    let l = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let dead_port = l.local_addr().unwrap().port();
    drop(l); // 포트 비움.
    let grant = TunnelGrant_for_test("phone-a", dead_port);
    let r = connect_local(&grant).await;
    assert!(matches!(r, Err(ProxyError::LocalConnect(_))), "미기동 포트 ⇒ LocalConnect 에러(패닉 0)");
}

/// 테스트 전용 — 임의 포트로 TunnelGrant 를 만든다(authorize_tunnel 없이 connect_local 단위 검증).
#[allow(non_snake_case)]
fn TunnelGrant_for_test(device_id: &str, port: u16) -> TunnelGrant {
    // TunnelGrant 필드는 private 이나, 같은 모듈(tests = child)에서 super 의 private 생성 헬퍼를
    // 쓸 수 없으므로 authorize_tunnel 의 봉인을 거치지 않는 테스트 전용 경로가 필요하다 —
    // 그래서 grant_for_test 를 super 에 둔다(아래 tunnel.rs 의 #[cfg(test)] pub(super) 헬퍼).
    super::grant_for_test(device_id, port)
}

// ===========================================================================
// E2E — REAL HTTP over REAL serve_tunnel over REAL socket(suite E 핵심).
// ===========================================================================

/// 폰 TunnelStream 으로 HTTP 요청을 보내고 전체 응답을 모은다(EOF 까지 recv 반복).
async fn http_round_trip(
    tunnel: &mut crate::remote::client::TunnelStream<TcpStream>,
    request: &[u8],
) -> Vec<u8> {
    tunnel.send(request).await.expect("send HTTP request");
    tunnel.finish_sending().await.expect("finish sending");
    let mut got = Vec::new();
    while let Some(chunk) = tunnel.recv().await.expect("recv") {
        got.extend_from_slice(&chunk);
    }
    got
}

#[tokio::test]
async fn positive_allowlisted_port_http_round_trips_decrypted() {
    // POSITIVE(suite E 핵심): allowlist 된 포트 ⇒ REAL HTTP GET 이 터널을 통해 로컬 서버에 닿고
    // 응답이 폰까지 복호되어 왕복한다. RED(방어 전): 프록시 안 됨/평문 노출.
    let body = "Hello from dev-server".to_string();
    let (port, _http) = spawn_local_http(body.clone(), false).await;

    let phone = DeviceIdentity::generate("phone-a").unwrap();
    let (addr, desktop_pub, _srv) =
        spawn_serve_tunnel(&phone, Scope::Write, PortAllowlist::from_ports([port])).await;

    let session = phone_session(addr, &desktop_pub, &phone)
        .await
        .expect("핸드셰이크 성립(페어링됨)");
    let mut tunnel = session.open_tunnel(port, 1000, 100).await.expect("터널 인가(allowlist 안)");

    let resp = http_round_trip(&mut tunnel, b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n").await;
    let text = String::from_utf8_lossy(&resp);
    assert!(text.starts_with("HTTP/1.1 200 OK"), "HTTP 응답 헤더 왕복: {text}");
    assert!(text.contains(&body), "응답 본문이 폰까지 복호되어 도달: {text}");
}

#[tokio::test]
async fn ssrf_non_allowlisted_port_refused_no_connect() {
    // SSRF: 폰이 allowlist 밖 포트로 터널 요청 ⇒ NAK 거부, 그 포트에 TcpStream::connect 시도 0.
    // RED(방어 전): 임의 포트로 connect(피벗).
    //
    // connect 0 증명: 우리가 "함정 서버"를 그 포트에 띄우고, 터널 시도 후 함정이 **연결을 받지
    // 않았음**을 단언한다(accept 가 안 일어남 = connect 0).
    let trap = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let trap_port = trap.local_addr().unwrap().port();
    let trap_hit = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let trap_hit2 = Arc::clone(&trap_hit);
    let trap_handle = tokio::spawn(async move {
        // 짧은 시간 동안 accept 시도 — 터널이 connect 하면 여기서 잡힌다(그래선 안 됨).
        let accept = trap.accept();
        match tokio::time::timeout(std::time::Duration::from_millis(400), accept).await {
            Ok(Ok(_)) => trap_hit2.store(true, std::sync::atomic::Ordering::SeqCst),
            _ => {}
        }
    });

    let phone = DeviceIdentity::generate("phone-a").unwrap();
    // allowlist 에 trap_port 가 **없다**(다른 포트만 허용).
    let (addr, desktop_pub, _srv) = spawn_serve_tunnel(
        &phone,
        Scope::Write,
        PortAllowlist::from_ports([trap_port.wrapping_add(1)]), // trap_port 제외.
    )
    .await;

    let session = phone_session(addr, &desktop_pub, &phone)
        .await
        .expect("핸드셰이크 성립");
    // trap_port 로 터널 요청 — allowlist 밖이라 NAK 여야 한다.
    let r = session.open_tunnel(trap_port, 1000, 100).await;
    assert!(matches!(r, Err(ClientError::TunnelDenied)), "allowlist 밖 ⇒ TunnelDenied(NAK)");

    let _ = trap_handle.await;
    assert!(
        !trap_hit.load(std::sync::atomic::Ordering::SeqCst),
        "allowlist 밖 포트에 connect 시도 0(함정 서버가 연결을 받지 않음) — SSRF 0"
    );
}

#[tokio::test]
async fn ssrf_unpaired_peer_no_tunnel() {
    // 미페어링 peer ⇒ Noise 핸드셰이크 미성립 ⇒ 터널 0(채널이 안 생긴다).
    // RED(방어 전): 미페어링에 터널 열림.
    let (port, _http) = spawn_local_http("x".into(), false).await;
    // 서버는 phone-a 를 페어링하지만, 폰은 **다른 신원**(미페어링)으로 연결을 시도한다.
    let paired = DeviceIdentity::generate("phone-a").unwrap();
    let (addr, desktop_pub, _srv) =
        spawn_serve_tunnel(&paired, Scope::Write, PortAllowlist::from_ports([port])).await;
    // 같은 device_id 지만 **다른 키쌍**(미핀닝) — 서버가 핀닝한 키와 불일치 ⇒ KK 미성립.
    let imposter = DeviceIdentity::generate("phone-a").unwrap();
    let r = phone_session(addr, &desktop_pub, &imposter).await;
    assert!(matches!(r, Err(ClientError::Handshake(_))), "미페어링(틀린 키) ⇒ 핸드셰이크 미성립(터널 0)");
}

#[tokio::test]
async fn confidentiality_http_bytes_not_plaintext_on_wire() {
    // 기밀성: 프록시되는 HTTP 바이트가 와이어 ciphertext 에 평문으로 안 보인다(릴레이 zero-knowledge).
    // RED(방어 전): 평문이 와이어에 노출. 여기선 폰↔서버 사이에 **스니퍼 프록시**를 끼워 바이트를 가로채
    // 본문 마커가 평문으로 안 보임을 단언한다.
    let marker = "SECRET-MARKER-9f3a-confidential";
    let body = format!("response body containing {marker} inline");
    let (port, _http) = spawn_local_http(body.clone(), false).await;

    let phone = DeviceIdentity::generate("phone-a").unwrap();
    let (real_addr, desktop_pub, _srv) =
        spawn_serve_tunnel(&phone, Scope::Write, PortAllowlist::from_ports([port])).await;

    // 스니퍼 — 폰과 서버 사이에 끼어 양방향 바이트를 복사하면서 전부 캡처(릴레이 흉내).
    let sniff_listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let sniff_addr = sniff_listener.local_addr().unwrap();
    let captured = Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
    let captured2 = Arc::clone(&captured);
    tokio::spawn(async move {
        if let Ok((client_side, _)) = sniff_listener.accept().await {
            let server_side = TcpStream::connect(real_addr).await.unwrap();
            relay_and_capture(client_side, server_side, captured2).await;
        }
    });

    // 폰은 스니퍼를 통해 연결(스니퍼가 real 서버로 forward).
    let marker_req = format!("GET /{marker} HTTP/1.1\r\nHost: localhost\r\n\r\n");
    let session = phone_session(sniff_addr, &desktop_pub, &phone)
        .await
        .expect("핸드셰이크 성립");
    let mut tunnel = session.open_tunnel(port, 1000, 100).await.expect("터널 인가");
    let resp = http_round_trip(&mut tunnel, marker_req.as_bytes()).await;
    assert!(String::from_utf8_lossy(&resp).contains(marker), "응답이 폰까지 복호되어 마커 포함");

    // 스니퍼가 캡처한 와이어 바이트에 마커가 **평문으로 없어야** 한다(요청·응답 둘 다 ciphertext).
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let wire = captured.lock().unwrap().clone();
    assert!(!wire.is_empty(), "스니퍼가 와이어 바이트를 캡처함");
    assert!(
        !contains_subslice(&wire, marker.as_bytes()),
        "와이어 ciphertext 에 평문 마커가 없다(E2E — 릴레이 zero-knowledge)"
    );
}

#[tokio::test]
async fn bidirectional_multi_chunk_response_streams() {
    // 양방향 + 스트리밍: 멀티-청크 응답이 (한 왕복이 아니라) 연속 스트리밍으로 폰까지 도달.
    // RED(방어 전): 첫 청크만 옴/뒤 청크 유실.
    let big = "ABCDEFGH".repeat(2000); // 16KB — 멀티-청크 강제(서버가 두 조각으로 보냄).
    let (port, _http) = spawn_local_http(big.clone(), true).await;

    let phone = DeviceIdentity::generate("phone-a").unwrap();
    let (addr, desktop_pub, _srv) =
        spawn_serve_tunnel(&phone, Scope::Write, PortAllowlist::from_ports([port])).await;
    let session = phone_session(addr, &desktop_pub, &phone)
        .await
        .expect("핸드셰이크 성립");
    let mut tunnel = session.open_tunnel(port, 1000, 100).await.expect("터널 인가");
    let resp = http_round_trip(&mut tunnel, b"GET /big HTTP/1.1\r\nHost: localhost\r\n\r\n").await;
    let text = String::from_utf8_lossy(&resp);
    assert!(text.contains(&big), "멀티-청크 본문 전체가 스트리밍으로 도달(유실 0)");
    assert!(text.len() > big.len(), "헤더+본문 = 본문보다 큼(전체 응답 도달)");
}

#[tokio::test]
async fn graceful_local_not_listening_clean_error_no_panic() {
    // graceful: allowlist 에 있으나 로컬 dev-server 가 안 떠 있으면 ⇒ NAK(clean), 폰은 TunnelDenied.
    // RED(방어 전): 패닉/hang.
    let l = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let dead_port = l.local_addr().unwrap().port();
    drop(l); // 포트 비움(아무도 안 들음).

    let phone = DeviceIdentity::generate("phone-a").unwrap();
    let (addr, desktop_pub, _srv) = spawn_serve_tunnel(
        &phone,
        Scope::Write,
        PortAllowlist::from_ports([dead_port]), // allowlist 안이지만 미기동.
    )
    .await;
    let session = phone_session(addr, &desktop_pub, &phone)
        .await
        .expect("핸드셰이크 성립");
    let r = session.open_tunnel(dead_port, 1000, 100).await;
    assert!(matches!(r, Err(ClientError::TunnelDenied)), "로컬 미기동 ⇒ NAK(TunnelDenied), 패닉/hang 0");
}

#[tokio::test]
async fn read_only_phone_tunnel_denied_e2e() {
    // E2E scope: read-only 만 부여된 폰이 터널 시도 ⇒ NAK(서버 auth 게이트 scope 거부). 터널 0.
    let (port, _http) = spawn_local_http("x".into(), false).await;
    let phone = DeviceIdentity::generate("phone-a").unwrap();
    let (addr, desktop_pub, _srv) = spawn_serve_tunnel(
        &phone,
        Scope::ReadOnly, // read-only 만 — 터널(Write)은 거부돼야.
        PortAllowlist::from_ports([port]),
    )
    .await;
    let session = phone_session(addr, &desktop_pub, &phone)
        .await
        .expect("핸드셰이크 성립");
    let r = session.open_tunnel(port, 1000, 100).await;
    assert!(matches!(r, Err(ClientError::TunnelDenied)), "read-only 폰 ⇒ 터널 거부(scope 게이트)");
}

// ===========================================================================
// 와이어 캡처 유틸 — 스니퍼(릴레이 흉내) + 부분 슬라이스 검색.
// ===========================================================================

/// 양방향 바이트를 복사하면서 **양쪽 모두** captured 에 기록한다(릴레이가 보는 와이어 전부).
async fn relay_and_capture(
    client_side: TcpStream,
    server_side: TcpStream,
    captured: Arc<std::sync::Mutex<Vec<u8>>>,
) {
    let (mut cr, mut cw) = tokio::io::split(client_side);
    let (mut sr, mut sw) = tokio::io::split(server_side);
    let cap1 = Arc::clone(&captured);
    let cap2 = Arc::clone(&captured);
    let c2s = async move {
        let mut buf = [0u8; 4096];
        loop {
            match cr.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    cap1.lock().unwrap().extend_from_slice(&buf[..n]);
                    if sw.write_all(&buf[..n]).await.is_err() {
                        break;
                    }
                    let _ = sw.flush().await;
                }
            }
        }
    };
    let s2c = async move {
        let mut buf = [0u8; 4096];
        loop {
            match sr.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    cap2.lock().unwrap().extend_from_slice(&buf[..n]);
                    if cw.write_all(&buf[..n]).await.is_err() {
                        break;
                    }
                    let _ = cw.flush().await;
                }
            }
        }
    };
    tokio::join!(c2s, s2c);
}

/// haystack 안에 needle 이 연속 부분으로 있는가(평문 노출 검사).
fn contains_subslice(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || haystack.len() < needle.len() {
        return false;
    }
    haystack.windows(needle.len()).any(|w| w == needle)
}

// ===========================================================================
// bridge glue — off-by-default + allowlist=데스크톱 env 단일 진실(RULE 8 observable, anti-escalation).
// ===========================================================================

#[test]
fn tunnel_bridge_disabled_by_default() {
    // off-by-default: enable env 미설정 ⇒ 비활성(어떤 터널 리스너도 안 뜬다). 순수 함수 단언.
    std::env::remove_var(crate::remote::bridge::TUNNEL_ENABLE_ENV);
    assert!(
        !crate::remote::bridge::tunnel_enabled(),
        "tunnel enable env 미설정 ⇒ 비활성(off by default — bind 0)"
    );
}

#[test]
fn tunnel_allowlist_comes_only_from_desktop_env_observable() {
    // allowlist 는 **데스크톱 env 단일 진실**(RULE 8 observable, anti-escalation — 폰은 못 바꾼다).
    // env 미설정 ⇒ 빈 allowlist(fail-closed: 모든 터널 거부). 설정 ⇒ 그 포트만.
    std::env::remove_var(crate::remote::bridge::TUNNEL_ALLOWLIST_ENV);
    assert!(
        crate::remote::bridge::tunnel_allowlist().is_empty(),
        "allowlist env 미설정 ⇒ 빈 집합(fail-closed)"
    );
    // 데스크톱이 env 로 설정 — 그 포트만 관측 가능(observable). 파싱 불가 토큰/0 은 무시.
    std::env::set_var(crate::remote::bridge::TUNNEL_ALLOWLIST_ENV, "3000, 5173 ,0,bad,8080");
    let al = crate::remote::bridge::tunnel_allowlist();
    std::env::remove_var(crate::remote::bridge::TUNNEL_ALLOWLIST_ENV); // 즉시 청소(다른 테스트 오염 0).
    assert_eq!(al.allowed_ports(), vec![3000, 5173, 8080], "데스크톱 env 의 유효 포트만(0/bad 무시)");
}

// ===========================================================================
// proptest 적대 하니스 — tunnel 의 length-prefix 코덱(proxy 프레이밍)과 proxy 루프가 임의·
// 경계·malformed·청크 입력에 패닉 0·over-read 0·증폭 0·행 0(계획서 스위트 I, SSRF/DoS).
// read_framed/MAX_FRAME 는 tunnel 모듈 private 이라 super::* 로만 직접 fuzz 가능하다.
// ===========================================================================
use proptest::prelude::*;
use crate::remote::noise::{Handshake as NoiseHandshake, NoiseChannel, PinnedPeerRegistry as PPR, StaticKeypair as SKP};

/// 임의 바이트에 tunnel::read_framed 를 1회 돌린다(bounded — &[u8] EOF 확정, 행 0).
fn tunnel_read_one(bytes: &[u8]) -> Result<Option<Vec<u8>>, ProxyError> {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async move {
        let mut cur: &[u8] = bytes;
        read_framed(&mut cur).await
    })
}

/// KK 핸드셰이크를 끝까지 돌려 양측 NoiseChannel 을 만든다(proxy 입력 암호화에 필요).
fn tunnel_channel_pair() -> (NoiseChannel, NoiseChannel) {
    let a = SKP::generate().unwrap();
    let b = SKP::generate().unwrap();
    let mut ar = PPR::new();
    ar.pin("phone", &b.public_key()).unwrap();
    let mut br = PPR::new();
    br.pin("desktop", &a.public_key()).unwrap();
    let mut ini = NoiseHandshake::initiate(&a, &ar, "phone").unwrap();
    let mut resp = NoiseHandshake::respond(&b, &br, "desktop").unwrap();
    let m1 = ini.write_message().unwrap();
    resp.read_message(&m1).unwrap();
    let m2 = resp.write_message().unwrap();
    ini.read_message(&m2).unwrap();
    (ini.into_channel().unwrap(), resp.into_channel().unwrap())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1024))]

    /// tunnel_framing_arbitrary_never_panic_no_amplification:
    /// 임의 바이트 → tunnel::read_framed 는 패닉 0. 캡 초과 길이 ⇒ Io(InvalidData)(그만큼 할당 0).
    /// Ok(Some(body)) 면 body ≤ 캡 + 입력 안(증폭 0).
    #[test]
    fn tunnel_framing_arbitrary_never_panic_no_amplification(
        bytes in proptest::collection::vec(any::<u8>(), 0..4096),
    ) {
        match tunnel_read_one(&bytes) {
            Ok(Some(body)) => {
                prop_assert!(body.len() <= MAX_FRAME);
                prop_assert!(body.len() + 4 <= bytes.len(), "body+prefix fits input (no amplification)");
            }
            Ok(None) => {}
            Err(ProxyError::Io(_)) => {} // 캡 초과/잘림 — graceful.
            Err(_) => {}
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// tunnel_framing_oversize_prefix_rejected_without_allocating:
    /// 캡+1..u32::MAX 길이 프리픽스 ⇒ 반드시 Io 에러(그 길이만큼 할당/행 0).
    #[test]
    fn tunnel_framing_oversize_prefix_rejected_without_allocating(
        len in (MAX_FRAME as u32 + 1)..=u32::MAX,
    ) {
        let mut wire = Vec::new();
        wire.extend_from_slice(&len.to_be_bytes());
        wire.push(0u8);
        prop_assert!(matches!(tunnel_read_one(&wire), Err(ProxyError::Io(_))), "oversize prefix must error");
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(128))]

    /// proxy_arbitrary_inbound_chunks_terminate_no_hang_no_panic:
    /// 폰→dev-server 방향에 **임의 청크들**(일부는 valid ciphertext, 일부는 garbage frame)을 채널에
    /// 흘린다. proxy 는 garbage ciphertext 를 만나면 ProxyError::Decrypt 로 fail-closed 종료(평문 0),
    /// valid 빈 평문은 EOF 신호로 graceful 처리. 어느 입력이든 bounded 종료(행 0)·패닉 0. local 측은
    /// duplex 의 한쪽(dev-server 흉내) — proxy 가 local 로 write 하다 끊겨도 graceful.
    #[test]
    fn proxy_arbitrary_inbound_chunks_terminate_no_hang_no_panic(
        chunks in proptest::collection::vec(proptest::collection::vec(any::<u8>(), 0..64), 0..6),
        garbage_at in proptest::collection::vec(any::<bool>(), 0..6),
    ) {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let res = rt.block_on(async move {
            // (phone_ch=폰 측 암호화, server_ch=proxy 가 쓸 복호 채널).
            let (mut phone_ch, server_ch) = tunnel_channel_pair();
            // 채널 와이어: 폰이 쓰고 proxy 가 읽는다.
            let (chan_to_proxy_w, chan_to_proxy_r) = tokio::io::duplex(8192);
            let (proxy_to_chan_w, _proxy_to_chan_r) = tokio::io::duplex(8192);
            // local: dev-server 흉내 — proxy 가 write/ read 하는 한쪽.
            let (local_a, _local_b) = tokio::io::duplex(8192);

            // 폰 측: 각 청크를 암호화(또는 garbage 로 망가뜨려) 길이-프리픽스로 채널에 쓴다.
            let mut writer = chan_to_proxy_w;
            for (i, c) in chunks.iter().enumerate() {
                let ct = phone_ch.encrypt(c).unwrap();
                let frame = if garbage_at.get(i).copied().unwrap_or(false) {
                    // ciphertext 를 변조 — proxy decrypt 가 Decrypt 로 막아야 한다.
                    let mut g = ct.clone();
                    if let Some(b) = g.first_mut() { *b ^= 0xFF; }
                    g
                } else {
                    ct
                };
                let len = (frame.len() as u32).to_be_bytes();
                use tokio::io::AsyncWriteExt as _;
                let _ = writer.write_all(&len).await;
                let _ = writer.write_all(&frame).await;
            }
            drop(writer); // 채널 EOF — proxy inbound 가 None 을 받아 graceful 종료.

            // proxy 를 돌린다 — server_ch 로 복호, local_a 로 write. bounded 종료해야 한다.
            let proxy_fut = proxy(chan_to_proxy_r, proxy_to_chan_w, server_ch, local_a);
            tokio::time::timeout(std::time::Duration::from_secs(5), proxy_fut).await
        });
        // 타임아웃 0(행 아님). proxy 반환은 Ok 또는 typed ProxyError(Decrypt 등) — 둘 다 graceful.
        prop_assert!(res.is_ok(), "proxy must terminate (no hang) on arbitrary inbound chunks");
    }
}
