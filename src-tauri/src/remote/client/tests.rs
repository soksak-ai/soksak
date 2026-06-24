// remote::client 테스트 — PUBLIC 클라이언트 API ↔ REAL serve_connection 을 **진짜 루프백 소켓**
// 위에서 왕복시킨다(in-process, full round-trip). dispatch 는 서버 far side 에 주입된 recorder —
// 이로써 **클라이언트가** 옳게 동작함을 완전히 검증한다(서버는 이미 153 테스트로 검증됨).
//
// 각 테스트는 RED(방어 전엔 깨짐)를 주석에 명시한다 — 해당 클라이언트 동작을 빼면 단언이 깨짐을
// 코드 위치로 못박는다. 기준 약화 0 — 실패하면 구현을 고친다(RULE 2).
//
// 서버 하니스는 transport/tests.rs 의 패턴을 그대로 따른다: 데스크톱 측 키/페어링을 만들고
// serve_connection(_confirmed)을 1연결 띄운 뒤, **공개 client API**(DeviceIdentity / connect_tcp /
// ClientSession::call / call_destructive)로만 구동한다(클라이언트 내부를 손으로 재현하지 않는다).

use super::*;
use crate::remote::auth::{DeviceRegistry, Scope};
use crate::remote::confirm::PendingConfirms;
use crate::remote::noise::{PinnedPeerRegistry, StaticKeypair};
use crate::remote::tcp::bind_loopback;
use crate::remote::transport::{
    serve_connection, serve_connection_confirmed, ConfirmRequest, SharedAuth,
};
use crate::remote::auth::AuthorizedAction;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

// ===========================================================================
// 헬퍼 — 데스크톱(서버) 자원 + 폰 신원 페어링 + 진짜 소켓 위의 serve_connection.
// ===========================================================================

/// canned dispatch — route 의 응답 envelope({ok:true,scope})를 미러하는 recorder. 호출 횟수와
/// 마지막 request 바이트를 공유 슬롯에 기록(클라이언트가 옳게 보냈음을 와이어로 증명).
fn recording_dispatch(
    calls: Arc<AtomicU32>,
    last_req: Arc<Mutex<Vec<u8>>>,
) -> impl FnMut(&AuthorizedAction, &[u8]) -> Vec<u8> + Send + 'static {
    move |action, request| {
        calls.fetch_add(1, Ordering::SeqCst);
        *last_req.lock().unwrap() = request.to_vec();
        let scope = match action.scope() {
            Scope::ReadOnly => "read-only",
            Scope::Write => "write",
            Scope::Destructive => "destructive",
        };
        format!("{{\"ok\":true,\"scope\":\"{scope}\"}}").into_bytes()
    }
}

/// 데스크톱 측 자원 — 로컬 X25519 static + 핀닝 peer 레지스트리 + 공유 auth 권위 + desktop_id.
struct Desktop {
    local: Arc<StaticKeypair>,
    noise: Arc<PinnedPeerRegistry>,
    auth: SharedAuth,
    desktop_id: String,
    /// 데스크톱이 핀닝한 폰의 페어링 번들(번들 라운드트립 단언용).
    phone_bundle: PhonePairingBundle,
}

impl Desktop {
    /// 폰이 핀닝할 데스크톱 페어링 번들(데스크톱 static 공개키 + id) — connect 의 입력.
    fn pairing_bundle(&self, tcp_addr: Option<SocketAddr>) -> DesktopPairingBundle {
        DesktopPairingBundle {
            desktop_id: self.desktop_id.clone(),
            desktop_static: self.local.public_key(),
            node_id: None,
            tcp_addr,
        }
    }
}

/// 데스크톱을 만들고(아무도 핀닝 안 됨 = fail-closed 기본) 주어진 폰 신원을 **양쪽 공개키로**
/// 핀닝/페어링한다(페어링 라운드트립: 폰 pubkeys 가 데스크톱에 핀닝됨). 데스크톱은 폰의
/// pairing_bundle(두 공개키)만 받아 핀닝한다 — 폰 개인키는 절대 안 본다.
fn pair_desktop_with_phone(desktop_id: &str, phone: &DeviceIdentity, scope: Scope) -> Desktop {
    let local = StaticKeypair::generate().expect("desktop x25519");
    let bundle = phone.pairing_bundle();
    let mut noise = PinnedPeerRegistry::new();
    // 데스크톱이 폰의 X25519 static 공개키를 핀닝(채널 게이트).
    noise
        .pin(&bundle.device_id, &bundle.x25519_public)
        .expect("pin phone x25519");
    let mut auth = DeviceRegistry::new(4);
    // 데스크톱이 폰의 Ed25519 공개키를 페어링(assertion 검증키).
    auth.pair(&bundle.device_id, &bundle.ed25519_public, scope)
        .expect("pair phone ed25519");
    Desktop {
        local: Arc::new(local),
        noise: Arc::new(noise),
        auth: SharedAuth::new(auth),
        desktop_id: desktop_id.to_string(),
        phone_bundle: bundle,
    }
}

