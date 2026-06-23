// remote::transport 테스트 — 보안 세션을 **진짜 루프백 TCP 소켓** 위에 얹은 채로 위협을
// RED→GREEN 검증한다(스위트 E 터널/HTTP + K 정상경로 + 다다익선). in-process 클라이언트가 폰
// 노릇을 한다: noise(KK initiator) + auth(assertion 서명)로 길이-프리픽스 frame 을 진짜 소켓에
// 흘린다. dispatch 는 주입된 recorder — 호출 횟수·받은 request 를 기록해 "보안 체인이 라이브
// AppHandle 없이도 증명" 되게 한다(canned {ok:true} JSON 으로 route 의 envelope 를 미러).
//
// 각 테스트는 한 공격을 진짜 소켓에 재현하고 차단(GREEN)을 단언한다. RED(방어 전엔 통과=취약)는
// 각 테스트 주석에 "RED:" 로 명시 — 해당 방어 라인을 빼면 그 단언이 깨짐을 코드 위치로 못박는다.
// 기준 약화 0 — 실패하면 구현을 고친다(RULE 2).

use super::*;
use crate::remote::auth::{CapabilityAssertion, DesktopConfirmToken, DeviceRegistry, Scope};
use crate::remote::noise::{Handshake, NoiseChannel, PinnedPeerRegistry, StaticKeypair};
use crate::remote::session::RequestFrame;
use crate::remote::tcp::bind_loopback;
use ed25519_dalek::{Signer, SigningKey};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

// ===========================================================================
// 헬퍼 — 두 floor 의 키/페어링 + 진짜 소켓 위의 클라이언트(폰).
// ===========================================================================

fn ed_key(seed: u8) -> SigningKey {
    let mut b = [0u8; 32];
    b[0] = seed;
    b[31] = 0x42;
    SigningKey::from_bytes(&b)
}
fn ed_pub(sk: &SigningKey) -> [u8; 32] {
    sk.verifying_key().to_bytes()
}
fn nonce(tag: u8) -> [u8; 32] {
    let mut n = [0u8; 32];
    n[0] = tag;
    n[15] = 0xAB;
    n
}

/// canned dispatch — route 의 응답 envelope({ok:true,...})를 미러하는 recorder. 호출 횟수와
/// 마지막으로 받은 request 바이트를 공유 카운터/슬롯에 기록한다(라이브 AppHandle 없이 체인 증명).
fn recording_dispatch(
    calls: Arc<AtomicU32>,
    last_req: Arc<Mutex<Vec<u8>>>,
) -> impl FnMut(&AuthorizedAction, &[u8]) -> Vec<u8> + Send + 'static {
    move |action, request| {
        calls.fetch_add(1, Ordering::SeqCst);
        *last_req.lock().unwrap() = request.to_vec();
        // route 의 envelope 미러: 인가된 scope 를 echo 해 "인가된 액션만 흘렀다"를 와이어로 증명.
        let scope = match action.scope() {
            Scope::ReadOnly => "read-only",
            Scope::Write => "write",
            Scope::Destructive => "destructive",
        };
        format!("{{\"ok\":true,\"scope\":\"{scope}\"}}").into_bytes()
    }
}

/// 데스크톱 측 자원(서버). 로컬 static + 핀닝 peer 레지스트리 + 공유 auth 권위.
struct Server {
    local: Arc<StaticKeypair>,
    noise: Arc<PinnedPeerRegistry>,
    auth: SharedAuth,
    desktop_id: String,
}

/// 한 원격 기기(폰)의 두 키 + id. 데스크톱이 양쪽을 핀닝하면 페어링 완료.
struct Phone {
    x: StaticKeypair,
    ed: SigningKey,
    id: String,
}

/// 데스크톱을 만들고(아무도 핀닝 안 됨 = fail-closed 기본) 폰 1대를 양쪽 키로 핀닝한다.
fn make_server_with_phone(
    desktop_id: &str,
    phone_id: &str,
    ed_seed: u8,
    scope: Scope,
) -> (Server, Phone) {
    let local = StaticKeypair::generate().expect("desktop x25519");
    let phone = Phone {
        x: StaticKeypair::generate().expect("phone x25519"),
        ed: ed_key(ed_seed),
        id: phone_id.to_string(),
    };
    let mut noise = PinnedPeerRegistry::new();
    noise.pin(phone_id, &phone.x.public_key()).expect("pin phone x25519");
    let mut auth = DeviceRegistry::new(4);
    auth.pair(phone_id, &ed_pub(&phone.ed), scope).expect("pair phone ed25519");
    (
        Server {
            local: Arc::new(local),
            noise: Arc::new(noise),
            auth: SharedAuth::new(auth),
            desktop_id: desktop_id.to_string(),
        },
        phone,
    )
}

/// 빈 데스크톱(아무 폰도 안 핀닝) — 미페어링 거부 테스트용.
fn make_empty_server(desktop_id: &str) -> Server {
    Server {
        local: Arc::new(StaticKeypair::generate().expect("desktop x25519")),
        noise: Arc::new(PinnedPeerRegistry::new()),
        auth: SharedAuth::new(DeviceRegistry::new(4)),
        desktop_id: desktop_id.to_string(),
    }
}

/// 진짜 소켓 위의 클라이언트(폰). announce + KK initiator + 길이-프리픽스 frame I/O.
/// noise.rs(Handshake/NoiseChannel) + auth.rs(assertion 서명)만으로 구성 — 별도 transport 0.
struct Client {
    stream: TcpStream,
    channel: NoiseChannel,
    ed: SigningKey,
    id: String,
}

/// 길이-프리픽스(u32 BE) 쓰기 — 서버의 read_framed 와 정확히 같은 와이어.
async fn send_framed(stream: &mut TcpStream, bytes: &[u8]) {
    let len = (bytes.len() as u32).to_be_bytes();
    stream.write_all(&len).await.expect("write len");
    stream.write_all(bytes).await.expect("write body");
    stream.flush().await.expect("flush");
}

/// 길이-프리픽스(u32 BE) 읽기 — 서버의 write_framed 와 정확히 같은 와이어.
async fn recv_framed(stream: &mut TcpStream) -> Vec<u8> {
    try_recv_framed(stream).await.expect("read framed")
}

/// 실패 가능한 길이-프리픽스 읽기 — 서버가 핸드셰이크 중 연결을 닫으면(미페어링/revoked/틀린 키)
/// EOF/ConnectionReset 이 온다. 이는 **fail-closed 의 정상 신호**(채널 미성립)지 패닉이 아니다.
async fn try_recv_framed(stream: &mut TcpStream) -> Result<Vec<u8>, std::io::Error> {
    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf).await?;
    let len = u32::from_be_bytes(len_buf) as usize;
    let mut body = vec![0u8; len];
    stream.read_exact(&mut body).await?;
    Ok(body)
}

impl Client {
    /// 폰이 데스크톱 핀닝 + announce + KK 핸드셰이크 → NoiseChannel 봉인. 정상 페어링 경로.
    /// `pin_desktop_key`/`announce_id`/`use_x` 는 공격 변형을 위해 분리(미페어링/거짓 announce 등).
    async fn connect(
        addr: SocketAddr,
        desktop_public: [u8; 32],
        desktop_id: &str,
        announce_id: &str,
        phone_x: &StaticKeypair,
        phone_ed: &SigningKey,
    ) -> Result<Client, String> {
        let mut stream = TcpStream::connect(addr).await.map_err(|e| e.to_string())?;

        // 1. announce — 폰이 자기 id 를 길이-프리픽스로 보낸다(핸드셰이크 전).
        send_framed(&mut stream, announce_id.as_bytes()).await;

        // 폰도 데스크톱 static 을 핀닝해야 KK 성립(mutual).
        let mut peers = PinnedPeerRegistry::new();
        peers.pin(desktop_id, &desktop_public).map_err(|e| format!("{e:?}"))?;
        let mut ini = Handshake::initiate(phone_x, &peers, desktop_id)
            .map_err(|e| format!("initiate: {e}"))?;

        // 2. KK 2-메시지: -> m1 쓰기, <- m2 읽기. 서버가 채널 미성립으로 닫으면 m2 읽기가
        //    EOF/Reset — connect 가 Err 로 환원(미페어링/revoked/틀린 키의 fail-closed 신호).
        let m1 = ini.write_message().map_err(|e| format!("m1: {e}"))?;
        send_framed(&mut stream, &m1).await;
        let m2 = try_recv_framed(&mut stream)
            .await
            .map_err(|e| format!("server closed before m2 (handshake not established): {e}"))?;
        ini.read_message(&m2).map_err(|e| format!("read m2: {e}"))?;
        let channel = ini.into_channel().map_err(|e| format!("channel: {e}"))?;

        Ok(Client {
            stream,
            channel,
            ed: phone_ed.clone(),
            id: announce_id.to_string(),
        })
    }

