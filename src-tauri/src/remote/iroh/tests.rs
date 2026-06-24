// remote::iroh 테스트 — 두 LOCAL iroh endpoint(client + server)를 한 프로세스에서 iroh 의
// 직결(loopback direct address)로 잇고, 그 QUIC bi-stream **위에** serve_connection(Noise+auth+
// confirm)이 그대로 도는지 검증한다.
//
// **무엇을 검증하나(정직 — RULE 2)**: 이 테스트들은 **INTEGRATION/API** 를 못박는다 — iroh 의
// Endpoint/connect/accept/bi-stream API 위에 우리 보안 세션이 무수정으로 얹히고, node-id≠auth
// defense-in-depth 가 성립함을. RelayMode::Disabled + 직접 loopback 주소로 잇기 때문에 **실제 NAT
// hole-punching·릴레이 failover·CGNAT traversal 은 여기서 검증되지 않는다**(그건 서로 다른 두
// 네트워크의 실기기 2대가 필요 — 이 in-process 하니스로는 위조 불가, RULE 2). 즉:
//   - 검증됨(in-process): iroh API 통합, Noise-over-iroh 왕복, node-id-without-pinned-keys 실패,
//     ciphertext 불투명(transport zero-knowledge), 변조/재생 거부, off-by-default.
//   - 미검증(실기기 교차망 필요): NAT hole-punch 성공률, 릴레이 fallback 경로, mDNS 실네트워크 발견.
//
// 두 endpoint 는 같은 프로세스라 loopback 직결만으로 충분하다(릴레이 인프라 0). 서버는
// direct_addresses() 워처가 채워지면(initialized) 그 주소를 클라이언트에게 NodeAddr 로 직접 준다.

use super::*;

use crate::remote::auth::{CapabilityAssertion, DeviceRegistry, Scope};
use crate::remote::noise::{Handshake, NoiseChannel, PinnedPeerRegistry, StaticKeypair};
use crate::remote::session::RequestFrame;

use ed25519_dalek::{Signer, SigningKey};
// iroh 가 n0_watcher::Watcher 를 top-level 로 re-export(direct_addresses 의 initialized() 에 필요).
use iroh::{Endpoint, NodeAddr, RelayMode, SecretKey, Watcher};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
// AsyncWriteExt = SendStream::flush(인헤런트 아님). read_exact/write_all 은 RecvStream/SendStream 의
// 인헤런트라 AsyncReadExt 는 불요.
use tokio::io::AsyncWriteExt;

// ===========================================================================
// 헬퍼 — 키 생성, endpoint 빌드, loopback 직결 주소 해소, 길이-프리픽스 코덱.
// ===========================================================================

/// 결정적 Ed25519 device 키(테스트 고정). seed 로 서로 다른 폰을 만든다.
fn ed_key(seed: u8) -> SigningKey {
    let mut b = [0u8; 32];
    b[0] = seed;
    b[31] = 0x42;
    SigningKey::from_bytes(&b)
}

/// 결정적 iroh SecretKey(전송 node-id 고정). seed 로 desktop/phone endpoint 신원을 만든다.
/// **STATIC** 이라 같은 seed = 같은 node-id(안정적 다이얼 주소).
fn iroh_secret(seed: u8) -> SecretKey {
    let mut b = [0u8; 32];
    b[0] = seed;
    b[1] = 0x37;
    SecretKey::from_bytes(&b)
}

/// 우리 ALPN 으로 RelayMode::Disabled endpoint 를 만든다(릴레이 인프라 0 — 직결만, in-process).
async fn local_endpoint(seed: u8) -> Endpoint {
    Endpoint::builder()
        .secret_key(iroh_secret(seed))
        .alpns(vec![IROH_ALPN.to_vec()])
        .relay_mode(RelayMode::Disabled)
        .bind()
        .await
        .expect("iroh endpoint bind")
}

