# license-worker

라이선스 발급, Ed25519 챌린지-응답 검증, 폰-링크 기기 페어링을 위한 Cloudflare
Worker. 정본 설계는 `docs/license-system-design.md`.

Worker **로직**은 로컬에서 완전 테스트 가능(vitest + 인메모리 KV 목 + Node
WebCrypto). **배포**는 소유자의 Cloudflare + Paddle 계정이 필요하며 여기 범위 밖 —
아래 "로컬 vs 배포" 참조.

## 엔드포인트

| Method · Path | 목적 |
|---|---|
| `POST /webhooks/paddle` | Paddle Billing 웹훅. `JSON.parse` 이전 raw-body HMAC-SHA256 검증, replay 윈도우, multi-h1 로테이션, timing-safe 비교, `event_id` 멱등성, `occurred_at` 순서, `data.status`/transaction/adjustment에서 상태 도출, 전액 환불 -> `refunded`. 미상관/중복/미처리 -> `200` no-op. |
| `POST /verify/challenge` | `app_user_id`에 키잉된 단일사용·짧은 TTL nonce 발급. |
| `POST /verify` | nonce 소비(단일사용·미만료), 라이선스 상태 + 기기 게이트, canonical bytes에 Ed25519 서명. 권한 -> `200 {assertion, signature}`; `paused`/`canceled`/`refunded` -> `403 not_entitled`; 기록 없음 -> `404 no_license`; 잘못된 nonce -> `409 nonce_invalid`. |
| `POST /pair` | 라이선스 아래 기기 등록: TOFU 공개키 핀닝, `max_devices` 상한, scope. 폰-링크 수렴(페어링 = 기기 등록). |
| `POST /device/deactivate` | kill-switch: 기기 revoke. 이후 `/verify` -> `not_entitled`. |

## 보안 경계

- Ed25519 **개인키**(`ED25519_PRIVATE_KEY_PKCS8_B64`)와 Paddle 웹훅 시크릿(`PADDLE_WEBHOOK_SECRET`)은 오직 Worker 시크릿에만. 앱은 32바이트 공개키만 임베드.
- 웹훅 서명은 **raw 요청 바이트**에 검증; `JSON.parse`는 HMAC 통과 후에만. 본문 재직렬화(키 재정렬/공백)는 다른 MAC을 만들어 거부 — 테스트로 증명.
- 모든 시크릿 비교는 상수시간 `timingSafeEqual`(길이 확인 + XOR 누적). MAC에 `===` 0.

## 테스트

순수 로컬, 네트워크 0, Cloudflare 0. Node의 `crypto.subtle`이 Workers 런타임과
동일한 Ed25519 + HMAC 표면 제공; KV는 TTL-만료 테스트용 제어 가능 시계를 가진
`Map` 기반 목.

```
npm install          # 또는 pnpm install --ignore-workspace
npx vitest run       # 전 스위트
npx tsc --noEmit     # 타입 체크
```

스위트: `crypto`, `webhook-signature`, `webhook-idempotency`, `webhook-state`, `verify`, `pairing` (+ 수렴 golden).

## 로컬 vs 배포

**로컬 검증(본 산출물):** 모든 엔드포인트의 요청/응답 동작, 웹훅 서명 + 멱등성 +
순서 + 상태머신, 실 키쌍으로 Ed25519 sign/verify 왕복, nonce 단일사용 + 만료, 기기
페어링/상한/TOFU, deactivate kill-switch.

**배포 필요(범위 밖):** 실 Cloudflare 계정 + KV 네임스페이스, 실 Paddle 계정(샌드박스
+ 라이브), 개인키 + 웹훅 시크릿 `wrangler secret put`, 등록된 Paddle 웹훅 목적지, 라이브
KRW 체크아웃. KV의 결과적 일관성 / 키당 1-write-per-sec 한도는 인메모리 목이 모델링
안 하는 실-클러스터 속성. `wrangler.toml`은 바인딩/시크릿 계약을 문서화하나 의도적으로 미배포.

## Rust 검증기(`src-tauri/src/remote/auth.rs`)와의 수렴

Worker의 `/verify`는 서명된 entitlement assertion을 발급한다. Rust 측(`remote::auth`)은
오늘 기기 capability assertion을 **peer 모델**로 검증한다: 각 기기가 자기 키로 서명하고,
데스크톱이 TOFU-핀 공개키로 `verify_strict` 검증(단일사용 nonce, freshness, 단조
`issued_at`, scope subset).

**수렴 기초(완료).** Worker는 이제 *capability* assertion도 `auth.rs::canonical_bytes`의
정확한 길이접두 바이너리 바이트로 직렬화하며(`src/verify.ts`의 `canonicalCapabilityBytes`),
교차-언어 **golden vector**(`test/capability-golden.json`, `src-tauri/src/remote/auth/capability-golden.json`에
미러)가 Worker 서명 assertion이 Rust 측에서 `verify_strict`로 byte-perfect 통과 + 전체
verify floor 통과함을 증명 — additive Rust 테스트, floor 무변경. `docs/license-system-design.md`
§4.3이 canonical 레이아웃 기록. (Track B의 entitlement assertion은 compact JSON 유지; *capability* assertion만 정합.)

**남은 것 — 라이브 발급자 전환.** 라이브 Rust 클라이언트는 여전히 peer 모델(기기
자가서명). 데스크톱이 임베드된 Worker 공개키로 Worker 발급 assertion을 검증하고 폰이
그것을 가져오도록 재배선하는 것은 의도적 모델 변경으로 **아직 안 함**.
