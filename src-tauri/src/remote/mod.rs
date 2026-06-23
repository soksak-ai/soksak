// remote — 인증된 원격 기기 capability(generic, 폰 전용 아님 — RULE 8 무강결합).
//
// 현 단계: 암호 하한선만(RULE 0). 어떤 TcpListener 도 route() 변경도 없다 — 미래의
// 네트워크 어댑터가 연결/route() 호출 전에 상담할 두 층을 먼저 provably 옳게 만든다.
//   - auth: 액션별 인가(Ed25519 capability assertion). 채널 위에서 권한을 증명한다.
//   - noise: 채널 인증 + 기밀성(X25519 Noise KK + AEAD + PFS). 그 아래 transport-agnostic 층.

pub mod auth;
pub mod noise;