/// 서버 endpoint 의 직결 loopback 주소가 채워질 때까지 기다려 NodeAddr 를 만든다(클라이언트 다이얼 타겟).
/// RelayMode::Disabled 라 relay_url 은 없고 direct address 만 — 같은 머신 loopback 으로 직결된다.
async fn server_dial_addr(server: &Endpoint) -> NodeAddr {
    // direct_addresses() 워처가 첫 Some 으로 초기화될 때까지 await(폴링 0 — 워처 이벤트).
    // 워처 Value = Option<BTreeSet<DirectAddr>>; initialized() 는 첫 Some(BTreeSet<DirectAddr>)을 준다.
    let mut watcher = server.direct_addresses();
    let addrs: std::collections::BTreeSet<iroh::endpoint::DirectAddr> =
        watcher.initialized().await;
    let socket_addrs: Vec<SocketAddr> = addrs.into_iter().map(|da| da.addr).collect();
    assert!(
        !socket_addrs.is_empty(),
        "서버가 최소 한 개의 직결 주소를 보고해야 한다(loopback)"
    );
    NodeAddr::new(server.node_id()).with_direct_addresses(socket_addrs)
}

/// iroh bi-stream(SendStream)에 길이-프리픽스 1개 쓴다(transport.rs 코덱과 동일 — u32 BE).
async fn send_framed(send: &mut iroh::endpoint::SendStream, bytes: &[u8]) {
    send.write_all(&(bytes.len() as u32).to_be_bytes()).await.unwrap();
    send.write_all(bytes).await.unwrap();
    send.flush().await.unwrap();
}

/// iroh bi-stream(RecvStream)에서 길이-프리픽스 1개 읽는다(끊김 ⇒ panic).
async fn recv_framed(recv: &mut iroh::endpoint::RecvStream) -> Vec<u8> {
    recv_framed_opt(recv).await.expect("recv framed (stream closed)")
}

/// 길이-프리픽스 1개를 읽되, 스트림이 끊겼으면 None(서버가 KK 실패로 m2 없이 종료한 경우 등).
async fn recv_framed_opt(recv: &mut iroh::endpoint::RecvStream) -> Option<Vec<u8>> {
    let mut len = [0u8; 4];
    recv.read_exact(&mut len).await.ok()?;
    let mut body = vec![0u8; u32::from_be_bytes(len) as usize];
    recv.read_exact(&mut body).await.ok()?;
    Some(body)
}

/// 서버측 자원 묶음(Noise 신원 + 핀닝 + auth) 만들기. 한 폰을 ReadOnly 로 핀닝/페어링한다.
fn server_config(
    desktop_x: Arc<StaticKeypair>,
    phone_id: &str,
    phone_x_pub: [u8; 32],
    phone_ed_pub: [u8; 32],
) -> Arc<IrohListenerConfig> {
    let mut noise = PinnedPeerRegistry::new();
    noise.pin(phone_id, &phone_x_pub).unwrap();
    let mut auth = DeviceRegistry::new(4);
    auth.pair(phone_id, &phone_ed_pub, Scope::ReadOnly).unwrap();
    Arc::new(IrohListenerConfig {
        local: desktop_x,
        noise_registry: Arc::new(noise),
        auth: SharedAuth::new(auth),
    })
}

/// 서버측: 한 incoming 을 accept → accept_bi → serve_connection(dispatch 카운터). 단발 task.
/// dispatch 횟수를 Arc<AtomicU32> 로 반환해 "dispatch 0/1" 을 단언한다.
async fn spawn_server_once(
    server: Endpoint,
    config: Arc<IrohListenerConfig>,
) -> Arc<AtomicU32> {
    let calls = Arc::new(AtomicU32::new(0));
    let calls_task = Arc::clone(&calls);
    tokio::spawn(async move {
        if let Some(incoming) = server.accept().await {
            let conn = match incoming.await {
                Ok(c) => c,
                Err(_) => return,
            };
            let (send, recv) = match conn.accept_bi().await {
                Ok(p) => p,
                Err(_) => return,
            };
            let stream = JoinedStream::new(send, recv);
            let c = Arc::clone(&calls_task);
            let _ = serve_connection(
                stream,
                &config.local,
                &config.noise_registry,
                &config.auth,
                || 200u64, // 고정 now(테스트 신선도).
                |_p: &str| None, // 토큰 provider — 없음(read-only 경로엔 무관).
                move |_a: &AuthorizedAction, _r: &[u8]| -> Vec<u8> {
                    c.fetch_add(1, Ordering::SeqCst);
                    b"{\"ok\":true,\"echo\":\"ui.tree\"}".to_vec()
                },
            )
            .await;
        }
    });
    calls
}

