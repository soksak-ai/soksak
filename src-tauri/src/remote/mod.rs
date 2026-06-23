// remote — 인증된 원격 기기 capability(generic, 폰 전용 아님 — RULE 8 무강결합).
//
// 현 단계: 암호 하한선만(RULE 0). 어떤 TcpListener 도 route() 변경도 없다 — 미래의
// 네트워크 어댑터가 연결/route() 호출 전에 상담할 층들을 먼저 provably 옳게 만든다.
//   - auth: 액션별 인가(Ed25519 capability assertion). 채널 위에서 권한을 증명한다.
//   - noise: 채널 인증 + 기밀성(X25519 Noise KK + AEAD + PFS). 그 아래 transport-agnostic 층.
//   - session: 위 두 floor 를 "보안 세션" 게이트로 합성(additive — floor 무수정). 성립된
//     채널 + 인증된 peer 기기에 결속해, frame 마다 복호 → 기기-신원 교차검증 → 인가 →
//     Granted 일 때만 dispatch(엮인 게이트, defense-in-depth).
//   - transport: 그 보안 세션을 **아무 바이트 스트림** 위에 얹는 transport-agnostic 어댑터
//     (길이-프리픽스 ciphertext frame 루프). iroh/Go-relay/cloudflared 가 재사용한다(additive).
//   - tcp: serve_connection 을 **127.0.0.1 전용** TCP 위에 얹는 한 transport(P1 브리지, off by
//     default). 임의 노출/SSRF/rebinding 표면 0.
//   - iroh: serve_connection 을 **iroh QUIC bi-stream**(P2P + 릴레이 fallback) 위에 얹는 transport
//     tier ①(폰-링크 P2, off by default). CGNAT 인바운드-불가 환경의 outbound 랑데부 + LAN mDNS 직결.
//     iroh node-id = 전송 주소일 뿐 auth 아님 — Noise 가 그 위에서 mutual-auth(node-id≠auth).

pub mod auth;
pub mod bridge;
// client: 폰-링크 프로토콜의 INITIATOR(폰) 측 라이브러리(SYMMETRIC 절반). 위 floor 들을
//   손대지 않고 그것들과 대화하는 클라이언트 표면을 추가한다(KK INITIATOR 핸드셰이크 +
//   assertion 서명 + ConfirmRequired 이벤트-우선 recv). P3 모바일 앱이 임베드한다.
pub mod client;
pub mod confirm;
pub mod iroh;
pub mod noise;
pub mod session;
pub mod tcp;
pub mod transport;
// tunnel: 로컬 dev-server reverse-proxy 터널(폰-링크 secure channel 위, additive). 터널 = POST-AUTH
//   모드가 '명령 dispatch' 가 아니라 'allowlist 된 127.0.0.1 포트로 raw 바이트 프록시'인 SecureSession.
//   SSRF 0(loopback-only + allowlist, connect 이전 거부), allowlist=데스크톱 소유(폰 상승 불가),
//   브리지 auth 게이트 무수정(미페어링 ⇒ 채널 0), 평문은 와이어에 안 나감(NoiseChannel encrypt/decrypt).
pub mod tunnel;