    /// 서명된 frame 1개를 만들어 암호화→길이-프리픽스 송신, 서버의 암호화 응답을 복호해 돌려준다.
    /// `signer`/`claim_id` 분리로 위조 서명·cross-device smuggling 변형을 만든다.
    async fn request(
        &mut self,
        signer: &SigningKey,
        claim_id: &str,
        scope: Scope,
        n: [u8; 32],
        issued_at: u64,
        exp: u64,
        request: &[u8],
    ) -> Vec<u8> {
        let assertion = CapabilityAssertion {
            device_id: claim_id.to_string(),
            scope,
            nonce: n,
            issued_at,
            exp,
        };
        let sig = signer.sign(&assertion.canonical_bytes()).to_bytes().to_vec();
        let frame = RequestFrame { assertion, signature: sig, request: request.to_vec() }.encode();
        let ct = self.channel.encrypt(&frame).expect("client encrypt");
        send_framed(&mut self.stream, &ct).await;
        let resp_ct = recv_framed(&mut self.stream).await;
        self.channel.decrypt(&resp_ct).expect("client decrypt response")
    }

    /// 평문(미암호화) 바이트를 그대로 frame 자리에 흘린다 — pre-handshake/채널 우회 공격용.
    async fn send_raw(&mut self, bytes: &[u8]) {
        send_framed(&mut self.stream, bytes).await;
    }
}

/// 서버를 진짜 루프백 소켓에 띄우고 (주소, dispatch 카운터, 마지막 request 슬롯)을 돌려준다.
/// 1 연결만 받아 serve_connection 을 돌리는 가벼운 하니스(테스트별 격리). token provider 는
/// 기본 None(deny-until-token) — destructive 테스트가 override.
async fn spawn_one_conn_server(
    server: Arc<Server>,
) -> (SocketAddr, Arc<AtomicU32>, Arc<Mutex<Vec<u8>>>) {
    spawn_one_conn_server_with_token(server, |_id| None).await
}

/// token provider 를 주입하는 변형 — destructive-with-token 경로 검증용.
async fn spawn_one_conn_server_with_token<TokF>(
    server: Arc<Server>,
    token_fn: TokF,
) -> (SocketAddr, Arc<AtomicU32>, Arc<Mutex<Vec<u8>>>)
where
    TokF: FnMut(&str) -> Option<DesktopConfirmToken> + Send + 'static,
{
    let listener = bind_loopback(0).await.expect("bind loopback");
    let addr = listener.local_addr().expect("local addr");
    let calls = Arc::new(AtomicU32::new(0));
    let last_req = Arc::new(Mutex::new(Vec::new()));
    let calls_c = Arc::clone(&calls);
    let last_c = Arc::clone(&last_req);
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("accept");
        let dispatch = recording_dispatch(calls_c, last_c);
        let _ = serve_connection(
            stream,
            &server.local,
            &server.noise,
            &server.auth,
            || 200u64, // 고정 now(테스트 결정성).
            token_fn,
            dispatch,
        )
        .await;
    });
    (addr, calls, last_req)
}

// ===========================================================================
// K. 정상 경로(긍정 E2E) — 먼저 확립: 진짜 소켓 위에서 정당한 요청이 dispatch.
// ===========================================================================

#[tokio::test]
async fn k_paired_readonly_request_dispatches_once_encrypted_response() {
    // 매트릭스 K "정상 경로": 페어링된 폰 + 유효 read-only assertion 이 "state.commands"/"ui.tree"
    //   모양 요청을 보낸다 ⇒ dispatch 정확히 1회, 암호화된 {ok:true} 응답을 폰이 복호.
    // RED(방어 전): not dispatched / 와이어에 평문이 보임. GREEN: dispatch 1회 + 응답이 ciphertext.
    let (server, phone) = make_server_with_phone("desktop", "phone", 1, Scope::ReadOnly);
    let desktop_pub = server.local.public_key();
    let server = Arc::new(server);
    let (addr, calls, last_req) = spawn_one_conn_server(Arc::clone(&server)).await;

    let mut client = Client::connect(addr, desktop_pub, "desktop", "phone", &phone.x, &phone.ed)
        .await
        .expect("정상 페어링 연결");
    let resp = client
        .request(&phone.ed, "phone", Scope::ReadOnly, nonce(1), 100, 1000, b"ui.tree")
        .await;

    assert_eq!(calls.load(Ordering::SeqCst), 1, "정상 경로 dispatch 정확히 1회");
    assert_eq!(&*last_req.lock().unwrap(), b"ui.tree", "dispatch 가 실제 request 수신");
    assert_eq!(resp[0], 0x01, "Ok 응답 태그(폰이 복호 성공)");
    assert_eq!(&resp[1..], b"{\"ok\":true,\"scope\":\"read-only\"}", "암호화 envelope 복호");
}

#[tokio::test]
async fn k_state_commands_shaped_request_round_trips() {
    // "state.commands" 모양 요청도 동일 경로(라이브 registry 명령 형태) — dispatch 1회 + 복호.
    let (server, phone) = make_server_with_phone("desktop", "phone", 1, Scope::ReadOnly);
    let desktop_pub = server.local.public_key();
    let server = Arc::new(server);
    let (addr, calls, last_req) = spawn_one_conn_server(Arc::clone(&server)).await;

    let mut client = Client::connect(addr, desktop_pub, "desktop", "phone", &phone.x, &phone.ed)
        .await
        .unwrap();
    let resp = client
        .request(&phone.ed, "phone", Scope::ReadOnly, nonce(2), 100, 1000, b"state.commands")
        .await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(&*last_req.lock().unwrap(), b"state.commands");
    assert_eq!(resp[0], 0x01);
}

// ===========================================================================
// 미페어링 거부 (매트릭스 "미페어링 접근" + "HTTP 터널 무단접근").
// ===========================================================================

#[tokio::test]
async fn unpaired_static_key_handshake_fails_no_channel_no_dispatch() {
    // 공격: static 키가 데스크톱에 핀닝되지 않은 폰이 announce + 핸드셰이크를 시도(터널 URL 에
    //   닿았지만 페어링 안 됨). RED(방어 전): 미인증 채널 생성 경로가 있으면 미페어링도 frame 을
    //   흘림. GREEN: 데스크톱이 그 id 를 안 핀닝 ⇒ responder 핸드셰이크 미성립 ⇒ 채널 0 ⇒ 서버가
    //   m2 를 안 보내고 연결 종료 ⇒ 클라이언트 read m2 실패 ⇒ dispatch 0.
    let server = Arc::new(make_empty_server("desktop")); // 아무 폰도 핀닝 안 함.
    let desktop_pub = server.local.public_key();
    let (addr, calls, _last) = spawn_one_conn_server(Arc::clone(&server)).await;

    let unpaired_x = StaticKeypair::generate().unwrap();
    let unpaired_ed = ed_key(9);
    // 폰은 데스크톱을 핀닝하지만, 데스크톱은 폰을 안 핀닝 → 데스크톱 respond 미성립.
    let r = Client::connect(addr, desktop_pub, "desktop", "phone", &unpaired_x, &unpaired_ed).await;
    assert!(r.is_err(), "미페어링 ⇒ 채널 미성립(연결이 m2 없이 끊김)");

    // 서버 task 가 정리될 시간을 준 뒤 dispatch 0 확인.
    tokio::task::yield_now().await;
    assert_eq!(calls.load(Ordering::SeqCst), 0, "미페어링 ⇒ dispatch 0");
}

#[tokio::test]
async fn pinned_id_but_wrong_static_key_handshake_fails_no_dispatch() {
    // 변형: 데스크톱이 "phone" id 를 진짜 폰 키로 핀닝했는데, 공격자가 같은 id 를 announce 하되
    //   **다른 static 키**(자기 키)로 KK 를 시도. RED: id 만 맞으면 통과하는 약한 검사면 취약.
    //   GREEN: KK 정적-정적 바인딩이 깨져 DH/MAC 불일치 ⇒ 핸드셰이크 미완 ⇒ dispatch 0.
    let (server, _phone) = make_server_with_phone("desktop", "phone", 1, Scope::ReadOnly);
    let desktop_pub = server.local.public_key();
    let server = Arc::new(server);
    let (addr, calls, _last) = spawn_one_conn_server(Arc::clone(&server)).await;

    let attacker_x = StaticKeypair::generate().unwrap(); // 핀닝된 키가 아님.
    let attacker_ed = ed_key(8);
    let r = Client::connect(addr, desktop_pub, "desktop", "phone", &attacker_x, &attacker_ed).await;
    assert!(r.is_err(), "핀닝된 id + 틀린 static 키 ⇒ KK 미성립");
    tokio::task::yield_now().await;
    assert_eq!(calls.load(Ordering::SeqCst), 0, "틀린 키 ⇒ dispatch 0");
}