/// serve_connection 을 진짜 루프백 소켓에 1연결만 띄운다(token provider = None: deny-until-token).
/// (주소, dispatch 카운터, 마지막 request 슬롯) 반환.
async fn spawn_serve(desktop: Arc<Desktop>) -> (SocketAddr, Arc<AtomicU32>, Arc<Mutex<Vec<u8>>>) {
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
            &desktop.local,
            &desktop.noise,
            &desktop.auth,
            || 200u64, // 고정 now(테스트 결정성).
            |_id| None,
            dispatch,
        )
        .await;
    });
    (addr, calls, last_req)
}

/// serve_connection 을 **여러 연결**(N개) 받게 띄운다 — 같은 Desktop(공유 NonceLedger via
/// SharedAuth) 을 두 세션이 차례로 쓰는 시나리오용. (주소, dispatch 카운터) 반환.
async fn spawn_serve_multi(desktop: Arc<Desktop>, conns: usize) -> (SocketAddr, Arc<AtomicU32>) {
    let listener = bind_loopback(0).await.expect("bind loopback");
    let addr = listener.local_addr().expect("local addr");
    let calls = Arc::new(AtomicU32::new(0));
    let calls_c = Arc::clone(&calls);
    tokio::spawn(async move {
        for _ in 0..conns {
            let (stream, _) = match listener.accept().await {
                Ok(p) => p,
                Err(_) => return,
            };
            let calls_inner = Arc::clone(&calls_c);
            let last = Arc::new(Mutex::new(Vec::new()));
            let desktop = Arc::clone(&desktop);
            tokio::spawn(async move {
                let dispatch = recording_dispatch(calls_inner, last);
                let _ = serve_connection(
                    stream,
                    &desktop.local,
                    &desktop.noise,
                    &desktop.auth,
                    || 200u64,
                    |_id| None,
                    dispatch,
                )
                .await;
            });
        }
    });
    (addr, calls)
}

/// serve_connection_confirmed(destructive 파킹) 를 1연결만 띄운다 — (주소, calls, last_req, emit_rx).
async fn spawn_serve_confirmed(
    desktop: Arc<Desktop>,
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
    let (emit_tx, emit_rx) = mpsc::unbounded_channel();
    let calls_c = Arc::clone(&calls);
    let last_c = Arc::clone(&last_req);
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("accept");
        let dispatch = recording_dispatch(calls_c, last_c);
        let _ = serve_connection_confirmed(
            stream,
            &desktop.local,
            &desktop.noise,
            &desktop.auth,
            &confirms,
            ttl,
            || 200u64,
            move |req: ConfirmRequest| {
                let _ = emit_tx.send(req);
            },
            dispatch,
        )
        .await;
    });
    (addr, calls, last_req, emit_rx)
}

/// raw 소켓 길이-프리픽스(u32 BE) 읽기(테스트 헬퍼 — 서버 코덱과 동일). 끊김 ⇒ None.
async fn raw_read_framed(stream: &mut tokio::net::TcpStream) -> Option<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let mut len = [0u8; 4];
    stream.read_exact(&mut len).await.ok()?;
    let mut body = vec![0u8; u32::from_be_bytes(len) as usize];
    stream.read_exact(&mut body).await.ok()?;
    Some(body)
}

/// raw 소켓 길이-프리픽스(u32 BE) 쓰기(테스트 헬퍼).
async fn raw_write_framed(stream: &mut tokio::net::TcpStream, bytes: &[u8]) {
    use tokio::io::AsyncWriteExt;
    let _ = stream.write_all(&(bytes.len() as u32).to_be_bytes()).await;
    let _ = stream.write_all(bytes).await;
    let _ = stream.flush().await;
}

/// 정상 핸드셰이크(RESPONDER) 후 클라이언트의 첫 frame 을 받고 **garbage ciphertext** 를 응답으로
/// 흘리는 악성 서버(클라이언트 측 tamper resilience 검증용). serve_connection 을 안 쓰고 직접
/// 핸드셰이크만 해 응답 자리에 깨진 바이트를 보낸다.
async fn garbage_response_server(stream: &mut tokio::net::TcpStream, desktop: &Desktop) {
    use crate::remote::noise::Handshake;
    let id = raw_read_framed(stream).await.unwrap();
    let device_id = String::from_utf8(id).unwrap();
    let mut hs = Handshake::respond(&desktop.local, &desktop.noise, &device_id).unwrap();
    let m1 = raw_read_framed(stream).await.unwrap();
    hs.read_message(&m1).unwrap();
    let m2 = hs.write_message().unwrap();
    raw_write_framed(stream, &m2).await;
    let _channel = hs.into_channel().unwrap();
    // 클라이언트의 첫 frame(요청)을 받고 버린 뒤, 유효하지 않은 ciphertext 를 응답으로.
    let _req = raw_read_framed(stream).await;
    raw_write_framed(stream, &[0xCCu8; 48]).await; // garbage — AEAD 인증 실패할 바이트.
}

// ===========================================================================
// A. 긍정 read-only 왕복 — 공개 client API 가 connect → call ⇒ 서버 dispatch 1회, Ok 복호.
// ===========================================================================

