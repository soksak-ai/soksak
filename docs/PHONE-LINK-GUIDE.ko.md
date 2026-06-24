# 폰-링크 — 구현 가이드 & 현황

`docs/PHONE-LINK.md`(보안 계약 / 위협→테스트 매트릭스)의 매뉴얼 짝 문서. 이
문서는 "우리가 알아야 할 것" 레퍼런스다: 요구사항, 무엇을 만들었는가, 어떻게
동작하는가, 어떻게 켜고·페어링하고·검증하는가, 그리고 남은 일.

- `main`에 머지 커밋으로 안착(`Merge feat/phone-link: remote-control security and transport stack`).
- 현황: 보안 + 전송 + 프로토콜 코어 **완성·라이브 검증 완료**. 모바일 앱, Cloudflare Worker 수렴, 실제 두-네트워크 기기 테스트는 **미완**(외부 환경 필요 — §6 참조).
- 모든 코드는 `src-tauri/src/remote/` 아래 + 프론트 모달 `src/`에 additive. **기본 비활성** — 명시적으로 켜지 않으면 실행 중인 앱에 영향 0.

---

## 1. 요구사항 (왜 만드는가)

**용도.** 공인 IP가 없고 CGNAT 뒤에 있는(인바운드 차단) 데스크톱을 인터넷
너머 폰에서 조종한다: 데스크톱의 `command` / `dom` / `status` 표면(로컬에서
`docs/AI-CONTROL.md`가 노출하는 그 표면)을 제어하고, 로컬 개발서버
(`localhost:PORT`)를 폰으로 터널링한다.

**보안 강령 (RULE 0 — 타협 불가).** 인증 없이 연결되거나, assertion이
검증되지 않거나, 릴레이가 페이로드를 읽는 순간 전부 무너진다. 그러므로:
- **인증-우선-연결, fail-closed.** 미페어링/미상 기기 키는 채널 자체가 안 생긴다(거부가 아니라 미성립).
- **포착-내성 E2E.** 세션마다 임시 키교환(X25519 ECDHE) + AEAD(ChaCha20-Poly1305) + forward secrecy — 장기키가 후에 유출돼도 포착된 과거 트래픽은 복호 불가. 릴레이는 불투명 ciphertext만 본다.
- **우회 0.** 미인증 fallback·디버그 백도어·로컬-신뢰 예외 0. 방어 심화: 한 층이 뚫려도 전체가 안 무너진다.

**제약.**
- 기본 비활성; transport-agnostic(보안은 브리지에, 전송은 교체 가능).
- danger(파괴적) 액션의 confirm 권위는 데스크톱이 보유; 폰은 절대 자가 상승 불가(페어링·터널 포트 allowlist·danger 게이트 전부 데스크톱 소유).
- 코어는 범용 유지 — "상호 인증된 암호화 원격 기기" capability이지 폰 전용이 아님.

---

## 2. 무엇을 만들었나 (작업 내용)

`feat/phone-link`의 15 커밋, 각각 RED→GREEN + 독립 검증:

| # | 커밋 | 내용 |
|---|------|------|
| 1 | `faefdda` | Ed25519 기기 auth/authz floor — 페어링(TOFU 핀, max_devices, revoke), capability-assertion 검증(verify_strict, 단일사용 nonce, freshness, 단조 issued_at, scope ⊆ granted), fail-closed; 게이트가 타입 시스템에 엮임(nonce 단계 NOP-패치는 컴파일 실패). |
| 2 | `f40da4c` | Noise KK E2E floor(`snow`, Noise_KK_25519_ChaChaPoly_BLAKE2s) — 상호 정적키 인증, PFS, AEAD; 평문/다운그레이드 경로 0. |
| 3 | `8ae1389` | `SecureSession` — 두 floor 합성: 2중-게이트 defense-in-depth + 기기-신원 바인딩(채널 peer ≡ assertion device). |
| 4 | `b3f74c6` | transport-agnostic `serve_connection(stream)` + 길이 프레이밍 + loopback 전용(127.0.0.1) TCP 리스너. |
| 5 | `98477b8` | destructive 데스크톱-confirm 권위 — 데스크톱 사람 결정을 기다리며 파킹(event-driven `oneshot`, 폴링 0), TTL auto-deny, 토큰은 어댑터가 생성(폰 위조 불가). |
| 6 | `ba100e9` | iroh QUIC P2P + relay 전송 tier(`serve_connection` 재사용; node-id는 주소이지 인증 아님). |
| 7 | `7ba5770` | 재사용 initiator 클라이언트 `remote::client` + `sok-phone` CLI. |
| 8 | `d237d63` | `docs/PHONE-LINK.md` 보안 계약. |
| 9 | `8352aeb` | dev서버 reverse-proxy 터널(loopback 전용 + 데스크톱 포트 allowlist = SSRF 0). |
| 10 | `76bb854` | 모든 wire 파서 적대 proptest 하드닝(35 property; robustness 버그 0). |
| 11 | `51ab211` | 데스크톱 confirm 모달(프론트, `RemoteConfirmModal`) + 직렬 큐. |
| 12 | `492308e` | 헤드리스 데스크톱-소유 페어링 설정 + 첫 라이브-앱 E2E(실버그 2개 발견·수정). |
| 13 | `89f945c` | multi-frame 응답 chunking(큰 응답 왕복). |
| 14 | `448ee5c` | 적대 교차-결함 감사 커버리지(chunking × confirm/tunnel, 상태머신). |
| 15 | `2c67854` | 키파일 0600-at-creation 하드닝(write→chmod 윈도우 제거). |

