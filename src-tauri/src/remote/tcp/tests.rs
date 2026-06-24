// remote::tcp 테스트 — 루프백 전용 바인드 + accept_loop 의 연결 격리(진짜 소켓).
// transport/tests.rs 가 serve_connection 의 보안 체인을 전수하므로, 여기서는 TCP transport
// 고유의 두 불변식만 못박는다: (1) 127.0.0.1 전용 바인드(SSRF/rebinding 0), (2) accept_loop 가
// 여러 연결을 각각 격리 task 로 서비스(한 연결이 다른 연결에 무영향).

use super::*;
use crate::remote::auth::{CapabilityAssertion, DeviceRegistry, Scope};
use crate::remote::noise::{Handshake, NoiseChannel, PinnedPeerRegistry, StaticKeypair};
use crate::remote::session::RequestFrame;
use ed25519_dalek::{Signer, SigningKey};
use std::net::IpAddr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

fn ed_key(seed: u8) -> SigningKey {
    let mut b = [0u8; 32];
    b[0] = seed;
    b[31] = 0x42;
    SigningKey::from_bytes(&b)
}

// ===========================================================================
// 루프백 전용 바인드 — 127.0.0.1, 0.0.0.0 아님(매트릭스 "reverse-proxy SSRF" · "DNS rebinding").
// ===========================================================================

#[tokio::test]
async fn bind_is_loopback_only_not_wildcard() {
    // RED(방어 전): 0.0.0.0 바인드면 외부 인터페이스 노출(임의 접근/rebinding). GREEN: 항상 127.0.0.1.
    let listener = bind_loopback(0).await.expect("bind");
    let ip = listener.local_addr().unwrap().ip();
    assert_eq!(ip, IpAddr::V4(LOOPBACK), "127.0.0.1 전용");
    assert!(ip.is_loopback(), "루프백");
    assert!(!ip.is_unspecified(), "0.0.0.0 아님(전체 인터페이스 노출 0)");
}

#[tokio::test]
async fn loopback_constant_is_127_0_0_1() {
    // 바인드 상수가 127.0.0.1 임을 직접 단언(코드 위치 못박기 — 다른 주소로 바꾸면 깨짐).
    assert_eq!(LOOPBACK.octets(), [127, 0, 0, 1], "LOOPBACK == 127.0.0.1");
}

// ===========================================================================
// accept_loop — 두 연결을 각각 격리 task 로 서비스(한 연결 무영향).
// ===========================================================================

/// 진짜 소켓 위의 최소 클라이언트(폰) — announce + KK initiator + frame 1개 왕복.
async fn one_shot_request(
    addr: std::net::SocketAddr,
    desktop_public: [u8; 32],
    phone_x: &StaticKeypair,
    phone_ed: &SigningKey,
    phone_id: &str,
    n: u8,
) -> Vec<u8> {
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    // announce.
    send_framed(&mut stream, phone_id.as_bytes()).await;
    // 폰이 데스크톱 핀닝 + KK initiate.
    let mut peers = PinnedPeerRegistry::new();
    peers.pin("desktop", &desktop_public).unwrap();
    let mut ini = Handshake::initiate(phone_x, &peers, "desktop").expect("initiate");
    let m1 = ini.write_message().unwrap();
    send_framed(&mut stream, &m1).await;
    let m2 = recv_framed(&mut stream).await;
    ini.read_message(&m2).unwrap();
    let mut ch: NoiseChannel = ini.into_channel().unwrap();
    // 서명 frame.
    let mut nn = [0u8; 32];
    nn[0] = n;
    nn[15] = 0xAB;
    let assertion = CapabilityAssertion {
        device_id: phone_id.to_string(),
        scope: Scope::ReadOnly,
        nonce: nn,
        issued_at: 100,
        exp: 1000,
    };
    let sig = phone_ed.sign(&assertion.canonical_bytes()).to_bytes().to_vec();
    let frame = RequestFrame { assertion, signature: sig, request: b"ui.tree".to_vec() }.encode();
    let ct = ch.encrypt(&frame).unwrap();
    send_framed(&mut stream, &ct).await;
    let resp_ct = recv_framed(&mut stream).await;
    ch.decrypt(&resp_ct).unwrap()
}

async fn send_framed(stream: &mut TcpStream, bytes: &[u8]) {
    stream.write_all(&(bytes.len() as u32).to_be_bytes()).await.unwrap();
    stream.write_all(bytes).await.unwrap();
    stream.flush().await.unwrap();
}
async fn recv_framed(stream: &mut TcpStream) -> Vec<u8> {
    let mut len = [0u8; 4];
    stream.read_exact(&mut len).await.unwrap();
    let mut body = vec![0u8; u32::from_be_bytes(len) as usize];
    stream.read_exact(&mut body).await.unwrap();
    body
}