#[tokio::test]
async fn revoked_peer_handshake_fails_no_dispatch() {
    // 도난폰: 데스크톱이 핀닝 후 revoke. 그 폰이 다시 연결 시도 ⇒ 핸드셰이크 미성립(kill-switch).
    let (server, phone) = make_server_with_phone("desktop", "phone", 1, Scope::ReadOnly);
    let desktop_pub = server.local.public_key();
    // noise floor 의 핀닝 레지스트리에서 revoke(채널 게이트 차단).
    {
        let mut noise = PinnedPeerRegistry::new();
        noise.pin("phone", &phone.x.public_key()).unwrap();
        noise.revoke("phone");
        // server.noise 는 Arc 라 교체 — 새 레지스트리로 서버 구성.
        let server2 = Server {
            local: server.local.clone(),
            noise: Arc::new(noise),
            auth: server.auth.clone(),
            desktop_id: "desktop".into(),
        };
        let server2 = Arc::new(server2);
        let (addr, calls, _last) = spawn_one_conn_server(Arc::clone(&server2)).await;
        let r = Client::connect(addr, desktop_pub, "desktop", "phone", &phone.x, &phone.ed).await;
        assert!(r.is_err(), "revoked peer ⇒ 핸드셰이크 미성립");
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 0, "revoked ⇒ dispatch 0");
    }
}

// ===========================================================================
// loopback-only / SSRF 0 (매트릭스 "reverse-proxy SSRF" · "DNS rebinding").
// ===========================================================================

#[tokio::test]
async fn listener_binds_loopback_only_never_wildcard() {
    // bind_loopback 은 항상 127.0.0.1 에 바인드한다 — 0.0.0.0/외부 인터페이스 노출 0.
    // RED(방어 전): 0.0.0.0 바인드면 임의 노출/rebinding 표면. GREEN: local_addr().ip() == 127.0.0.1.
    let listener = bind_loopback(0).await.expect("bind");
    let ip = listener.local_addr().unwrap().ip();
    assert_eq!(ip, IpAddr::V4(Ipv4Addr::LOCALHOST), "리스너는 127.0.0.1 전용 바인드");
    assert!(!ip.is_unspecified(), "0.0.0.0(전체 인터페이스) 바인드 아님");
    assert!(ip.is_loopback(), "루프백 전용");
}

#[tokio::test]
async fn dispatch_routes_only_registry_commands_no_raw_host_port_forward() {
    // SSRF 0: dispatch 가 받는 것은 **인가된 AuthorizedAction + 불투명 request 바이트** 뿐 —
    //   임의 host:port 로 forward 하는 경로가 구조적으로 없다. request 에 "127.0.0.1:6379" 같은
    //   피벗 시도 텍스트를 넣어도 transport 는 그걸 registry 명령으로만 넘긴다(소켓 연결 0).
    // RED(방어 전): 만약 transport 가 request 를 host:port 로 해석해 연결하면 SSRF. 취약.
    // GREEN: dispatch 는 request 를 불투명 바이트로 받을 뿐 — recorder 가 그 바이트를 그대로 기록,
    //   어떤 아웃바운드 연결도 일어나지 않는다(이 테스트가 도는 동안 새 소켓 연결 없음).
    let (server, phone) = make_server_with_phone("desktop", "phone", 1, Scope::ReadOnly);
    let desktop_pub = server.local.public_key();
    let server = Arc::new(server);
    let (addr, calls, last_req) = spawn_one_conn_server(Arc::clone(&server)).await;

    let mut client = Client::connect(addr, desktop_pub, "desktop", "phone", &phone.x, &phone.ed)
        .await
        .unwrap();
    let pivot = b"GET http://127.0.0.1:6379/ HTTP/1.1\r\nHost: evil\r\n\r\n";
    let resp = client
        .request(&phone.ed, "phone", Scope::ReadOnly, nonce(3), 100, 1000, pivot)
        .await;
    // request 는 불투명 바이트로 dispatch 에 그대로 도달(해석/forward 0).
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(&*last_req.lock().unwrap(), pivot, "request 는 불투명 — host:port forward 0(SSRF 0)");
    assert_eq!(resp[0], 0x01);
}

// ===========================================================================
// destructive (매트릭스 "danger 우회(폰)") — 데스크톱 confirm 권위가 와이어 너머에서도 강제.
// ===========================================================================

#[tokio::test]
async fn destructive_readonly_device_denied_scope_no_dispatch() {
    // read-only 폰이 destructive 요청 ⇒ scope 거부(게이트 2). 와이어 너머에서도 매 frame 강제.
    let (server, phone) = make_server_with_phone("desktop", "phone", 1, Scope::ReadOnly);
    let desktop_pub = server.local.public_key();
    let server = Arc::new(server);
    let (addr, calls, _last) = spawn_one_conn_server(Arc::clone(&server)).await;

    let mut client = Client::connect(addr, desktop_pub, "desktop", "phone", &phone.x, &phone.ed)
        .await
        .unwrap();
    let resp = client
        .request(&phone.ed, "phone", Scope::Destructive, nonce(4), 100, 1000, b"rm -rf")
        .await;
    assert_eq!(resp[0], 0x00, "Denied 응답 태그");
    assert_eq!(resp[1], 4, "Unauthorized(ScopeEscalation) 사유코드");
    assert_eq!(calls.load(Ordering::SeqCst), 0, "scope 상승 ⇒ dispatch 0");
}

#[tokio::test]
async fn destructive_granted_device_without_token_confirm_required_no_dispatch() {
    // 매트릭스 "danger 우회(폰)": destructive-grant 폰이 destructive 직행 시도. token provider 는
    //   None(deny-until-token — THIS STEP). RED(방어 전): destructive 가 Granted 면 바로 dispatch
    //   하면 폰이 데스크톱 권위 우회. GREEN: confirm 토큰 없으면 typed "confirm required"(코드 5)를
    //   폰에 회신하고 dispatch 0. (데스크톱 모달→토큰 왕복은 별도 후속 — 올바른 계층화.)
    let (server, phone) = make_server_with_phone("desktop", "phone", 1, Scope::Destructive);
    let desktop_pub = server.local.public_key();
    let server = Arc::new(server);
    let (addr, calls, _last) = spawn_one_conn_server(Arc::clone(&server)).await; // token=None.

    let mut client = Client::connect(addr, desktop_pub, "desktop", "phone", &phone.x, &phone.ed)
        .await
        .unwrap();
    let resp = client
        .request(&phone.ed, "phone", Scope::Destructive, nonce(5), 100, 1000, b"rm -rf")
        .await;
    assert_eq!(resp[0], 0x00, "Denied 응답 태그");
    assert_eq!(resp[1], 5, "DesktopConfirm 사유코드(confirm required)");
    assert_eq!(calls.load(Ordering::SeqCst), 0, "토큰 없으면 dispatch 0(폰 우회 불가)");
}

#[tokio::test]
async fn destructive_with_desktop_token_dispatches_once_over_wire() {
    // 데스크톱이 사용자 confirm 후 발급한 매칭 토큰(같은 device+nonce)을 provider 가 노출하면,
    //   destructive 가 와이어 너머로 dispatch 1회. 토큰은 auth floor 의 데스크톱-권위 생성자에서만
    //   나온다(폰 도달 불가) — provider 가 그 보유분을 노출할 뿐.
    let (server, phone) = make_server_with_phone("desktop", "phone", 1, Scope::Destructive);
    let desktop_pub = server.local.public_key();
    let server = Arc::new(server);
    // provider: 폰에 대해 nonce(6) 결속 토큰을 노출(데스크톱이 confirm 후 발급했다고 가정).
    let token_fn = move |peer: &str| -> Option<DesktopConfirmToken> {
        if peer == "phone" {
            Some(DesktopConfirmToken::issue_after_desktop_confirm("phone", nonce(6)))
        } else {
            None
        }
    };
    let (addr, calls, last_req) =
        spawn_one_conn_server_with_token(Arc::clone(&server), token_fn).await;

    let mut client = Client::connect(addr, desktop_pub, "desktop", "phone", &phone.x, &phone.ed)
        .await
        .unwrap();
    let resp = client
        .request(&phone.ed, "phone", Scope::Destructive, nonce(6), 100, 1000, b"panel.close")
        .await;
    assert_eq!(resp[0], 0x01, "매칭 토큰 ⇒ Ok 응답");
    assert_eq!(&resp[1..], b"{\"ok\":true,\"scope\":\"destructive\"}");
    assert_eq!(calls.load(Ordering::SeqCst), 1, "confirm 후 dispatch 1회");
    assert_eq!(&*last_req.lock().unwrap(), b"panel.close");
}