/// 클라이언트(폰)측: open_bi → announce → KK initiate → 서명 ReadOnly frame 1개 왕복.
/// 반환: (복호된 응답 평문, 와이어로 나간 ciphertext 바이트들). pinned 여부는 호출자가 noise 핀닝으로 제어.
struct ClientResult {
    decrypted: Option<Vec<u8>>,
    /// 와이어로 나간 ciphertext(announce 제외 — 핸드셰이크 m1 + frame ct). 불투명성 검사용.
    wire_after_handshake: Vec<u8>,
    handshake_ok: bool,
}

/// 폰이 핀닝하는 데스크톱 키 선택 — defense-in-depth 의 핵심 변수.
enum DesktopKeyChoice {
    /// 정상 — 진짜 데스크톱 키를 핀닝(정상 경로).
    Correct([u8; 32]),
    /// **틀린 키** 를 핀닝 — iroh 로 정확히 닿아(announce+m1 전송) 서버 KK 까지 가지만, 정적-정적
    /// 바인딩이 깨져 서버 핸드셰이크가 미성립(DH/MAC 불일치) ⇒ 채널 0. 전송 도달 ≠ 인증의 증거.
    Wrong([u8; 32]),
}

#[allow(clippy::too_many_arguments)]
async fn run_client(
    client: &Endpoint,
    server_addr: NodeAddr,
    desktop_key: DesktopKeyChoice,
    phone_x: &StaticKeypair,
    phone_ed: &SigningKey,
    phone_id: &str,
    nonce_seed: u8,
) -> ClientResult {
    let conn = client
        .connect(server_addr, IROH_ALPN)
        .await
        .expect("iroh connect");
    let (mut send, mut recv) = conn.open_bi().await.expect("open_bi");

    // 1. announce(device_id) — 핸드셰이크 전 길이-프리픽스. **iroh 전송은 여기서 이미 성공**
    //    (서버에 바이트가 닿았다 = node-id 다이얼 성공). 인증은 그 다음 Noise 가 한다.
    send_framed(&mut send, phone_id.as_bytes()).await;

    // 2. 폰이 (선택한) 데스크톱 키를 핀닝 + KK initiate. Wrong 이면 m1 은 정상 전송되지만 서버측
    //    respond 가 진짜 키로 read_message 할 때 DH/MAC 이 안 맞아 미성립(채널 0).
    let pinned = match desktop_key {
        DesktopKeyChoice::Correct(k) => k,
        DesktopKeyChoice::Wrong(k) => k,
    };
    let mut peers = PinnedPeerRegistry::new();
    peers.pin("desktop", &pinned).unwrap();
    let mut ini = Handshake::initiate(phone_x, &peers, "desktop").expect("initiate");
    let m1 = ini.write_message().unwrap();
    // m1 은 항상 전송한다 — 서버 KK 까지 도달함을 보장(전송 reachability 증명). Wrong 이면 서버가
    // m1 read 에서 실패해 m2 를 안 보내거나(연결 종료) 보내도 우리 read_message 가 실패한다.
    send_framed(&mut send, &m1).await;
    let m2 = match recv_framed_opt(&mut recv).await {
        Some(b) => b,
        None => {
            // 서버가 KK 실패로 m2 없이 종료 — 채널 미성립(전송은 닿았으나 auth 0).
            return ClientResult {
                decrypted: None,
                wire_after_handshake: m1.clone(),
                handshake_ok: false,
            };
        }
    };
    if ini.read_message(&m2).is_err() {
        // m2 가 와도 정적-정적 바인딩 불일치 ⇒ 채널 미성립.
        return ClientResult {
            decrypted: None,
            wire_after_handshake: m1.clone(),
            handshake_ok: false,
        };
    }
    let mut ch: NoiseChannel = ini.into_channel().unwrap();

    // 3. 서명 ReadOnly frame.
    let mut nn = [0u8; 32];
    nn[0] = nonce_seed;
    nn[15] = 0xAB;
    let assertion = CapabilityAssertion {
        device_id: phone_id.to_string(),
        scope: Scope::ReadOnly,
        nonce: nn,
        issued_at: 100,
        exp: 1000,
    };
    let sig = phone_ed.sign(&assertion.canonical_bytes()).to_bytes().to_vec();
    let frame = RequestFrame {
        assertion,
        signature: sig,
        request: b"ui.tree".to_vec(),
    }
    .encode();
    let ct = ch.encrypt(&frame).unwrap();

    let mut wire = m1.clone();
    wire.extend_from_slice(&ct);

    send_framed(&mut send, &ct).await;
    let resp_ct = recv_framed(&mut recv).await;
    let plain = ch.decrypt(&resp_ct).unwrap();

    ClientResult {
        decrypted: Some(plain),
        wire_after_handshake: wire,
        handshake_ok: true,
    }
}