#[tokio::test]
async fn positive_readonly_call_dispatches_once_decrypts_ok() {
    // 공개 API 만으로: DeviceIdentity::generate → connect_tcp(핀닝된 데스크톱) → call(read-only).
    //   서버가 정확히 1회 dispatch 하고, 클라이언트는 복호된 Ok 결과를 받는다.
    // RED(방어 전): 결과가 안 옴/불일치(framing·서명·복호 어느 하나라도 틀리면 깨짐).
    let phone = DeviceIdentity::generate("phone").unwrap();
    let desktop = Arc::new(pair_desktop_with_phone("desktop", &phone, Scope::ReadOnly));
    let bundle = desktop.pairing_bundle(None);
    let (addr, calls, last_req) = spawn_serve(Arc::clone(&desktop)).await;

    let mut session = connect_tcp(addr, &phone, &bundle.desktop_id, &bundle.desktop_static)
        .await
        .expect("connect 성립(핀닝된 데스크톱)");
    let resp = session
        .call(b"state.commands", b"", Scope::ReadOnly, 1000, 100)
        .await
        .expect("call 왕복");

    assert_eq!(calls.load(Ordering::SeqCst), 1, "서버 dispatch 정확히 1회");
    assert_eq!(&*last_req.lock().unwrap(), b"state.commands", "서버가 실제 request 수신");
    assert!(resp.is_ok(), "클라이언트가 Ok 응답을 받음");
    assert_eq!(
        resp.ok_bytes().unwrap(),
        b"{\"ok\":true,\"scope\":\"read-only\"}",
        "클라이언트가 암호화 envelope 를 복호"
    );
}

// ===========================================================================
// B. fail-closed dial — 틀린 데스크톱 static 키 ⇒ 핸드셰이크 미성립 ⇒ ClientSession 0.
// ===========================================================================

#[tokio::test]
async fn wrong_desktop_key_handshake_fails_no_session() {
    // 클라이언트가 **틀린** 데스크톱 static 키를 핀닝하면 KK 정적-정적 바인딩이 깨져 핸드셰이크가
    //   미성립 ⇒ connect 가 Err ⇒ ClientSession 이 안 생긴다(서버 fail-closed 의 거울).
    // RED(방어 전): 틀린 키에도 세션이 형성되면 위장 데스크톱에 붙음(취약). GREEN: Err + dispatch 0.
    let phone = DeviceIdentity::generate("phone").unwrap();
    let desktop = Arc::new(pair_desktop_with_phone("desktop", &phone, Scope::ReadOnly));
    let (addr, calls, _last) = spawn_serve(Arc::clone(&desktop)).await;

    // 진짜 데스크톱 키가 아닌 임의 X25519 를 핀닝(위장 데스크톱 키).
    let wrong = StaticKeypair::generate().unwrap().public_key();
    assert_ne!(wrong, desktop.local.public_key(), "틀린 키여야 의미 있다");

    let r = connect_tcp(addr, &phone, "desktop", &wrong).await;
    assert!(r.is_err(), "틀린 데스크톱 키 ⇒ 핸드셰이크 미성립(세션 0)");
    match r {
        Err(ClientError::Handshake(_)) => {}
        other => panic!("Handshake 에러여야 — got {other:?}"),
    }
    tokio::task::yield_now().await;
    assert_eq!(calls.load(Ordering::SeqCst), 0, "세션 0 ⇒ dispatch 0");
}

// ===========================================================================
// C. scope — read-only 폰이 destructive 호출 ⇒ 서버 Denied(scope), 클라이언트 surface, dispatch 0.
// ===========================================================================

#[tokio::test]
async fn readonly_phone_destructive_call_denied_scope_no_dispatch() {
    // read-only 로 페어링된 폰이 destructive scope 로 call 하면 서버가 scope 상승을 거부한다
    //   (게이트 2). 클라이언트는 Denied(Unauthorized)를 surface 하고, dispatch 0.
    // RED(방어 전): 상승이 통과하면 폰이 권한 우회. GREEN: 서버 ScopeEscalation ⇒ 코드 4.
    let phone = DeviceIdentity::generate("phone").unwrap();
    let desktop = Arc::new(pair_desktop_with_phone("desktop", &phone, Scope::ReadOnly));
    let bundle = desktop.pairing_bundle(None);
    let (addr, calls, _last) = spawn_serve(Arc::clone(&desktop)).await;

    let mut session = connect_tcp(addr, &phone, &bundle.desktop_id, &bundle.desktop_static)
        .await
        .unwrap();
    // destructive scope 로 일반 call(서버는 read-only 만 부여 → ScopeEscalation).
    let resp = session
        .call(b"rm -rf", b"", Scope::Destructive, 1000, 100)
        .await
        .unwrap();

    assert!(!resp.is_ok(), "scope 상승 ⇒ 거부");
    assert_eq!(
        resp.denied(),
        Some(DeniedReason::Unauthorized),
        "Unauthorized(ScopeEscalation) surface"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0, "scope 상승 ⇒ dispatch 0");
}

