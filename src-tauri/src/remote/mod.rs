// remote — 인증된 원격 기기 capability(generic, 폰 전용 아님 — RULE 8 무강결합).
//
// 현 단계: auth 코어만(RULE 0 암호 하한선). 어떤 TcpListener 도 route() 변경도 없다 —
// 미래의 네트워크 어댑터가 route() 호출 전에 상담할 auth 층을 먼저 provably 옳게 만든다.

pub mod auth;