// ===========================================================================
// 테스트 1 (긍정) — Noise-over-iroh 왕복: 두 local endpoint 직결 + 페어링 폰이 dispatch 1회.
// ===========================================================================

#[tokio::test]
async fn noise_over_iroh_roundtrip_dispatches_once() {
    // 두 endpoint 가 iroh 직결로 잇고, 우리 Noise 핸드셰이크 + 서명 read-only frame 이 그 bi-stream
    // 위로 흘러 dispatch 1회 + 암호화 응답이 왕복한다(Noise-over-iroh 가 동작함을 증명).
    let desktop_x = Arc::new(StaticKeypair::generate().unwrap());
    let phone_x = StaticKeypair::generate().unwrap();
    let phone_ed = ed_key(1);
    let desktop_x_pub = desktop_x.public_key();

    let config = server_config(
        Arc::clone(&desktop_x),
        "phone-a",
        phone_x.public_key(),
        phone_ed.verifying_key().to_bytes(),
    );

    let server = local_endpoint(10).await;
    let client = local_endpoint(20).await;
    let dial = server_dial_addr(&server).await;

    let calls = spawn_server_once(server, config).await;
    let r = run_client(
        &client,
        dial,
        DesktopKeyChoice::Correct(desktop_x_pub), // 정상 — 진짜 데스크톱 키 핀닝.
        &phone_x,
        &phone_ed,
        "phone-a",
        1,
    )
    .await;

    assert!(r.handshake_ok, "핸드셰이크 성립");
    let plain = r.decrypted.expect("암호화 응답 왕복");
    assert_eq!(plain[0], 0x01, "SessionResponse::Ok(첫 바이트 0x01)");
    // 응답 평문에 dispatch 산출물이 담긴다(echo).
    assert!(
        String::from_utf8_lossy(&plain).contains("ok"),
        "dispatch 산출 응답이 복호된다"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1, "dispatch 정확히 1회");
}

// ===========================================================================
// 테스트 2 (RED→defense-in-depth) — 올바른 node-id + UNPINNED device key ⇒ Noise 미성립 ⇒ 0 dispatch.
// ===========================================================================