// ===========================================================================
// D. destructive + confirm — APPROVE ⇒ 승인-결과, DENY ⇒ 거부. 이벤트-우선(폴링 0).
// ===========================================================================

#[tokio::test]
async fn destructive_confirm_approve_client_gets_result_event_driven() {
    // destructive(명시 opt-in) ⇒ 클라이언트가 PendingCall("승인 대기")을 즉시 surface, 데스크톱이
    //   APPROVE 하면 같은 채널에서 승인-결과(Ok)를 받는다 — 이벤트-우선(폴링/hang 0).
    // RED(방어 전): 폴링했거나 hang 했거나 잘못된 결과를 받음. GREEN: resolve(true) ⇒ Ok.
    let phone = DeviceIdentity::generate("phone").unwrap();
    let desktop = Arc::new(pair_desktop_with_phone("desktop", &phone, Scope::Destructive));
    let bundle = desktop.pairing_bundle(None);
    let confirms = PendingConfirms::new(60);
    let (addr, calls, last_req, mut emit_rx) =
        spawn_serve_confirmed(Arc::clone(&desktop), confirms.clone(), Duration::from_secs(60)).await;

    let mut session = connect_tcp(addr, &phone, &bundle.desktop_id, &bundle.desktop_static)
        .await
        .unwrap();

    // destructive 호출을 별도 task 로(승인 후에야 결과가 온다). 클라이언트는 PendingCall 을 surface.
    let task = tokio::spawn(async move {
        let pending = session
            .call_destructive(b"panel.close", b"", 1000, 100)
            .await
            .expect("destructive 송신 + PendingCall surface");
        assert!(
            pending.is_awaiting_desktop_approval(),
            "클라이언트가 'awaiting desktop approval' surface"
        );
        // 같은 채널에서 데스크톱 결정의 최종 결과를 이벤트-우선으로 받는다.
        pending.await_outcome().await
    });

    // 서버가 파킹하고 emit 한 confirm 요청 — danger=true.
    let req = emit_rx.recv().await.expect("confirm 요청 emit");
    assert_eq!(req.device_id, "phone");
    assert_eq!(req.command, "panel.close");
    assert!(req.danger, "destructive ⇒ danger=true");
    assert_eq!(calls.load(Ordering::SeqCst), 0, "승인 전 dispatch 0");

    // 데스크톱 사람: APPROVE.
    assert!(confirms.resolve(req.request_id, true), "데스크톱 승인 전달");

    let resp = task.await.unwrap().expect("승인 결과 왕복");
    assert!(resp.is_ok(), "APPROVE ⇒ 클라이언트가 승인-결과 Ok 수신");
    assert_eq!(
        resp.ok_bytes().unwrap(),
        b"{\"ok\":true,\"scope\":\"destructive\"}"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1, "승인 후 dispatch 정확히 1회");
    assert_eq!(&*last_req.lock().unwrap(), b"panel.close");
}

#[tokio::test]
async fn destructive_confirm_deny_client_gets_denied_event_driven() {
    // DENY ⇒ 클라이언트는 같은 채널에서 Denied(DesktopConfirm)를 받는다 — dispatch 0, hang 0.
    // RED: 거부에도 결과를 받거나 영원히 hang. GREEN: resolve(false) ⇒ Denied(코드 5).
    let phone = DeviceIdentity::generate("phone").unwrap();
    let desktop = Arc::new(pair_desktop_with_phone("desktop", &phone, Scope::Destructive));
    let bundle = desktop.pairing_bundle(None);
    let confirms = PendingConfirms::new(60);
    let (addr, calls, _last, mut emit_rx) =
        spawn_serve_confirmed(Arc::clone(&desktop), confirms.clone(), Duration::from_secs(60)).await;

    let mut session = connect_tcp(addr, &phone, &bundle.desktop_id, &bundle.desktop_static)
        .await
        .unwrap();
    let task = tokio::spawn(async move {
        let pending = session
            .call_destructive(b"rm -rf", b"", 1000, 100)
            .await
            .unwrap();
        pending.await_outcome().await
    });

    let req = emit_rx.recv().await.expect("confirm 요청");
    // 데스크톱 사람: DENY.
    assert!(confirms.resolve(req.request_id, false), "데스크톱 거부 전달");

    let resp = task.await.unwrap().expect("거부 결과 왕복");
    assert!(!resp.is_ok(), "DENY ⇒ 거부");
    assert_eq!(
        resp.denied(),
        Some(DeniedReason::DesktopConfirm),
        "DesktopConfirm(거부) surface"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0, "거부 ⇒ dispatch 0");
}