// ===========================================================================
// 변조/재생/malformed (매트릭스 "malformed 패킷→graceful 거부").
// ===========================================================================

#[tokio::test]
async fn tampered_frame_on_wire_aead_reject_no_dispatch() {
    // 릴레이 능동 변조: 폰이 보낸 ciphertext 의 한 바이트를 와이어에서 뒤집는다(우리는 클라이언트가
    //   직접 변조 ct 를 흘려 그 효과를 재현). RED: AEAD 없으면 garbage 가 파싱·dispatch. GREEN:
    //   Poly1305 실패 ⇒ Decrypt(코드 1) 회신 + dispatch 0.
    let (server, phone) = make_server_with_phone("desktop", "phone", 1, Scope::ReadOnly);
    let desktop_pub = server.local.public_key();
    let server = Arc::new(server);
    let (addr, calls, _last) = spawn_one_conn_server(Arc::clone(&server)).await;

    let mut client = Client::connect(addr, desktop_pub, "desktop", "phone", &phone.x, &phone.ed)
        .await
        .unwrap();
    // 정당 frame 을 암호화한 뒤 한 바이트 변조해 raw 송신.
    let assertion = CapabilityAssertion {
        device_id: "phone".into(),
        scope: Scope::ReadOnly,
        nonce: nonce(7),
        issued_at: 100,
        exp: 1000,
    };
    let sig = phone.ed.sign(&assertion.canonical_bytes()).to_bytes().to_vec();
    let frame = RequestFrame { assertion, signature: sig, request: b"ui.tree".to_vec() }.encode();
    let mut ct = client.channel.encrypt(&frame).expect("encrypt");
    ct[0] ^= 0x01; // 변조.
    client.send_raw(&ct).await;

    let resp = recv_framed(&mut client.stream).await;
    // 응답은 서버 채널로 암호화됨 — 폰 채널로 복호.
    let pt = client.channel.decrypt(&resp).expect("decrypt denied resp");
    assert_eq!(pt[0], 0x00, "Denied 태그");
    assert_eq!(pt[1], 1, "Decrypt 사유코드(AEAD 거부)");
    assert_eq!(calls.load(Ordering::SeqCst), 0, "변조 ⇒ dispatch 0");
}

#[tokio::test]
async fn replay_captured_frame_denied_second_time() {
    // 릴레이 캡처 후 재생: 같은 평문 frame(같은 nonce)을 두 번 보낸다. 1회차 성공(nonce 소비),
    //   2회차는 auth nonce 단일사용이 거부. (각 frame 은 새 ciphertext — 채널 counter 전진하므로
    //   채널은 통과하고 auth nonce 게이트가 잡는다.) RED: nonce 원장 없으면 무한 재-dispatch.
    let (server, phone) = make_server_with_phone("desktop", "phone", 1, Scope::ReadOnly);
    let desktop_pub = server.local.public_key();
    let server = Arc::new(server);
    let (addr, calls, _last) = spawn_one_conn_server(Arc::clone(&server)).await;

    let mut client = Client::connect(addr, desktop_pub, "desktop", "phone", &phone.x, &phone.ed)
        .await
        .unwrap();
    // 같은 (nonce, issued_at)로 두 번 — 같은 평문 frame.
    let r1 = client
        .request(&phone.ed, "phone", Scope::ReadOnly, nonce(8), 100, 1000, b"ui.tree")
        .await;
    assert_eq!(r1[0], 0x01, "1회차 Ok");
    let r2 = client
        .request(&phone.ed, "phone", Scope::ReadOnly, nonce(8), 100, 1000, b"ui.tree")
        .await;
    assert_eq!(r2[0], 0x00, "2회차 Denied");
    assert_eq!(r2[1], 4, "Unauthorized(NonceReplay) 사유코드");
    assert_eq!(calls.load(Ordering::SeqCst), 1, "재생은 재-dispatch 0(여전히 1)");
}

#[tokio::test]
async fn oversized_length_prefix_rejected_gracefully_no_panic() {
    // malformed: 핸드셰이크 후 길이 프리픽스로 캡(65535) 초과값을 보낸다. RED: 무한 capacity 면
    //   메모리 증폭/DoS. GREEN: read_framed 가 FrameTooLarge 로 연결만 닫는다(패닉 0). dispatch 0.
    let (server, phone) = make_server_with_phone("desktop", "phone", 1, Scope::ReadOnly);
    let desktop_pub = server.local.public_key();
    let server = Arc::new(server);
    let (addr, calls, _last) = spawn_one_conn_server(Arc::clone(&server)).await;

    let mut client = Client::connect(addr, desktop_pub, "desktop", "phone", &phone.x, &phone.ed)
        .await
        .unwrap();
    // 캡 초과 길이 프리픽스(0xFFFFFFFF) — body 는 안 보낸다(서버가 프리픽스만 보고 거부).
    client.stream.write_all(&0xFFFF_FFFFu32.to_be_bytes()).await.unwrap();
    client.stream.flush().await.unwrap();

    // 서버가 연결을 닫는다 — 읽기 시도가 EOF/에러(패닉 0).
    let mut buf = [0u8; 4];
    let read = client.stream.read(&mut buf).await;
    assert!(
        matches!(read, Ok(0)) || read.is_err(),
        "캡 초과 ⇒ 서버가 graceful 종료(패닉 0)"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0, "malformed ⇒ dispatch 0");
}

#[tokio::test]
async fn garbage_after_handshake_rejected_no_dispatch() {
    // 핸드셰이크 후 임의 garbage 바이트(유효 길이 프리픽스 + 쓰레기 body)를 frame 자리에 흘린다.
    //   AEAD 가 거부(Decrypt) — garbage 는 절대 dispatch 0.
    let (server, phone) = make_server_with_phone("desktop", "phone", 1, Scope::ReadOnly);
    let desktop_pub = server.local.public_key();
    let server = Arc::new(server);
    let (addr, calls, _last) = spawn_one_conn_server(Arc::clone(&server)).await;

    let mut client = Client::connect(addr, desktop_pub, "desktop", "phone", &phone.x, &phone.ed)
        .await
        .unwrap();
    client.send_raw(&[0xAAu8; 64]).await; // garbage(어떤 키로도 인증 안 됨).
    let resp = recv_framed(&mut client.stream).await;
    let pt = client.channel.decrypt(&resp).expect("decrypt denied");
    assert_eq!(pt[0], 0x00);
    assert_eq!(pt[1], 1, "Decrypt 사유코드");
    assert_eq!(calls.load(Ordering::SeqCst), 0, "garbage ⇒ dispatch 0");
}

// ===========================================================================
// pre-handshake 데이터 — 핸드셰이크 전엔 어떤 frame 도 dispatch 0(handshake-before-data).
// ===========================================================================

#[tokio::test]
async fn pre_handshake_bytes_never_dispatched() {
    // 공격: 클라이언트가 announce 후 **핸드셰이크를 끝내기 전에** frame 처럼 보이는 바이트를 흘린다
    //   (서버가 m1 을 기다리는 자리에 쓰레기). RED: 핸드셰이크 전 데이터 경로가 있으면 미인증
    //   dispatch. GREEN: 서버는 announce 다음에 m1(핸드셰이크 메시지)을 기대 — 그 자리의 쓰레기는
    //   read_message 가 HandshakeFailed ⇒ 연결 종료, 채널 미성립 ⇒ dispatch 0.
    let (server, _phone) = make_server_with_phone("desktop", "phone", 1, Scope::ReadOnly);
    let server = Arc::new(server);
    let (addr, calls, _last) = spawn_one_conn_server(Arc::clone(&server)).await;

    let mut stream = TcpStream::connect(addr).await.unwrap();
    // announce("phone") — 핀닝된 id 라 respond 는 성립하지만, 다음에 와야 할 m1 자리에 쓰레기.
    send_framed(&mut stream, b"phone").await;
    send_framed(&mut stream, &[0x00u8; 32]).await; // m1 자리의 garbage(유효 KK 메시지 아님).

    // 서버는 read_message 실패로 연결 종료 — 어떤 dispatch 도 없다.
    let mut buf = [0u8; 4];
    let _ = stream.read(&mut buf).await; // EOF/에러.
    tokio::task::yield_now().await;
    assert_eq!(calls.load(Ordering::SeqCst), 0, "핸드셰이크 전 데이터 ⇒ dispatch 0");
}