#[tokio::test]
async fn correct_node_id_with_wrong_device_key_fails_zero_dispatch() {
    // **node-id ≠ auth 의 핵심 증거(defense-in-depth)**: 폰이 서버의 **정확한 iroh node-id 로** 직결
    // 하고(transport 성공: connect+open_bi+announce+m1 가 전부 서버에 닿는다), 하지만 **틀린** 데스크톱
    // device key 를 핀닝해 KK 정적-정적 바인딩이 깨지면 서버 핸드셰이크가 미성립한다 ⇒ 채널 0 ⇒ dispatch 0.
    // iroh 연결(전송 도달)이 곧 접근 허용이 아님 — 올바른 node-id 도 Noise device-key 인증을 못 우회한다.
    let desktop_x = Arc::new(StaticKeypair::generate().unwrap());
    let phone_x = StaticKeypair::generate().unwrap();
    let phone_ed = ed_key(2);

    // 서버는 폰을 정상 핀닝/페어링했다(폰 잘못 아님 — 폰이 **진짜** 데스크톱 키를 모른다는 게 요점).
    let config = server_config(
        Arc::clone(&desktop_x),
        "phone-a",
        phone_x.public_key(),
        phone_ed.verifying_key().to_bytes(),
    );

    let server = local_endpoint(11).await;
    let client = local_endpoint(21).await;
    // 서버의 진짜 node-id 로 다이얼한다(주소는 정확 = transport 도달 성공).
    let dial = server_dial_addr(&server).await;
    assert_eq!(
        dial.node_id,
        server.node_id(),
        "정확한 node-id 로 다이얼(주소는 맞다 — 틀린 건 device key)"
    );

    // 폰이 핀닝하는 데스크톱 키 = **틀린 키**(진짜 desktop_x 와 다른 임의 X25519). announce+m1 은 서버에
    // 닿지만 서버가 진짜 키로 respond/read_message 할 때 DH/MAC 불일치 ⇒ 미성립.
    let wrong_desktop = StaticKeypair::generate().unwrap().public_key();
    assert_ne!(wrong_desktop, desktop_x.public_key(), "틀린 키여야 의미가 있다");

    let calls = spawn_server_once(server, config).await;
    let r = run_client(
        &client,
        dial,
        DesktopKeyChoice::Wrong(wrong_desktop), // 정확한 node-id, **틀린 device key**.
        &phone_x,
        &phone_ed,
        "phone-a",
        2,
    )
    .await;

    assert!(
        !r.handshake_ok,
        "틀린 device key ⇒ Noise 핸드셰이크 미성립(채널 0) — 전송은 닿았으나 auth 거부"
    );
    assert!(r.decrypted.is_none(), "채널이 없으니 응답도 없다");
    // 전송(announce+m1)이 서버에 닿았음에도 KK 가 깨져 dispatch 에 닿지 못한다.
    // 처리 여유를 준 뒤 0 을 단언.
    tokio::task::yield_now().await;
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "올바른 node-id + 틀린 device key ⇒ dispatch 0(node-id≠auth, 전송도달≠인증)"
    );
}

// ===========================================================================
// 테스트 3 (zero-knowledge) — 우리 평문 요청이 iroh 스트림 바이트에 노출되지 않는다.
// ===========================================================================

#[tokio::test]
async fn plaintext_request_not_visible_in_iroh_stream_bytes() {
    // 우리 Noise ciphertext 가 iroh bi-stream 위로 흐르므로, 평문 요청("ui.tree")이 와이어 바이트에
    // 그대로 나타나면 안 된다(transport/릴레이 zero-knowledge — iroh 위에서도 유지). 핸드셰이크 후
    // 와이어(m1 + frame ct)에 "ui.tree" 평문이 부재함을 단언한다.
    let desktop_x = Arc::new(StaticKeypair::generate().unwrap());
    let phone_x = StaticKeypair::generate().unwrap();
    let phone_ed = ed_key(3);
    let desktop_x_pub = desktop_x.public_key();
    let config = server_config(
        Arc::clone(&desktop_x),
        "phone-a",
        phone_x.public_key(),
        phone_ed.verifying_key().to_bytes(),
    );

    let server = local_endpoint(12).await;
    let client = local_endpoint(22).await;
    let dial = server_dial_addr(&server).await;
    let _calls = spawn_server_once(server, config).await;

    let r = run_client(
        &client,
        dial,
        DesktopKeyChoice::Correct(desktop_x_pub),
        &phone_x,
        &phone_ed,
        "phone-a",
        3,
    )
    .await;
    assert!(r.handshake_ok);

    // 평문 마커가 와이어 ciphertext 어디에도 없다(슬라이딩 윈도우 검색).
    let needle = b"ui.tree";
    let haystack = &r.wire_after_handshake;
    let leaked = haystack
        .windows(needle.len())
        .any(|w| w == needle);
    assert!(
        !leaked,
        "평문 요청('ui.tree')이 iroh 스트림 ciphertext 에 노출되면 안 된다(zero-knowledge)"
    );
    // 와이어가 비어있지 않음(실제로 바이트가 흐름 — 빈 비교로 통과하는 가짜 패스 0).
    assert!(haystack.len() > 16, "실제 ciphertext 바이트가 흐른다");
}