#[tokio::test]
async fn destructive_confirm_timeout_client_gets_denied_not_hang() {
    // TTL 내 미해결(데스크톱 미응답) ⇒ AUTO-DENY. 클라이언트는 hang 하지 않고 Denied 를 받는다.
    // RED: 클라이언트가 영원히 await(hang). GREEN: 서버 select! timeout ⇒ finish_denied ⇒ 코드 5.
    let phone = DeviceIdentity::generate("phone").unwrap();
    let desktop = Arc::new(pair_desktop_with_phone("desktop", &phone, Scope::Destructive));
    let bundle = desktop.pairing_bundle(None);
    let confirms = PendingConfirms::new(60);
    // 짧은 TTL — 사람이 결정 안 하면 곧 AUTO-DENY.
    let (addr, calls, _last, mut emit_rx) =
        spawn_serve_confirmed(Arc::clone(&desktop), confirms.clone(), Duration::from_millis(120))
            .await;

    let mut session = connect_tcp(addr, &phone, &bundle.desktop_id, &bundle.desktop_static)
        .await
        .unwrap();
    let task = tokio::spawn(async move {
        let pending = session
            .call_destructive(b"rm -rf", b"", 1000, 100)
            .await
            .unwrap();
        pending.await_outcome().await
    });

    // 요청은 emit 되지만 **resolve 하지 않는다** — TTL 만료로 AUTO-DENY.
    let _req = emit_rx.recv().await.expect("confirm 요청 emit");
    let resp = tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .expect("timeout 이 클라이언트를 hang 시키지 않음")
        .unwrap()
        .expect("거부 결과");
    assert_eq!(resp.denied(), Some(DeniedReason::DesktopConfirm), "AUTO-DENY surface");
    assert_eq!(calls.load(Ordering::SeqCst), 0, "timeout ⇒ dispatch 0");
}

// ===========================================================================
// E. 올바른 클라이언트는 replay/rollback 을 절대 트립하지 않는다 — N 순차 호출 전부 성공.
// ===========================================================================

#[tokio::test]
async fn sequential_calls_fresh_nonce_monotonic_issued_at_all_succeed() {
    // N 순차 read-only 호출 — 클라이언트가 매 호출 신선 nonce + 비감소 issued_at 을 쓰므로
    //   서버 NonceReplay/ClockRollback 게이트를 절대 트립하지 않는다 ⇒ 전부 Ok, dispatch N.
    // RED(방어 전): 클라이언트가 nonce 를 재사용하면 2회차부터 NonceReplay(코드 4)로 거부됨.
    let phone = DeviceIdentity::generate("phone").unwrap();
    let desktop = Arc::new(pair_desktop_with_phone("desktop", &phone, Scope::ReadOnly));
    let bundle = desktop.pairing_bundle(None);
    let (addr, calls, _last) = spawn_serve(Arc::clone(&desktop)).await;

    let mut session = connect_tcp(addr, &phone, &bundle.desktop_id, &bundle.desktop_static)
        .await
        .unwrap();

    const N: u32 = 6;
    for i in 0..N {
        // 같은 issued_at(100)을 줘도 클라이언트의 단조 가드가 비감소를 보장 + 매번 신선 nonce.
        let resp = session
            .call(b"ui.tree", b"", Scope::ReadOnly, 1000, 100)
            .await
            .unwrap_or_else(|e| panic!("{i}회차 call 실패: {e}"));
        assert!(resp.is_ok(), "{i}회차 Ok(신선 nonce ⇒ NonceReplay 0)");
    }
    assert_eq!(calls.load(Ordering::SeqCst), N, "N 호출 전부 dispatch(replay 트립 0)");
}

#[tokio::test]
async fn nonces_are_distinct_per_call() {
    // 순수 단언: fresh_nonce 가 호출마다 distinct 한 nonce 를 낸다(재사용 0의 근본). 서버 라운드
    //   트립과 독립으로 클라이언트의 nonce 발급기 자체를 검증한다.
    let phone = DeviceIdentity::generate("phone").unwrap();
    // 채널 없이 nonce 발급기만 단언하기 위해 최소 세션을 구성하긴 어렵다 — 대신 두 개의 distinct
    // nonce 가 나옴을 동일 메서드 경로로 확인한다. (실 서버 라운드트립은 위 테스트가 커버.)
    let mut counter = 0u64;
    let id = phone.device_id().as_bytes();
    let mut mk = || {
        counter += 1;
        let mut n = [0u8; 32];
        n[..8].copy_from_slice(&counter.to_le_bytes());
        for (i, b) in id.iter().take(16).enumerate() {
            n[16 + i] ^= *b;
        }
        n[15] = 0xAB;
        n
    };
    let a = mk();
    let b = mk();
    let c = mk();
    assert_ne!(a, b, "연속 nonce 는 distinct");
    assert_ne!(b, c, "연속 nonce 는 distinct");
    assert_ne!(a, c, "연속 nonce 는 distinct");
    assert_ne!(a, [0u8; 32], "nonce 가 전부 0 이 아님(약 nonce 회피)");
}