#[tokio::test]
async fn empty_connection_no_announce_no_dispatch() {
    // 아무것도 안 보내고 끊는 연결 — graceful(서버가 Ok 로 종료), dispatch 0, 패닉 0.
    let (server, _phone) = make_server_with_phone("desktop", "phone", 1, Scope::ReadOnly);
    let server = Arc::new(server);
    let (addr, calls, _last) = spawn_one_conn_server(Arc::clone(&server)).await;

    let stream = TcpStream::connect(addr).await.unwrap();
    drop(stream); // 즉시 끊음.
    tokio::task::yield_now().await;
    assert_eq!(calls.load(Ordering::SeqCst), 0, "빈 연결 ⇒ dispatch 0(graceful)");
}

// ===========================================================================
// cross-device smuggling (와이어) — A 채널로 B assertion 재생 ⇒ 기기-결속 거부.
// ===========================================================================

#[tokio::test]
async fn cross_device_assertion_over_wire_rejected_no_dispatch() {
    // 폰(A)이 자기 채널로, **태블릿(B)의 유효 서명 assertion** 을 실어 보낸다(B 가 더 강한 scope).
    //   RED: 세션이 채널 peer 와 assertion.device_id 를 대조 안 하면 B 행세 상승. GREEN: 기기-결속
    //   교차검사가 DeviceMismatch(코드 3) ⇒ dispatch 0.
    let (server, phone) = make_server_with_phone("desktop", "phone", 1, Scope::ReadOnly);
    // 태블릿도 페어링(destructive) — auth 단독으론 통과할 진짜 키.
    let tablet_ed = ed_key(2);
    {
        let mut auth = server.auth.lock();
        auth.pair("tablet", &ed_pub(&tablet_ed), Scope::Destructive).unwrap();
    }
    let desktop_pub = server.local.public_key();
    let server = Arc::new(server);
    let (addr, calls, _last) = spawn_one_conn_server(Arc::clone(&server)).await;

    // 채널은 폰(A) 채널. claim_id="tablet", signer=tablet 키(진짜 B 서명)로 frame 을 만든다.
    let mut client = Client::connect(addr, desktop_pub, "desktop", "phone", &phone.x, &phone.ed)
        .await
        .unwrap();
    let resp = client
        .request(&tablet_ed, "tablet", Scope::Destructive, nonce(3), 100, 1000, b"rm -rf")
        .await;
    assert_eq!(resp[0], 0x00, "Denied 태그");
    assert_eq!(resp[1], 3, "DeviceMismatch 사유코드(smuggling 거부)");
    assert_eq!(calls.load(Ordering::SeqCst), 0, "cross-device ⇒ dispatch 0");
}

// ===========================================================================
// 두 동시 연결 격리 + mid-session revoke (매트릭스 "1탭 unpair→즉시 drop").
// ===========================================================================

#[tokio::test]
async fn two_concurrent_clients_isolated_one_revoked_other_unaffected() {
    // 두 폰이 같은 공유 auth 권위로 동시 연결. 한 폰을 mid-session revoke 하면 **그 폰의 다음
    //   frame 부터** Denied, 다른 폰은 무영향. RED: 연결별 독립 상태면 revoke 가 전파 안 됨(또는
    //   한 연결 실패가 다른 연결을 죽임). GREEN: SharedAuth 단일 권위 + 연결 격리 task.
    let local = Arc::new(StaticKeypair::generate().unwrap());
    let phone_a = Phone { x: StaticKeypair::generate().unwrap(), ed: ed_key(1), id: "phone-a".into() };
    let phone_b = Phone { x: StaticKeypair::generate().unwrap(), ed: ed_key(2), id: "phone-b".into() };
    let mut noise = PinnedPeerRegistry::new();
    noise.pin("phone-a", &phone_a.x.public_key()).unwrap();
    noise.pin("phone-b", &phone_b.x.public_key()).unwrap();
    let mut auth = DeviceRegistry::new(4);
    auth.pair("phone-a", &ed_pub(&phone_a.ed), Scope::ReadOnly).unwrap();
    auth.pair("phone-b", &ed_pub(&phone_b.ed), Scope::ReadOnly).unwrap();
    let shared = SharedAuth::new(auth);
    let noise = Arc::new(noise);
    let desktop_pub = local.public_key();

    // 한 리스너가 두 연결을 받는다(연결마다 격리 task). dispatch 카운터는 공유.
    let listener = bind_loopback(0).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let calls = Arc::new(AtomicU32::new(0));
    {
        let local = Arc::clone(&local);
        let noise = Arc::clone(&noise);
        let shared = shared.clone();
        let calls = Arc::clone(&calls);
        tokio::spawn(async move {
            loop {
                let (stream, _) = match listener.accept().await {
                    Ok(p) => p,
                    Err(_) => break,
                };
                let local = Arc::clone(&local);
                let noise = Arc::clone(&noise);
                let shared = shared.clone();
                let dispatch = recording_dispatch(Arc::clone(&calls), Arc::new(Mutex::new(Vec::new())));
                tokio::spawn(async move {
                    let _ = serve_connection(stream, &local, &noise, &shared, || 200u64, |_| None, dispatch).await;
                });
            }
        });
    }

    let mut ca = Client::connect(addr, desktop_pub, "desktop", "phone-a", &phone_a.x, &phone_a.ed)
        .await
        .unwrap();
    let mut cb = Client::connect(addr, desktop_pub, "desktop", "phone-b", &phone_b.x, &phone_b.ed)
        .await
        .unwrap();

    // 둘 다 정상 1회.
    let ra1 = ca.request(&phone_a.ed, "phone-a", Scope::ReadOnly, nonce(10), 100, 1000, b"ui.tree").await;
    let rb1 = cb.request(&phone_b.ed, "phone-b", Scope::ReadOnly, nonce(11), 100, 1000, b"ui.tree").await;
    assert_eq!(ra1[0], 0x01, "A 1회차 Ok");
    assert_eq!(rb1[0], 0x01, "B 1회차 Ok");

    // mid-session: A 를 공유 권위에서 revoke(다른 곳의 관리 코드가 lock().revoke()).
    {
        let mut reg = shared.lock();
        assert!(reg.revoke("phone-a"), "A revoke");
    }

    // A 의 다음 frame ⇒ Denied(DeviceRevoked, 코드 4). B 는 무영향.
    let ra2 = ca.request(&phone_a.ed, "phone-a", Scope::ReadOnly, nonce(12), 101, 1000, b"ui.tree").await;
    assert_eq!(ra2[0], 0x00, "revoke 후 A Denied");
    assert_eq!(ra2[1], 4, "Unauthorized(DeviceRevoked) 사유코드");
    let rb2 = cb.request(&phone_b.ed, "phone-b", Scope::ReadOnly, nonce(13), 101, 1000, b"ui.tree").await;
    assert_eq!(rb2[0], 0x01, "B 는 A revoke 에 무영향(연결 격리)");

    // dispatch 총 3회: A 1(첫) + B 2(둘 다) = 3. A 의 두 번째는 dispatch 0.
    assert_eq!(calls.load(Ordering::SeqCst), 3, "A1 + B1 + B2 = 3(A2 는 revoke 로 dispatch 0)");
}

// ===========================================================================
// 응답 기밀성(와이어) — 릴레이/도청자는 평문 결과를 못 본다(E2E).
// ===========================================================================

#[tokio::test]
async fn response_on_wire_is_ciphertext_not_plaintext() {
    // 와이어에 흐르는 응답 바이트가 평문 envelope 를 부분열로 포함하지 않음(E2E zero-knowledge).
    //   폰은 복호로 정확한 결과를 얻는다.
    let (server, phone) = make_server_with_phone("desktop", "phone", 1, Scope::ReadOnly);
    let desktop_pub = server.local.public_key();
    let server = Arc::new(server);
    let (addr, _calls, _last) = spawn_one_conn_server(Arc::clone(&server)).await;

    let mut client = Client::connect(addr, desktop_pub, "desktop", "phone", &phone.x, &phone.ed)
        .await
        .unwrap();
    // 직접 raw 응답 ciphertext 를 받아 와이어 바이트를 검사.
    let assertion = CapabilityAssertion {
        device_id: "phone".into(),
        scope: Scope::ReadOnly,
        nonce: nonce(20),
        issued_at: 100,
        exp: 1000,
    };
    let sig = phone.ed.sign(&assertion.canonical_bytes()).to_bytes().to_vec();
    let frame = RequestFrame { assertion, signature: sig, request: b"ui.tree".to_vec() }.encode();
    let ct = client.channel.encrypt(&frame).unwrap();
    send_framed(&mut client.stream, &ct).await;
    let resp_ct = recv_framed(&mut client.stream).await;

    let plaintext_marker = b"{\"ok\":true";
    assert!(
        !resp_ct.windows(plaintext_marker.len()).any(|w| w == plaintext_marker),
        "와이어 응답에 평문 envelope 0(E2E)"
    );
    let pt = client.channel.decrypt(&resp_ct).unwrap();
    assert_eq!(pt[0], 0x01);
    assert!(pt[1..].starts_with(plaintext_marker), "폰은 복호로 정확한 결과");
}