// ===========================================================================
// 테스트 4 (변조/재생) — 변조된 ciphertext 와 재생된 nonce 가 iroh 위에서도 거부된다.
// ===========================================================================

#[tokio::test]
async fn tampered_ciphertext_over_iroh_is_rejected() {
    // Noise AEAD 가 iroh 위에서도 변조를 잡는다 — 한 바이트 뒤집힌 ciphertext 는 복호 실패.
    // (Noise/auth 게이트는 transport-독립 — iroh 든 TCP 든 동일.) 서버가 변조 frame 에 dispatch 하지
    // 않음을 단언(서버는 복호 실패로 연결을 닫고 dispatch 0).
    let desktop_x = Arc::new(StaticKeypair::generate().unwrap());
    let phone_x = StaticKeypair::generate().unwrap();
    let phone_ed = ed_key(4);
    let config = server_config(
        Arc::clone(&desktop_x),
        "phone-a",
        phone_x.public_key(),
        phone_ed.verifying_key().to_bytes(),
    );
    let desktop_x_pub = desktop_x.public_key();

    let server = local_endpoint(13).await;
    let client = local_endpoint(23).await;
    let dial = server_dial_addr(&server).await;
    let calls = spawn_server_once(server, config).await;

    let conn = client.connect(dial, IROH_ALPN).await.expect("connect");
    let (mut send, mut recv) = conn.open_bi().await.expect("open_bi");
    send_framed(&mut send, b"phone-a").await;
    let mut peers = PinnedPeerRegistry::new();
    peers.pin("desktop", &desktop_x_pub).unwrap();
    let mut ini = Handshake::initiate(&phone_x, &peers, "desktop").unwrap();
    let m1 = ini.write_message().unwrap();
    send_framed(&mut send, &m1).await;
    let m2 = recv_framed(&mut recv).await;
    ini.read_message(&m2).unwrap();
    let mut ch: NoiseChannel = ini.into_channel().unwrap();

    let mut nn = [0u8; 32];
    nn[0] = 4;
    nn[15] = 0xAB;
    let assertion = CapabilityAssertion {
        device_id: "phone-a".to_string(),
        scope: Scope::ReadOnly,
        nonce: nn,
        issued_at: 100,
        exp: 1000,
    };
    let sig = phone_ed.sign(&assertion.canonical_bytes()).to_bytes().to_vec();
    let frame = RequestFrame { assertion, signature: sig, request: b"ui.tree".to_vec() }.encode();
    let mut ct = ch.encrypt(&frame).unwrap();
    // **변조** — 마지막 바이트(AEAD 태그 영역) 한 비트 뒤집기.
    let last = ct.len() - 1;
    ct[last] ^= 0x01;
    send_framed(&mut send, &ct).await;

    // 서버는 복호 실패(AEAD) → 연결 종료, dispatch 0. 읽기는 끊김(에러 가능) — 어느 쪽이든 dispatch 0.
    let mut len = [0u8; 4];
    let _ = recv.read_exact(&mut len).await; // 끊김 또는 빈 응답 — 결과 무관.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "변조된 ciphertext ⇒ AEAD 실패 ⇒ dispatch 0(Noise 게이트는 transport-독립)"
    );
}