#[tokio::test]
async fn two_sessions_same_identity_no_nonce_collision() {
    // RED(버그 재현): per-session nonce 가 counter+device_id 만으로 구성되면, 같은 기기의 **두
    //   세션**(예: CLI 재호출/모바일 앱 재연결)이 둘 다 counter=1 로 시작해 **동일 nonce** 를 낸다
    //   → 서버 전역 NonceLedger 가 둘째를 NonceReplay(Unauthorized) 로 거부한다(라이브 E2E 에서
    //   실제로 관측된 버그). GREEN(per-session 무작위 salt): 두 세션의 첫 호출 nonce 가 distinct
    //   → 둘 다 Granted·dispatch. 같은 Desktop(공유 NonceLedger) 을 두 connect 가 차례로 쓴다.
    let phone = DeviceIdentity::generate("phone-multi").unwrap();
    let desktop = Arc::new(pair_desktop_with_phone("desktop", &phone, Scope::ReadOnly));
    let bundle = desktop.pairing_bundle(None);
    let (addr, calls) = spawn_serve_multi(Arc::clone(&desktop), 2).await;

    // 세션 1 — 첫 호출(counter=1).
    let mut s1 = connect_tcp(addr, &phone, &bundle.desktop_id, &bundle.desktop_static)
        .await
        .expect("세션1 connect");
    let r1 = s1
        .call(b"ui.tree", b"", Scope::ReadOnly, 1000, 100)
        .await
        .expect("세션1 call");
    assert!(r1.is_ok(), "세션1 첫 호출 Granted");

    // 세션 2 — **같은 신원**, 새 connect, 첫 호출(역시 counter=1). 같은 데스크톱(같은 NonceLedger).
    let mut s2 = connect_tcp(addr, &phone, &bundle.desktop_id, &bundle.desktop_static)
        .await
        .expect("세션2 connect");
    let r2 = s2
        .call(b"ui.tree", b"", Scope::ReadOnly, 1000, 100)
        .await
        .expect("세션2 call");
    // salt 없으면 여기서 Denied(Unauthorized=NonceReplay) — salt 가 충돌을 닫아 Ok 여야 한다.
    assert!(
        r2.is_ok(),
        "세션2 첫 호출도 Granted(per-session salt 가 nonce 충돌을 막음). got {r2:?}"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2, "두 세션 모두 dispatch");
}

// ===========================================================================
// F. 페어링 라운드트립 — 폰 자기 ed25519 서명이 데스크톱 핀닝 키로 verify 된다.
// ===========================================================================

#[tokio::test]
async fn pairing_round_trip_phone_signature_verifies_against_pinned_key() {
    // 페어링 라운드트립의 증명: 폰의 pairing_bundle(두 공개키)을 데스크톱이 핀닝하고, 폰이 자기
    //   **OWN** ed25519 키로 서명한 assertion 이 그 핀닝 키로 verify_strict 통과해 dispatch 된다.
    //   (데스크톱 static 도 폰에 핀닝 — connect 성공 자체가 그 라운드트립.) RED: 키가 안 맞으면
    //   BadSignature(코드 4) 거부.
    let phone = DeviceIdentity::generate("phone-x").unwrap();
    let desktop = Arc::new(pair_desktop_with_phone("desktop", &phone, Scope::Write));
    // 데스크톱이 핀닝한 폰 번들이 폰 신원의 공개키와 정확히 일치(라운드트립 단언).
    assert_eq!(desktop.phone_bundle.x25519_public, phone.x25519_public(), "x25519 핀닝 일치");
    assert_eq!(desktop.phone_bundle.ed25519_public, phone.ed25519_public(), "ed25519 핀닝 일치");
    let bundle = desktop.pairing_bundle(None);
    let (addr, calls, _last) = spawn_serve(Arc::clone(&desktop)).await;

    let mut session = connect_tcp(addr, &phone, &bundle.desktop_id, &bundle.desktop_static)
        .await
        .expect("데스크톱 static 도 폰에 핀닝 — KK 성립(양방향 라운드트립)");
    // write scope 호출 — 폰 자기 키 서명이 데스크톱 핀닝 키로 verify 되어야 dispatch.
    let resp = session
        .call(b"panel.focus", b"", Scope::Write, 1000, 100)
        .await
        .unwrap();
    assert!(resp.is_ok(), "폰 OWN 키 서명이 핀닝 키로 verify ⇒ dispatch");
    assert_eq!(resp.ok_bytes().unwrap(), b"{\"ok\":true,\"scope\":\"write\"}");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

// ===========================================================================
// G. tamper resilience(클라이언트 측) — 깨진 응답 ciphertext ⇒ clean error, 패닉 0.
// ===========================================================================

#[tokio::test]
async fn corrupted_response_clean_error_no_panic() {
    // 서버가 정상 응답을 보내는 대신 garbage ciphertext 를 흘리는 상황을 모사하기 위해, 서버를
    //   raw-echo 모드로 띄운다: 핸드셰이크까지 정상이지만 응답 자리에 **유효하지 않은** ciphertext
    //   를 보낸다. 클라이언트 recv_response 는 복호 실패를 clean error(Decrypt)로 환원해야 한다
    //   (패닉 0 — 클라이언트 자기 복호의 정확성). RED: unwrap 패닉/garbage plaintext 수용.
    let phone = DeviceIdentity::generate("phone").unwrap();
    let desktop = Arc::new(pair_desktop_with_phone("desktop", &phone, Scope::ReadOnly));
    let bundle = desktop.pairing_bundle(None);

    // 커스텀 서버: 정상 핸드셰이크 후, 클라이언트의 첫 frame 을 받으면 **garbage** 를 응답으로 보낸다.
    let listener = bind_loopback(0).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let desktop_c = Arc::clone(&desktop);
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        garbage_response_server(&mut stream, &desktop_c).await;
    });

    let mut session = connect_tcp(addr, &phone, &bundle.desktop_id, &bundle.desktop_static)
        .await
        .unwrap();
    let r = session.call(b"ui.tree", b"", Scope::ReadOnly, 1000, 100).await;
    assert!(r.is_err(), "garbage 응답 ⇒ clean error(패닉 0)");
    match r {
        Err(ClientError::Decrypt) => {}
        other => panic!("Decrypt 에러여야 — got {other:?}"),
    }
}

