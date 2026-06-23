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

pub mod auth;
pub mod bridge;
pub mod confirm;
pub mod noise;
pub mod session;
pub mod tcp;
pub mod transport;