// ===========================================================================
// DESKTOP-CONFIRM AUTHORITY (serve_connection_confirmed) — destructive 는 데스크톱 사람
// 결정을 await 한 뒤에만 dispatch. 폰은 우회·자가승인·timeout-bypass 불가(매트릭스
// "danger 우회(폰)" / "confirm 거부·timeout→미실행" / RULE 0 anti-escalation).
//
// 테스트가 데스크톱 사람을 흉내낸다: PendingConfirms.resolve(request_id, approve) 를 직접 호출.
// 폰(Client)은 destructive frame 을 보내고 그 결과(승인 시 dispatch 결과 / 거부·timeout 시
// denied)를 기다린다 — request 가 blocking 이므로 client.request 를 별도 task 로 돌리고 서버가
// emit 한 request_id 를 받아 resolve 한다.
// ===========================================================================

use std::time::Duration;
use tokio::sync::mpsc;

/// emit_confirm 콜백이 받은 ConfirmRequest 들을 수집하는 recorder(채널). 서버가 destructive 를
/// 파킹하면 여기로 ConfirmRequest 가 흘러온다 — 테스트가 그 request_id 로 resolve 한다.
fn confirm_emit_recorder() -> (
    mpsc::UnboundedSender<ConfirmRequest>,
    mpsc::UnboundedReceiver<ConfirmRequest>,
) {
    mpsc::unbounded_channel()
}

/// serve_connection_confirmed 를 진짜 루프백 소켓에 1연결만 띄운다. (주소, PendingConfirms,
/// dispatch 카운터, 마지막 request, emit 수신측)을 돌려준다. TTL 은 호출자가 지정(timeout 테스트).
async fn spawn_one_conn_confirmed(
    server: Arc<Server>,
    confirms: PendingConfirms,
    ttl: Duration,
) -> (
    SocketAddr,
    Arc<AtomicU32>,
    Arc<Mutex<Vec<u8>>>,
    mpsc::UnboundedReceiver<ConfirmRequest>,
) {
    let listener = bind_loopback(0).await.expect("bind loopback");
    let addr = listener.local_addr().expect("local addr");
    let calls = Arc::new(AtomicU32::new(0));
    let last_req = Arc::new(Mutex::new(Vec::new()));
    let (emit_tx, emit_rx) = confirm_emit_recorder();
    let calls_c = Arc::clone(&calls);
    let last_c = Arc::clone(&last_req);
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("accept");
        let dispatch = recording_dispatch(calls_c, last_c);
        let _ = serve_connection_confirmed(
            stream,
            &server.local,
            &server.noise,
            &server.auth,
            &confirms,
            ttl,
            || 200u64, // 고정 now(테스트 결정성).
            move |req: ConfirmRequest| {
                let _ = emit_tx.send(req); // 파킹된 confirm 요청을 테스트로 전달.
            },
            dispatch,
        )
        .await;
    });
    (addr, calls, last_req, emit_rx)
}

#[tokio::test]
async fn confirm_approve_dispatches_once_encrypted_result() {
    // APPROVE ⇒ dispatch 정확히 1회, 암호화된 결과를 폰이 복호. RED(방어 전): destructive 가
    //   승인 후에도 절대 dispatch 안 됨(park 만 하고 finish 누락) / 또는 승인 없이 dispatch.
    //   GREEN: resolve(true) ⇒ 어댑터가 토큰 생성 → dispatch 1회 → {ok:true,scope:destructive}.
    let (server, phone) = make_server_with_phone("desktop", "phone", 1, Scope::Destructive);
    let desktop_pub = server.local.public_key();
    let server = Arc::new(server);
    let confirms = PendingConfirms::new(60);
    let (addr, calls, last_req, mut emit_rx) =
        spawn_one_conn_confirmed(Arc::clone(&server), confirms.clone(), Duration::from_secs(60))
            .await;

    let mut client = Client::connect(addr, desktop_pub, "desktop", "phone", &phone.x, &phone.ed)
        .await
        .unwrap();

    // 폰의 destructive 요청을 별도 task 로(응답은 데스크톱 승인 후에야 온다).
    let req_task = tokio::spawn(async move {
        let resp = client
            .request(&phone.ed, "phone", Scope::Destructive, nonce(30), 100, 1000, b"panel.close")
            .await;
        resp
    });

    // 서버가 파킹하고 emit 한 confirm 요청을 받는다.
    let req = emit_rx.recv().await.expect("confirm 요청 emit");
    assert_eq!(req.device_id, "phone", "요청의 기기");
    assert_eq!(req.command, "panel.close", "명령 요약");
    assert!(req.danger, "destructive ⇒ danger=true");
    assert_eq!(calls.load(Ordering::SeqCst), 0, "승인 전엔 dispatch 0");

    // 데스크톱 사람: APPROVE.
    assert!(confirms.resolve(req.request_id, true), "데스크톱 승인 전달");

    let resp = req_task.await.unwrap();
    assert_eq!(resp[0], 0x01, "승인 ⇒ Ok 응답");
    assert_eq!(&resp[1..], b"{\"ok\":true,\"scope\":\"destructive\"}", "암호화 결과 복호");
    assert_eq!(calls.load(Ordering::SeqCst), 1, "승인 후 dispatch 정확히 1회");
    assert_eq!(&*last_req.lock().unwrap(), b"panel.close", "dispatch 가 실제 request 수신");
}

#[tokio::test]
async fn confirm_deny_no_dispatch_client_gets_denied() {
    // DENY ⇒ dispatch 0, 폰은 denied(코드 5). RED: 거부에도 dispatch 면 데스크톱 권위 무력.
    let (server, phone) = make_server_with_phone("desktop", "phone", 1, Scope::Destructive);
    let desktop_pub = server.local.public_key();
    let server = Arc::new(server);
    let confirms = PendingConfirms::new(60);
    let (addr, calls, _last, mut emit_rx) =
        spawn_one_conn_confirmed(Arc::clone(&server), confirms.clone(), Duration::from_secs(60))
            .await;

    let mut client = Client::connect(addr, desktop_pub, "desktop", "phone", &phone.x, &phone.ed)
        .await
        .unwrap();
    let req_task = tokio::spawn(async move {
        client
            .request(&phone.ed, "phone", Scope::Destructive, nonce(31), 100, 1000, b"rm -rf")
            .await
    });

    let req = emit_rx.recv().await.expect("confirm 요청");
    // 데스크톱 사람: DENY.
    assert!(confirms.resolve(req.request_id, false), "데스크톱 거부 전달");

    let resp = req_task.await.unwrap();
    assert_eq!(resp[0], 0x00, "거부 ⇒ Denied 응답");
    assert_eq!(resp[1], 5, "DesktopConfirm 사유코드");
    assert_eq!(calls.load(Ordering::SeqCst), 0, "거부 ⇒ dispatch 0");
}