---

## 3. 아키텍처 & 기능 정의

### 2중-게이트 모델 (defense in depth)
```
폰 ──TCP/iroh 스트림──▶ [게이트 1: Noise_KK]  상호 정적키 인증 + ChaCha20-Poly1305 + PFS
                              │  (미페어링/미상 키 ⇒ 채널 미성립)
                              ▼
                       [게이트 2: Ed25519 assertion]  프레임마다: verify_strict, 단일사용
                              │   nonce, freshness, 단조 issued_at, scope ⊆ granted
                              ▼
                       [기기-신원 바인딩]  채널 peer ≡ assertion.device_id
                              ▼
                       [danger]  destructive ⇒ 데스크톱 사람 confirm (폰 우회 불가)
                              ▼
                       request_command → route()  (command/dom/status)  |  tunnel → 127.0.0.1:allowlisted-port
```
유효한 채널만으로는 아무 것도 인가되지 않는다 — 프레임마다 자기 서명·scope·단일사용 assertion을 싣는다.

### 모듈 맵 (`src-tauri/src/remote/`)
| 모듈 | 역할 |
|------|------|
| `auth.rs` | Ed25519 페어링 + capability-assertion 검증(인가) |
| `noise.rs` | Noise_KK 채널(인증 + 기밀 + PFS) |
| `session.rs` | `SecureSession`(게이트 합성) + chunking codec |
| `transport.rs` | transport-agnostic `serve_connection` / `serve_tunnel` + 프레이밍 |
| `tcp.rs` | loopback 전용 TCP 리스너 |
| `confirm.rs` | destructive 데스크톱-confirm 권위(pending 레지스트리 + resolve) |
| `iroh.rs` | iroh QUIC P2P + relay tier |
| `client.rs` | 재사용 initiator(폰이 임베드하는 절반) + `sok-phone` |
| `tunnel.rs` | dev서버 reverse-proxy(allowlist + loopback 전용) |
| `pairing.rs` | 헤드리스 데스크톱-소유 페어링 설정 + 데스크톱 키 영속 |
| `bridge.rs` | 기본 비활성 앱 글루(enable 플래그, `request_command` 디스패치, Tauri confirm 커맨드) |

프론트: `src/components/RemoteConfirmModal.tsx` + `src/state/remoteConfirm*.ts`.

### 기능
- **원격 command/dom/status** — 페어링 기기가 임의 레지스트리 command·dom op·status query 호출; 결과는 암호 채널로 반환.
- **dev서버 터널** — 데스크톱 `localhost:PORT`(allowlisted)를 폰으로 reverse-proxy.
- **두 전송** — loopback TCP(동일 호스트/LAN) + iroh QUIC(P2P + relay, CGNAT).
- **데스크톱 confirm 권위** — destructive는 데스크톱 사람 결정 필수; 폰이 우회·비활성화 불가.
- **페어링** — 데스크톱-소유 설정이 기기 키 핀; 폰 자가페어링 불가.
- **chunking** — 한 Noise 프레임(65535) 초과 응답을 chunk·재조립, 8MB 상한.

---

## 4. 동작 방법 (사용)