#[tokio::test]
async fn replayed_nonce_over_iroh_is_rejected_on_second_frame() {
    // 같은 nonce 의 frame 을 두 번 보내면 두 번째는 nonce 단일사용 소비로 거부된다(재생방지).
    // 첫 frame 은 dispatch 1, 두 번째(같은 nonce)는 dispatch 안 됨 → 총 dispatch 1.
    // (auth floor 의 NonceLedger 는 transport-독립 — iroh 위에서도 동일.)
    let desktop_x = Arc::new(StaticKeypair::generate().unwrap());
    let phone_x = StaticKeypair::generate().unwrap();
    let phone_ed = ed_key(5);
    let config = server_config(
        Arc::clone(&desktop_x),
        "phone-a",
        phone_x.public_key(),
        phone_ed.verifying_key().to_bytes(),
    );
    let desktop_x_pub = desktop_x.public_key();

    let server = local_endpoint(14).await;
    let client = local_endpoint(24).await;
    let dial = server_dial_addr(&server).await;
    let calls = spawn_server_once(server, config).await;

    let conn = client.connect(dial, IROH_ALPN).await.expect("connect");
    let (mut send, mut recv) = conn.open_bi().await.expect("open_bi");
    send_framed(&mut send, b"phone-a").await;
    let mut peers = PinnedPeerRegistry::new();
    peers.pin("desktop", &desktop_x_pub).unwrap();
    let mut ini = Handshake::initiate(&phone_x, &peers, "desktop").unwrap();
    let m1 = ini.write_message().unwrap();
    send_framed(&mut send, &m1).await;
    let m2 = recv_framed(&mut recv).await;
    ini.read_message(&m2).unwrap();
    let mut ch: NoiseChannel = ini.into_channel().unwrap();

    // 같은 nonce 의 동일 assertion 을 두 frame 으로 보낸다.
    let mut nn = [0u8; 32];
    nn[0] = 9;
    nn[15] = 0xAB;
    let make_ct = |ch: &mut NoiseChannel| -> Vec<u8> {
        let assertion = CapabilityAssertion {
            device_id: "phone-a".to_string(),
            scope: Scope::ReadOnly,
            nonce: nn,
            issued_at: 100,
            exp: 1000,
        };
        let sig = phone_ed.sign(&assertion.canonical_bytes()).to_bytes().to_vec();
        let frame = RequestFrame { assertion, signature: sig, request: b"ui.tree".to_vec() }.encode();
        ch.encrypt(&frame).unwrap()
    };

    // frame 1 — dispatch 1, 응답 왕복.
    let ct1 = make_ct(&mut ch);
    send_framed(&mut send, &ct1).await;
    let resp1 = recv_framed(&mut recv).await;
    let plain1 = ch.decrypt(&resp1).unwrap();
    assert_eq!(plain1[0], 0x01, "frame1 Ok");

    // frame 2 — 같은 nonce. 서버는 거부(dispatch 안 함)하되 암호화된 Denied 응답을 돌려준다.
    let ct2 = make_ct(&mut ch);
    send_framed(&mut send, &ct2).await;
    let resp2 = recv_framed(&mut recv).await;
    let plain2 = ch.decrypt(&resp2).unwrap();
    assert_ne!(plain2[0], 0x01, "frame2(재생 nonce) Ok 아님 = 거부");

    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "재생 nonce 두 번째 frame ⇒ dispatch 0(첫 frame 만 1 — NonceLedger transport-독립)"
    );
}

// ===========================================================================
// 테스트 5 (off by default) — enable 플래그 없이는 어떤 iroh accept task 도 시작되지 않는다.
// ===========================================================================

#[test]
fn iroh_bridge_disabled_by_default() {
    // bridge glue 의 iroh enable 플래그가 꺼져 있으면(미설정) maybe_start 가 아무 endpoint 도 bind 하지
    // 않는다 — 순수 함수로 단언(env 미설정 = 비활성). 이 테스트는 bridge.rs 의 enable 판정을 본다.
    // (env 변이는 프로세스 전역이라 직접 set 대신 "미설정 → false" 만 확정한다 — 다른 테스트 오염 0.)
    std::env::remove_var(crate::remote::bridge::IROH_ENABLE_ENV);
    assert!(
        !crate::remote::bridge::iroh_enabled(),
        "iroh enable env 미설정 ⇒ 비활성(off by default — bind 0)"
    );
}