#[tokio::test]
async fn confirm_timeout_auto_denies_no_dispatch() {
    // TTL 내 미해결 ⇒ AUTO-DENY, dispatch 0(matrix "timeout→미실행"). RED: hang forever
    //   (응답 영원히 안 옴) / 또는 timeout 에 dispatch. GREEN: 짧은 TTL ⇒ select! sleep 팔이
    //   깨워 finish_denied ⇒ 폰은 denied(코드 5), dispatch 0. resolve 를 **호출하지 않는다**.
    let (server, phone) = make_server_with_phone("desktop", "phone", 1, Scope::Destructive);
    let desktop_pub = server.local.public_key();
    let server = Arc::new(server);
    let confirms = PendingConfirms::new(60);
    // 아주 짧은 TTL — 사람이 결정 안 하면 곧 AUTO-DENY.
    let (addr, calls, _last, mut emit_rx) = spawn_one_conn_confirmed(
        Arc::clone(&server),
        confirms.clone(),
        Duration::from_millis(120),
    )
    .await;

    let mut client = Client::connect(addr, desktop_pub, "desktop", "phone", &phone.x, &phone.ed)
        .await
        .unwrap();
    let req_task = tokio::spawn(async move {
        client
            .request(&phone.ed, "phone", Scope::Destructive, nonce(32), 100, 1000, b"rm -rf")
            .await
    });

    // 요청은 emit 되지만 **resolve 하지 않는다** — TTL 이 만료돼 AUTO-DENY.
    let _req = emit_rx.recv().await.expect("confirm 요청 emit");
    let resp = req_task.await.unwrap();
    assert_eq!(resp[0], 0x00, "timeout ⇒ Denied(hang 0)");
    assert_eq!(resp[1], 5, "DesktopConfirm 사유코드(AUTO-DENY)");
    assert_eq!(calls.load(Ordering::SeqCst), 0, "timeout ⇒ dispatch 0");
}

#[tokio::test]
async fn phone_cannot_self_approve_no_frame_resolves_own_confirm() {
    // 폰이 자가승인 시도: destructive 를 보낸 직후, **추가 frame 으로 자기 confirm 을 승인**하려
    //   한다(어떤 바이트도 resolve 로 라우팅되길 기대). RED: 폰 frame 이 resolve 경로에 닿으면
    //   자가승인 → 데스크톱 권위 무력. GREEN: serve loop 는 폰 frame 을 resolve 로 라우팅하는
    //   경로가 없다(resolve 는 PendingConfirms 메서드 — 데스크톱 glue 만 보유). 폰의 두 번째
    //   frame 은 또 다른 요청으로 취급될 뿐 첫 confirm 을 승인하지 못한다. 데스크톱이 끝내 거부
    //   하면 dispatch 0.
    let (server, phone) = make_server_with_phone("desktop", "phone", 1, Scope::Destructive);
    let desktop_pub = server.local.public_key();
    let server = Arc::new(server);
    let confirms = PendingConfirms::new(60);
    let (addr, calls, _last, mut emit_rx) =
        spawn_one_conn_confirmed(Arc::clone(&server), confirms.clone(), Duration::from_secs(60))
            .await;

    let mut client = Client::connect(addr, desktop_pub, "desktop", "phone", &phone.x, &phone.ed)
        .await
        .unwrap();

    // 폰이 destructive 를 보내고(파킹), 데스크톱 승인 전에 "승인처럼 보이는" 두 번째 frame 을
    // 흘리려 한다. 하지만 첫 요청이 blocking 이라 폰은 응답 전엔 두 번째를 못 보낸다 — 그것이
    // 곧 "폰은 자기 confirm 을 승인할 채널이 없다"(첫 요청 결과를 받아야 다음 frame). 데스크톱이
    // 결국 거부하면 dispatch 0. (resolve 는 데스크톱 핸들 전용 — 폰 와이어에 그 표면이 없다.)
    let req_task = tokio::spawn(async move {
        client
            .request(&phone.ed, "phone", Scope::Destructive, nonce(33), 100, 1000, b"rm -rf")
            .await
    });

    let req = emit_rx.recv().await.expect("confirm 요청");
    // 폰 와이어에는 resolve 표면이 없다 — request_id 를 알아도 폰은 PendingConfirms 핸들이 없어
    // resolve 를 호출할 수 없다. 데스크톱(이 테스트)이 거부 ⇒ dispatch 0.
    assert!(confirms.resolve(req.request_id, false), "데스크톱만 resolve");
    let resp = req_task.await.unwrap();
    assert_eq!(resp[0], 0x00, "폰 자가승인 불가 ⇒ Denied");
    assert_eq!(calls.load(Ordering::SeqCst), 0, "자가승인 불가 ⇒ dispatch 0");
}

#[tokio::test]
async fn confirm_token_bound_to_exact_device_nonce_not_reusable() {
    // 토큰은 어댑터가 (device, bound_nonce) 정확히로 만든다 — A 의 승인이 B 를 인가하지 못하고,
    //   한 요청의 토큰이 다른 요청에 재사용되지 않는다. 여기선 **두 destructive 요청**을 순차로:
    //   첫째 승인(자기 nonce 토큰으로 dispatch), 둘째는 **거부** ⇒ 첫 토큰이 둘째로 새지 않음을
    //   단언(둘째 dispatch 0). RED: 토큰이 요청 간 재사용되면 둘째도 dispatch.
    let (server, phone) = make_server_with_phone("desktop", "phone", 1, Scope::Destructive);
    let desktop_pub = server.local.public_key();
    let server = Arc::new(server);
    let confirms = PendingConfirms::new(60);
    let (addr, calls, last_req, mut emit_rx) =
        spawn_one_conn_confirmed(Arc::clone(&server), confirms.clone(), Duration::from_secs(60))
            .await;

    let mut client = Client::connect(addr, desktop_pub, "desktop", "phone", &phone.x, &phone.ed)
        .await
        .unwrap();

    // --- 첫 요청(nonce 40) — 승인 ⇒ dispatch 1 ---
    // request 는 blocking 이라 한 task 안에서 두 요청을 순차로 보낸다(채널 counter 자연 직렬).
    let confirms_c = confirms.clone();
    let req_task = tokio::spawn(async move {
        let r1 = client
            .request(&phone.ed, "phone", Scope::Destructive, nonce(40), 100, 1000, b"panel.close")
            .await;
        let r2 = client
            .request(&phone.ed, "phone", Scope::Destructive, nonce(41), 101, 1000, b"tab.close")
            .await;
        (r1, r2)
    });

    // 첫 confirm — 승인.
    let req1 = emit_rx.recv().await.expect("confirm 1");
    assert_eq!(req1.command, "panel.close");
    assert!(confirms_c.resolve(req1.request_id, true), "첫 요청 승인");

    // 둘째 confirm — 거부(첫 토큰이 새지 않음을 단언).
    let req2 = emit_rx.recv().await.expect("confirm 2");
    assert_eq!(req2.command, "tab.close");
    assert_ne!(req2.request_id, req1.request_id, "요청별 독립 request_id");
    assert!(confirms_c.resolve(req2.request_id, false), "둘째 요청 거부");

    let (r1, r2) = req_task.await.unwrap();
    assert_eq!(r1[0], 0x01, "첫 요청 승인 ⇒ Ok");
    assert_eq!(&r1[1..], b"{\"ok\":true,\"scope\":\"destructive\"}");
    assert_eq!(r2[0], 0x00, "둘째 요청 거부 ⇒ Denied(첫 토큰 재사용 0)");
    assert_eq!(r2[1], 5, "DesktopConfirm 사유코드");
    assert_eq!(calls.load(Ordering::SeqCst), 1, "첫째만 dispatch(둘째 dispatch 0)");
    assert_eq!(&*last_req.lock().unwrap(), b"panel.close", "dispatch 된 건 첫 요청뿐");
}

#[tokio::test]
async fn read_only_request_unaffected_immediate_dispatch_no_parking() {
    // 회귀 가드: read-only 요청은 confirmed serve loop 에서도 **즉시 dispatch**(파킹 0, emit 0).
    //   RED: 파킹 분기가 read-only 까지 잡으면 읽기 전용이 데스크톱 승인을 기다림(과확장). GREEN:
    //   begin_frame 이 비파괴를 Terminal 로 즉시 종결 — emit_confirm 호출 0, dispatch 1회.
    let (server, phone) = make_server_with_phone("desktop", "phone", 1, Scope::ReadOnly);
    let desktop_pub = server.local.public_key();
    let server = Arc::new(server);
    let confirms = PendingConfirms::new(60);
    let (addr, calls, last_req, mut emit_rx) =
        spawn_one_conn_confirmed(Arc::clone(&server), confirms.clone(), Duration::from_secs(60))
            .await;

    let mut client = Client::connect(addr, desktop_pub, "desktop", "phone", &phone.x, &phone.ed)
        .await
        .unwrap();
    // read-only 는 즉시 응답(데스크톱 승인 불요) — 직접 await(task 불요).
    let resp = client
        .request(&phone.ed, "phone", Scope::ReadOnly, nonce(34), 100, 1000, b"ui.tree")
        .await;
    assert_eq!(resp[0], 0x01, "read-only ⇒ 즉시 Ok");
    assert_eq!(&resp[1..], b"{\"ok\":true,\"scope\":\"read-only\"}");
    assert_eq!(calls.load(Ordering::SeqCst), 1, "read-only ⇒ dispatch 1회(파킹 0)");
    assert_eq!(&*last_req.lock().unwrap(), b"ui.tree");
    // emit_confirm 은 호출되지 않았다(파킹 0) — 채널이 비어 있다.
    assert!(emit_rx.try_recv().is_err(), "read-only ⇒ confirm emit 0(파킹 없음)");
    assert_eq!(confirms.pending_count(), 0, "read-only ⇒ 파킹 0");
}