### 켜기 (전부 기본 비활성; 데스크톱 소유)
| env | 효과 |
|-----|------|
| `SOKSAK_REMOTE_TCP=1` | loopback(127.0.0.1) TCP 리스너 바인드 |
| `SOKSAK_REMOTE_TCP_PORT=<n>` | TCP 포트(0 = OS 할당) |
| `SOKSAK_REMOTE_IROH=1` | iroh 엔드포인트 시작(P2P + relay) |
| `SOKSAK_REMOTE_TUNNEL=1` | dev서버 터널 리스너 활성 |
| `SOKSAK_REMOTE_TUNNEL_PORTS="3000,5173"` | 데스크톱-소유 터널 포트 allowlist(빈 값 ⇒ 모든 터널 거부) |
| `SOKSAK_REMOTE_DESKTOP_KEY_PATH=<file>` | 안정 데스크톱 정적키 영속 위치(기본: 앱 config 디렉터리) |
| `SOKSAK_REMOTE_PAIRED_DEVICES_JSON=<json>` / `SOKSAK_REMOTE_PAIRED_DEVICES=<file>` | 페어링 기기 레지스트리: `[{device_id, x25519_pub, ed25519_pub, granted_scope}]` |

enable 플래그가 없으면 아무 것도 바인드 안 한다.

### 페어링 흐름 (헤드리스, QR 등가물)
1. 데스크톱이 **안정 정적키**를 영속(폰이 재시작 너머로 핀 가능)하고 공개키를 노출(브리지 시작 시 로그).
2. 폰이 신원 생성 — `sok-phone pair`가 `{device_id, ed25519_public, x25519_public}` 출력.
3. 데스크톱 운영자가 그 번들(+ `granted_scope`, 기본 read-only)을 페어링 설정에 추가. **핀은 오직 이 데스크톱-소유 설정에서만 — 폰은 자가 추가 불가(anti-escalation).**

### 요청 흐름
폰 `connect`(Noise KK initiator, 데스크톱 정적키 핀 — 틀린 키 ⇒ 세션 0) → 호출마다: `{device_id, scope, fresh nonce, issued_at, exp}` assertion을 Ed25519 서명 → `{assertion, signature, request}` 프레임 → 암호화 → 전송 → 데스크톱이 검증(두 게이트) → `request_command → route()` → 응답 chunk로 반환 → 클라이언트가 재조립·복호.

### confirm 흐름 (destructive)
destructive grant는 **파킹**; 데스크톱이 `remote-confirm-request` emit; `RemoteConfirmModal`이 기기 + 명령 + danger 표시; 사람이 승인/거부(또는 TTL auto-deny); 승인 시 어댑터가 `DesktopConfirmToken`을 스스로 만들어 디스패치; 거부/타임아웃 시 미실행.

### 터널 흐름
터널 = 인가 후 모드가 raw 바이트를 `127.0.0.1:<allowlisted port>`로 프록시하는 세션. 미-allowlist 포트는 어떤 `connect`도 시도 전에 거부(SSRF 0).

### CLI
`sok-phone pair`(이 기기 번들 출력) · `sok-phone call <addr> <desktop-id> <desktop-static-hex> <command> '<json>'` · `sok-phone tunnel <addr> <desktop-id> <desktop-static-hex> <port>`.

---

## 5. 검증 (무엇을 테스트했나)

- **테스트**: remote 모듈 전반 263 Rust 테스트 + 프론트 560 테스트(모달 포함). 모든 floor는 RED→GREEN; 각 방어를 NOP-패치(공격 통과 = RED)·복원(차단 = GREEN)으로 독립 검증.
- **적대 fuzz**(`76bb854`): 모든 wire 파서에 35 proptest property(길이 프레이밍, 프레임 codec, assertion/서명 파싱, Noise 복호, 터널 first-frame, 클라이언트 recv, 순서-위반 상태) — panic-free, 유한, graceful Err; **robustness 버그 0**.
- **적대 감사**(`448ee5c`): 회의적 전체-스택 리뷰가 9개 교차-결함 가설(chunking×confirm, chunking×tunnel, 상태머신 구멍, fail-closed 완전성, TOCTOU/scope, 정보누출, nonce/replay, 증폭/DoS, 페어링 설정) 검증 — **보안 구멍 0**; 각각 file:line 가드 또는 새 테스트로 반증.
- **라이브 E2E**(`492308e`, `89f945c`) — 실행 중인 실제 앱·실제 `route()` 대상:
  - `state.commands` → 실제 244,880 바이트 / 371 커맨드 카탈로그가 chunked·byte-perfect 왕복(이전엔 잘림).
  - `ui.tree` → 실제 155 노드 dom 트리(단일-프레임 fast path).
  - 미페어링 신원 → 핸드셰이크 실패, 0 접근(fail-closed, 손으로 재현).
  - destructive 명령 → 실제 데스크톱 confirm 모달(기기 `phone-e2e-dx`) → 승인=실행, 거부=미실행.