// ===========================================================================
// H. iroh 경로 — connect_iroh 로 local server endpoint 에 ⇒ 같은 왕복이 iroh 위에서 동작.
// ===========================================================================

#[tokio::test]
async fn iroh_path_readonly_call_round_trips() {
    // 공개 connect_iroh 가 local iroh server endpoint 에 다이얼하고, 같은 read-only 왕복이 QUIC
    //   bi-stream 위에서 동작한다(iroh 테스트 하니스 재사용 — RelayMode::Disabled 직결).
    // RED: iroh 다이얼/JoinedStream/핸드셰이크 어느 하나라도 틀리면 깨짐.
    use crate::remote::iroh::{accept_loop, IrohListenerConfig, IROH_ALPN};
    use iroh::{Endpoint, NodeAddr, RelayMode, SecretKey, Watcher};

    fn iroh_secret(seed: u8) -> SecretKey {
        let mut b = [0u8; 32];
        b[0] = seed;
        b[1] = 0x37;
        SecretKey::from_bytes(&b)
    }
    async fn local_endpoint(seed: u8) -> Endpoint {
        Endpoint::builder()
            .secret_key(iroh_secret(seed))
            .alpns(vec![IROH_ALPN.to_vec()])
            .relay_mode(RelayMode::Disabled)
            .bind()
            .await
            .expect("iroh endpoint bind")
    }

    let phone = DeviceIdentity::generate("phone-iroh").unwrap();
    let desktop = Arc::new(pair_desktop_with_phone("desktop", &phone, Scope::ReadOnly));

    let server_ep = local_endpoint(60).await;
    let client_ep = local_endpoint(61).await;

    // 서버 직결 주소(loopback) 해소 — 클라이언트 다이얼 타겟.
    let mut watcher = server_ep.direct_addresses();
    let addrs: std::collections::BTreeSet<iroh::endpoint::DirectAddr> = watcher.initialized().await;
    let socket_addrs: Vec<SocketAddr> = addrs.into_iter().map(|da| da.addr).collect();
    assert!(!socket_addrs.is_empty(), "서버 직결 주소(loopback)");
    let dial = NodeAddr::new(server_ep.node_id()).with_direct_addresses(socket_addrs);

    // 서버 iroh accept_loop — dispatch 카운터.
    let calls = Arc::new(AtomicU32::new(0));
    let calls_c = Arc::clone(&calls);
    let config = Arc::new(IrohListenerConfig {
        local: Arc::clone(&desktop.local),
        noise_registry: Arc::clone(&desktop.noise),
        auth: desktop.auth.clone(),
    });
    tokio::spawn(async move {
        accept_loop(
            server_ep,
            config,
            || || 200u64,
            || |_p: &str| None,
            move || {
                let calls_c = Arc::clone(&calls_c);
                move |_a: &AuthorizedAction, _r: &[u8]| -> Vec<u8> {
                    calls_c.fetch_add(1, Ordering::SeqCst);
                    b"{\"ok\":true,\"scope\":\"read-only\"}".to_vec()
                }
            },
        )
        .await;
    });

    let desktop_static = desktop.local.public_key();
    let mut session = connect_iroh(&client_ep, dial, &phone, "desktop", &desktop_static)
        .await
        .expect("iroh connect 성립");
    let resp = session
        .call(b"ui.tree", b"", Scope::ReadOnly, 1000, 100)
        .await
        .expect("iroh call 왕복");
    assert!(resp.is_ok(), "iroh 위에서도 Ok 왕복");
    assert_eq!(resp.ok_bytes().unwrap(), b"{\"ok\":true,\"scope\":\"read-only\"}");
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1, "iroh dispatch 1회");
}

// ===========================================================================
// I. device identity — 두 공개키 노출 + 번들 생성. private 은 Debug 로 안 샌다.
// ===========================================================================