#[tokio::test]
async fn accept_loop_serves_two_isolated_connections() {
    // accept_loop 가 두 폰을 각각 독립 task 로 서비스 — 둘 다 dispatch 성공, 서로 무영향.
    let local = std::sync::Arc::new(StaticKeypair::generate().unwrap());
    let pa_x = StaticKeypair::generate().unwrap();
    let pb_x = StaticKeypair::generate().unwrap();
    let pa_ed = ed_key(1);
    let pb_ed = ed_key(2);

    let mut noise = PinnedPeerRegistry::new();
    noise.pin("phone-a", &pa_x.public_key()).unwrap();
    noise.pin("phone-b", &pb_x.public_key()).unwrap();
    let mut auth = DeviceRegistry::new(4);
    auth.pair("phone-a", &pa_ed.verifying_key().to_bytes(), Scope::ReadOnly).unwrap();
    auth.pair("phone-b", &pb_ed.verifying_key().to_bytes(), Scope::ReadOnly).unwrap();

    let desktop_pub = local.public_key();
    let config = std::sync::Arc::new(ListenerConfig {
        local,
        noise_registry: std::sync::Arc::new(noise),
        auth: SharedAuth::new(auth),
    });

    let listener = bind_loopback(0).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let calls = std::sync::Arc::new(AtomicU32::new(0));
    let calls_fac = std::sync::Arc::clone(&calls);

    // accept_loop 백그라운드 — dispatch 는 호출 카운터.
    tokio::spawn(async move {
        accept_loop(
            listener,
            config,
            || || 200u64,
            || |_p: &str| None,
            move || {
                let c = std::sync::Arc::clone(&calls_fac);
                let _slot = std::sync::Arc::new(Mutex::new(Vec::<u8>::new()));
                move |_a: &AuthorizedAction, _r: &[u8]| -> Vec<u8> {
                    c.fetch_add(1, Ordering::SeqCst);
                    b"{\"ok\":true}".to_vec()
                }
            },
        )
        .await;
    });

    let ra = one_shot_request(addr, desktop_pub, &pa_x, &pa_ed, "phone-a", 1).await;
    let rb = one_shot_request(addr, desktop_pub, &pb_x, &pb_ed, "phone-b", 2).await;
    assert_eq!(ra[0], 0x01, "A Ok");
    assert_eq!(rb[0], 0x01, "B Ok");
    assert_eq!(calls.load(Ordering::SeqCst), 2, "두 격리 연결 각각 dispatch 1회 = 2");
}

#[tokio::test]
async fn accept_loop_unpaired_connection_no_dispatch_others_survive() {
    // 미페어링 폰이 먼저 연결 시도(핸드셰이크 미성립) → dispatch 0. 그 직후 페어링 폰은 정상.
    //   accept_loop 가 실패한 연결 task 로 죽지 않음을 단언(연결 격리 + 리스너 생존).
    let local = std::sync::Arc::new(StaticKeypair::generate().unwrap());
    let pa_x = StaticKeypair::generate().unwrap();
    let pa_ed = ed_key(1);
    let mut noise = PinnedPeerRegistry::new();
    noise.pin("phone-a", &pa_x.public_key()).unwrap();
    let mut auth = DeviceRegistry::new(4);
    auth.pair("phone-a", &pa_ed.verifying_key().to_bytes(), Scope::ReadOnly).unwrap();
    let desktop_pub = local.public_key();
    let config = std::sync::Arc::new(ListenerConfig {
        local,
        noise_registry: std::sync::Arc::new(noise),
        auth: SharedAuth::new(auth),
    });

    let listener = bind_loopback(0).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let calls = std::sync::Arc::new(AtomicU32::new(0));
    let calls_fac = std::sync::Arc::clone(&calls);
    tokio::spawn(async move {
        accept_loop(
            listener,
            config,
            || || 200u64,
            || |_p: &str| None,
            move || {
                let c = std::sync::Arc::clone(&calls_fac);
                move |_a: &AuthorizedAction, _r: &[u8]| -> Vec<u8> {
                    c.fetch_add(1, Ordering::SeqCst);
                    b"{\"ok\":true}".to_vec()
                }
            },
        )
        .await;
    });

    // 미페어링 폰(핀닝 안 된 키)으로 announce + 핸드셰이크 시도 → m2 안 옴 → 실패.
    let bad_x = StaticKeypair::generate().unwrap();
    {
        let mut stream = TcpStream::connect(addr).await.unwrap();
        send_framed(&mut stream, b"phone-a").await; // 핀닝 id 지만 키가 다름.
        let mut peers = PinnedPeerRegistry::new();
        peers.pin("desktop", &desktop_pub).unwrap();
        let mut ini = Handshake::initiate(&bad_x, &peers, "desktop").unwrap();
        let m1 = ini.write_message().unwrap();
        send_framed(&mut stream, &m1).await;
        // 서버는 read_message 에서 DH/MAC 불일치로 실패 → m2 없이 종료.
        let mut len = [0u8; 4];
        let r = stream.read_exact(&mut len).await;
        assert!(r.is_err(), "미페어링 ⇒ 서버가 m2 없이 종료");
    }

    // 페어링 폰은 정상(리스너가 살아있고 격리됨).
    let ra = one_shot_request(addr, desktop_pub, &pa_x, &pa_ed, "phone-a", 7).await;
    assert_eq!(ra[0], 0x01, "페어링 폰은 미페어링 연결 실패 후에도 정상");
    assert_eq!(calls.load(Ordering::SeqCst), 1, "미페어링 dispatch 0 + 페어링 1 = 1");
}