- **라이브에서 실버그 2개 발견·수정**(RED→GREEN). in-process injected-dispatch 테스트가 놓친 것:
  1. 같은 기기의 두 세션이 동일 nonce 시퀀스 재사용 → `NonceReplay` → per-session 랜덤 솔트로 수정.
  2. 한 Noise 프레임 초과 `route()` 응답이 빈/미복호 프레임 생성 → 응답 chunking으로 수정(+ 8MB 하드 상한·초과 시 clean error).

---

## 6. TODO (frontier — 남은 일, 왜 안 했나)

외부 환경/결정이 필요하고, 가짜로 만들지 않았다:

- **P3 — 모바일 앱**: `remote::client`를 임베드한 Tauri 모바일 클라이언트 + 미러 UI. 모바일 툴체인(Xcode / Android SDK) + 스토어 서명 필요.
- **P4 — Cloudflare Worker 수렴**: Worker는 **빌드+로컬검증 완료**(`worker/`, 69 테스트 — Paddle 라이선스 웹훅 + Ed25519 챌린지-응답 `/verify`, 기기 페어링, revoke; `worker/README.md` 참조), **수렴 기초**도 마련됨 — 교차-언어 golden vector가 Worker 발급 capability assertion이 Rust `remote::auth`에서 byte-perfect로 `verify_strict` 통과함을 증명(`docs/license-system-design.md` §4.3; additive Rust 테스트, floor 무변경). 남은 것: **배포**(사용자 Cloudflare/Paddle 계정 필요)와 **라이브 발급자 전환**(기기 자가서명 → Worker 발급) — 검증된 클라이언트를 재배선하는 의도적 모델 변경(아직 안 함; 라이브 모델은 peer-signed 유지).
- **실 페어링 UI 라이브-앱 E2E**: 현재 페어링은 헤드리스 데스크톱-소유 설정; QR/승인 UI가 상용형.
- **실 교차-네트워크 테스트**: 실제 NAT hole-punching, relay 페일오버, mDNS 발견, 발화 E2E는 두 네트워크 실기기 필요.
- **multi-frame 요청 chunking**: 응답은 chunk하나 요청은 단일-프레임(assertion이 작아 현재 충분 — 병적으로 큰 요청은 chunk 아니라 거부).

미해결 하드닝 노트(저심각, RULE-0 위반 아님): `client.rs::fresh_nonce`가 8 솔트 바이트 중 1개를 마커로 덮어 56비트 솔트 엔트로피 — 여전히 충돌-내성; 전체 엔트로피로 옮길 수 있음. (키파일 chmod 윈도우는 `2c67854`에서 수정됨.)

---

## 7. 참고 / 함정

- **iroh `=0.91.2` 핀**: 0.95.x는 `ed25519-dalek 3.0.0-pre.1`(프리릴리스)를 끌어와 빌드 실패; 0.91.2는 안정 `ed25519-dalek 2.2.0`로 해소돼 `remote::auth`와 통합. iroh는 ~163 전이 crate 추가.
- **키 저장**: 데스크톱 정적 개인키는 폰-도달불가 데스크톱-소유 디렉터리에 0600(소유자만, 생성 시점부터)으로 영속. 개인키는 모든 `Debug`/로그에서 가려짐; 데스크톱 공개키만 로그(페어링 표시용).
- **기본 비활성 안전**: enable 플래그 없으면 리스너 0, 앱은 이전과 동일 동작.
- **디스패치 seam은 `ipc.rs::request_command` → `route()`**(무변경); 네트워크 어댑터가 재사용.
- **디스크**: iroh 의존 트리가 큼; 증분 빌드 유지.
- 보안 계약 / 위협→테스트 매트릭스는 `docs/PHONE-LINK.md`에.