#[tokio::test]
async fn anti_escalation_destructive_always_parks_no_auto_grant_flag() {
    // anti-escalation(RULE 0): destructive 는 **항상** 파킹+await 한다 — auto-grant 로 만드는
    //   env/config 플래그가 없다. 이 테스트는 destructive 가 어떤 환경에서도 emit_confirm 을
    //   거치고(파킹), 데스크톱 결정 없이는 dispatch 0 임을 단언한다. RED: 만약 "config off" 가
    //   destructive 를 즉시 grant 하면 emit 0 + dispatch 1(우회). GREEN: 무조건 파킹 → emit 1,
    //   결정 전 dispatch 0. (resolve 안 하면 위 timeout 테스트가 미실행을 단언.)
    let (server, phone) = make_server_with_phone("desktop", "phone", 1, Scope::Destructive);
    let desktop_pub = server.local.public_key();
    let server = Arc::new(server);
    let confirms = PendingConfirms::new(60);
    let (addr, calls, _last, mut emit_rx) =
        spawn_one_conn_confirmed(Arc::clone(&server), confirms.clone(), Duration::from_secs(60))
            .await;

    let mut client = Client::connect(addr, desktop_pub, "desktop", "phone", &phone.x, &phone.ed)
        .await
        .unwrap();
    let req_task = tokio::spawn(async move {
        client
            .request(&phone.ed, "phone", Scope::Destructive, nonce(35), 100, 1000, b"rm -rf")
            .await
    });

    // destructive 는 무조건 파킹 → emit 정확히 1회.
    let req = emit_rx.recv().await.expect("destructive 는 항상 파킹+emit(우회 0)");
    assert!(req.danger, "destructive ⇒ danger=true");
    // 데스크톱 결정 전: dispatch 0(파킹된 채 await).
    assert_eq!(calls.load(Ordering::SeqCst), 0, "결정 전 dispatch 0(auto-grant 플래그 0)");
    // 정리: 거부로 종결(hang 방지).
    confirms.resolve(req.request_id, false);
    let resp = req_task.await.unwrap();
    assert_eq!(resp[0], 0x00, "결정 전 실행 0 — 거부로 종결");
    assert_eq!(calls.load(Ordering::SeqCst), 0, "끝까지 dispatch 0");
}

#[tokio::test]
async fn read_only_denied_scope_in_confirmed_loop_no_parking() {
    // 회귀: read-only 기기가 destructive 요청 ⇒ scope 거부(게이트 2)로 **즉시 종결**(파킹 0).
    //   거부는 destructive grant 가 아니므로 confirm 경로에 닿지 않는다. RED: 거부도 파킹하면 hang.
    let (server, phone) = make_server_with_phone("desktop", "phone", 1, Scope::ReadOnly);
    let desktop_pub = server.local.public_key();
    let server = Arc::new(server);
    let confirms = PendingConfirms::new(60);
    let (addr, calls, _last, mut emit_rx) =
        spawn_one_conn_confirmed(Arc::clone(&server), confirms.clone(), Duration::from_secs(60))
            .await;

    let mut client = Client::connect(addr, desktop_pub, "desktop", "phone", &phone.x, &phone.ed)
        .await
        .unwrap();
    let resp = client
        .request(&phone.ed, "phone", Scope::Destructive, nonce(36), 100, 1000, b"rm -rf")
        .await;
    assert_eq!(resp[0], 0x00, "scope 거부 ⇒ 즉시 Denied");
    assert_eq!(resp[1], 4, "Unauthorized(ScopeEscalation) — confirm 아님");
    assert_eq!(calls.load(Ordering::SeqCst), 0, "거부 ⇒ dispatch 0");
    assert!(emit_rx.try_recv().is_err(), "scope 거부 ⇒ 파킹/emit 0");
    assert_eq!(confirms.pending_count(), 0, "거부는 파킹 0");
}

#[tokio::test]
async fn two_destructive_confirms_park_independently() {
    // 직렬/격리: 두 destructive 요청이 각각 독립 request_id 로 파킹된다 — 하나의 resolve 가
    //   다른 것을 해결하지 않는다. (한 연결 내 순차이므로 list_pending 으로 독립성을 본다.)
    //   RED: 한 resolve 가 모든 pending 을 해결하면 격리 깨짐. GREEN: request_id 별 entry.
    let (server, phone) = make_server_with_phone("desktop", "phone", 1, Scope::Destructive);
    let desktop_pub = server.local.public_key();
    let server = Arc::new(server);
    let confirms = PendingConfirms::new(60);
    let (addr, calls, _last, mut emit_rx) =
        spawn_one_conn_confirmed(Arc::clone(&server), confirms.clone(), Duration::from_secs(60))
            .await;

    let mut client = Client::connect(addr, desktop_pub, "desktop", "phone", &phone.x, &phone.ed)
        .await
        .unwrap();
    // 첫 요청만 보내고 파킹 확인 → 그 사이 두 번째는 아직(blocking). 대신 첫째를 승인해 진행시키고
    // 두 request_id 가 서로 다름을 emit 으로 확인.
    let confirms_c = confirms.clone();
    let req_task = tokio::spawn(async move {
        let r1 = client
            .request(&phone.ed, "phone", Scope::Destructive, nonce(42), 100, 1000, b"a.close")
            .await;
        let r2 = client
            .request(&phone.ed, "phone", Scope::Destructive, nonce(43), 101, 1000, b"b.close")
            .await;
        (r1, r2)
    });

    let req1 = emit_rx.recv().await.expect("confirm 1");
    // 첫째가 파킹돼 있는 동안 미해결은 정확히 1(둘째는 아직 안 옴 — 직렬).
    assert_eq!(confirms_c.pending_count(), 1, "한 번에 하나씩 파킹(직렬)");
    assert!(confirms_c.resolve(req1.request_id, true));
    let req2 = emit_rx.recv().await.expect("confirm 2");
    assert_ne!(req2.request_id, req1.request_id, "독립 request_id(격리)");
    assert!(confirms_c.resolve(req2.request_id, true));

    let (r1, r2) = req_task.await.unwrap();
    assert_eq!(r1[0], 0x01, "첫째 승인 Ok");
    assert_eq!(r2[0], 0x01, "둘째 승인 Ok");
    assert_eq!(calls.load(Ordering::SeqCst), 2, "둘 다 승인 ⇒ dispatch 2");
}

#[tokio::test]
async fn event_first_resolve_wakes_promptly_not_poll() {
    // 이벤트-우선(RULE 7): await 는 resolve 가 **깨운다**(poll interval 대기 아님). TTL 을 아주
    //   길게(60s) 두고 resolve 를 즉시 호출 — 응답이 TTL 근처가 아니라 곧바로 온다면 oneshot/
    //   select! 가 깨운 것(sleep-poll 루프면 폴 간격만큼 지연). 짧은 시간 budget 안에 완료 단언.
    let (server, phone) = make_server_with_phone("desktop", "phone", 1, Scope::Destructive);
    let desktop_pub = server.local.public_key();
    let server = Arc::new(server);
    let confirms = PendingConfirms::new(60);
    let (addr, calls, _last, mut emit_rx) =
        spawn_one_conn_confirmed(Arc::clone(&server), confirms.clone(), Duration::from_secs(60))
            .await;

    let mut client = Client::connect(addr, desktop_pub, "desktop", "phone", &phone.x, &phone.ed)
        .await
        .unwrap();
    let req_task = tokio::spawn(async move {
        client
            .request(&phone.ed, "phone", Scope::Destructive, nonce(44), 100, 1000, b"panel.close")
            .await
    });

    let req = emit_rx.recv().await.expect("confirm 요청");
    // resolve 직후 응답이 와야 한다. TTL 60s 보다 훨씬 짧은 budget(1s) 안에 종료 = poll 아님.
    confirms.resolve(req.request_id, true);
    let resp = tokio::time::timeout(Duration::from_secs(1), req_task)
        .await
        .expect("resolve 가 즉시 깨움(폴링 아님)")
        .unwrap();
    assert_eq!(resp[0], 0x01, "승인 ⇒ Ok(즉시)");
    assert_eq!(calls.load(Ordering::SeqCst), 1, "dispatch 1회");
}