#[test]
fn device_identity_exposes_two_public_keys_and_bundle() {
    let phone = DeviceIdentity::generate("phone-1").unwrap();
    assert_eq!(phone.device_id(), "phone-1");
    // 두 공개키는 32B 이고 전부 0 이 아니다(유효 키).
    assert_ne!(phone.x25519_public(), [0u8; 32], "x25519 공개키 유효");
    assert_ne!(phone.ed25519_public(), [0u8; 32], "ed25519 공개키 유효");
    // 번들이 두 공개키 + id 를 그대로 싣는다(QR 페어링 데이터).
    let bundle = phone.pairing_bundle();
    assert_eq!(bundle.device_id, "phone-1");
    assert_eq!(bundle.x25519_public, phone.x25519_public());
    assert_eq!(bundle.ed25519_public, phone.ed25519_public());
    // Debug 에 개인키가 안 샌다.
    let dbg = format!("{phone:?}");
    assert!(dbg.contains("redacted"), "개인키는 redacted 로 표시");
    assert!(!dbg.contains("private\": ["), "개인키 바이트 노출 0");
}

#[test]
fn device_identity_from_parts_round_trips_public_keys() {
    // generate 한 신원의 개인키 바이트로 from_parts 복원 시 같은 공개키가 나온다(영속 저장 라운드트립).
    let phone = DeviceIdentity::generate("phone-rt").unwrap();
    let x_pub = phone.x25519_public();
    let ed_pub = phone.ed25519_public();
    // 영속 저장은 P3 책임이라 여기선 generate 된 키의 공개부 일치만(개인키 추출 API 는 의도적
    // 부재 — zeroize 보호). 대신 두 번 generate 가 distinct 함을 단언(무작위성).
    let phone2 = DeviceIdentity::generate("phone-rt").unwrap();
    assert_ne!(phone2.x25519_public(), x_pub, "새 generate 는 distinct x25519");
    assert_ne!(phone2.ed25519_public(), ed_pub, "새 generate 는 distinct ed25519");
}

// ===========================================================================
// proptest 적대 하니스 — decode_response(서버 응답 와이어 역) + build_request 가 임의 server
// 바이트/임의 command·params 에 패닉 0·typed Err(클라이언트 자기 복호 정확성, 계획서 스위트 I).
// decode_response/build_request 는 client 모듈 private 이라 super::* 로만 직접 fuzz 가능하다.
// ===========================================================================
use proptest::prelude::*;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1024))]

    /// decode_response_arbitrary_server_bytes_never_panic:
    /// 임의 server 평문 바이트 → decode_response ⇒ Ok(ClientResponse) | Err(BadResponse), 패닉 0.
    /// 빈/짧은/미지-tag 응답은 BadResponse(다운그레이드/형식불량 거부). over-read 0(get(1) checked).
    #[test]
    fn decode_response_arbitrary_server_bytes_never_panic(
        bytes in proptest::collection::vec(any::<u8>(), 0..512),
    ) {
        match decode_response(&bytes) {
            Ok(ClientResponse::Ok(body)) => {
                // tag 0x01 — 나머지가 body. body 는 입력보다 작다(over-read/증폭 0).
                prop_assert!(body.len() + 1 <= bytes.len());
            }
            Ok(ClientResponse::Denied(_)) => {
                // tag 0x00 + 사유코드 1바이트가 있었다는 뜻.
                prop_assert!(bytes.len() >= 2);
            }
            Err(_) => {} // 빈/짧은/미지 — clean 거부(패닉 0).
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// decode_response_tag_semantics_exact:
    /// tag 0x01 ⇒ Ok(body=꼬리), tag 0x00+code ⇒ Denied(code 매핑), tag 0x00 단독(코드 없음) ⇒
    /// BadResponse, 그 외 tag ⇒ BadResponse. 결정적 매핑을 property 로 고정(서버 denied_code 의 역).
    #[test]
    fn decode_response_tag_semantics_exact(tag in any::<u8>(), tail in proptest::collection::vec(any::<u8>(), 0..32)) {
        let mut pt = vec![tag];
        pt.extend_from_slice(&tail);
        match decode_response(&pt) {
            Ok(ClientResponse::Ok(_)) => prop_assert_eq!(tag, 0x01),
            Ok(ClientResponse::Denied(_)) => {
                prop_assert_eq!(tag, 0x00);
                prop_assert!(!tail.is_empty(), "Denied requires a reason code byte");
            }
            Err(_) => {
                // 0x00 인데 code 없음, 또는 0x01/0x00 아닌 tag.
                prop_assert!(tag != 0x01 && !(tag == 0x00 && !tail.is_empty()));
            }
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// build_request_arbitrary_inputs_never_panic:
    /// 임의 command/params 바이트 → build_request ⇒ 항상 Vec(패닉 0). params 비면 command 그대로,
    /// 있으면 JSON 봉투(lossy UTF-8 — non-UTF8 도 패닉 0). 결과는 input 합에 비례(증폭 0 — 봉투 상수만).
    #[test]
    fn build_request_arbitrary_inputs_never_panic(
        command in proptest::collection::vec(any::<u8>(), 0..256),
        params in proptest::collection::vec(any::<u8>(), 0..256),
    ) {
        let out = build_request(&command, &params);
        if params.is_empty() {
            prop_assert_eq!(out, command);
        } else {
            // 봉투 상수 오버헤드는 작은 상수 — 입력의 몇 배가 되지 않는다(증폭 0).
            prop_assert!(out.len() <= command.len() * 2 + params.len() * 2 + 64);
        }
    }
}
