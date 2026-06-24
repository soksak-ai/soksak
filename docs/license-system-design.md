# 데스크톱 앱 라이선스 보호 시스템 — 설계 문서

> 대상: Tauri(Rust + 웹) 상용 데스크톱 앱 / 한국 사업자
> 목표: 라이선스·결제 우회 방지
> 보안 철학: **"뚫을 수 없게"가 아니라 "뚫어도 의미 없게"**

---

## 0. 핵심 전제 (먼저 받아들여야 할 사실)

- 클라이언트에서 단독으로 도는 검증은 **논리적으로 항상 우회 가능**하다. (코드가 사용자 손에 있음)
- 따라서 목표는 크랙률 0%가 아니라 **"크랙 비용 > 크랙 이익"**으로 만드는 것.
- 강제력의 원천은 **개인키(서버 전용)**와 **서버가 소유한 결제 진실**이다. 이 둘만 클라이언트 밖에 있으면 keygen과 위조가 원천 차단된다.
- 변조 자체는 못 막는다. 대신 **변조본이 서버 없이는 작동하지 않게** 기능을 서명 응답에 엮는다.

---

## 1. 아키텍처 개요

```
[결제]  Paddle(해외) 또는 포트원(국내)
   │  웹훅(결제완료/환불)
   ▼
[Cloudflare Worker]  ◀── 라이선스 발급/검증/취소 (개인키는 여기 Secret에만)
   │
   ├─ Cloudflare KV : 라이선스 상태 저장 (license_key → 상태/기기/만료)
   │
   ▼  HTTPS (인증서 핀닝)
[Tauri 데스크톱 앱]
   ├─ Rust core : nonce 생성, 서명 검증(공개키 내장), 기능 게이팅
   └─ WebView UI : 라이선스 키 입력, 상태 표시
```

움직이는 부품은 4개뿐: **Tauri 앱 / Cloudflare Worker / KV / PG 웹훅**.

---

## 2. 구성 요소별 역할

### 2.1 Cloudflare Worker (검증 서버)
- 챌린지 응답 검증 엔드포인트 `POST /verify`
- PG 웹훅 수신 엔드포인트 `POST /webhook/paddle` (또는 `/webhook/portone`)
- **개인키(Ed25519)는 Worker Secret(`wrangler secret`)에만 보관** — 코드/저장소/앱 어디에도 없음
- 무료 티어로 충분 (월 10만 요청 무료, 라이선스 검증 트래픽은 미미)

### 2.2 Cloudflare KV (상태 저장소)
- 라이선스의 "진실"을 보관하는 곳
- 키-값 구조라 운영이 단순. 강한 정합성이 필요하면 D1(SQLite)로 승급 가능

### 2.3 Tauri 앱 (클라이언트)
- **검증 로직은 반드시 Rust core(`src-tauri`)에 둔다.** WebView(JS)에 두면 DevTools로 쉽게 노출됨
- 앱 바이너리에는 **공개키만** 내장
- 서명 검증 결과를 단일 `if`로 분기하지 말고, 응답 토큰을 실제 기능에 엮는다(§6 참고)

### 2.4 PG 웹훅 (발급 트리거)
- 결제 완료 → Worker가 라이선스 키 생성 → KV 저장 → 구매자에게 키 전달
- 환불/구독 해지 → Worker가 KV에서 `revoked` 처리

---

## 3. 결제 / 발급 전략 (한국 사업자 기준) — 확정: Paddle 메인 + 포트원 스위치

### 사실 확인 결과 (2026.06)
- **Stripe 직접 연동 불가**: 한국은 Stripe Merchant Country가 아님. 한국 법인/개인사업자로 계정 생성 불가.
- **Paddle**: 한국 지원국 포함, MoR(판매자 대행)로 전 세계 VAT·세금 자동 처리·신고 대행. 수수료 5% + $0.50.
  - **국내 간편결제 전부 지원**: 카카오페이·네이버페이·삼성페이·페이코 (한국 은행계좌 불필요).
  - **원화(KRW) 표시 결제** 가능. 카카오페이·네이버페이는 **구독 결제**까지 지원.
  - 못 하는 것: **한국식 세금계산서/현금영수증 발행 ❌** (자체 인보이스만), **정산은 외화**.
- **포트원(PortOne)**: 한국 법인 그대로 **KRW 정산**, 국내 PG 통합, **세금계산서/현금영수증** 발행. 구독은 빌링키.
- **Lemon Squeezy**: Stripe 인수 후 전환기 → 신규 도입은 Paddle 권장.

### 플랫폼 수수료 — 데스크톱은 App Store 의무 없음
| 판매 경로 | 플랫폼 수수료 |
|---|---|
| iOS / Mac App Store | 30% (소규모 프로그램 시 15%) |
| **Mac/Windows 직접 배포(.dmg/.exe)** | **0원** ← Tauri 기본, PG 수수료만 부담 |

→ Tauri 앱은 직접 배포가 표준이라 애플·MS 수수료 0원. Paddle 5%(또는 국내 PG 2~3%)만 든다.

### 확정 구조: Paddle 메인 + 포트원 스위치
- **기본 운영은 Paddle 단일.** 국내 간편결제까지 커버되므로 출시 시점엔 1개 PG·세금 1벌로 충분.
- **포트원은 "스위치"로 대기.** 켜는 트리거는 단 하나 — **국내 B2B 세금계산서 요구** 또는 **KRW 정산 필요** 발생 시점.
- 포트원 스위치를 켜면 그때부터 **세금 처리는 2벌**(Paddle MoR + 국내 직접)이 된다. 이 비용은 스위치 ON일 때만 발생.

### PG 추상화 원칙
- **라이선스 검증 코어는 PG에 완전 독립.** PG는 "결제완료 → 라이선스 발급"의 트리거일 뿐.
- PG별 **어댑터**(웹훅 핸들러)를 공통 "라이선스 발급" 인터페이스 뒤에 둔다.
- **설정 스위치 하나**로 국내건 결제 라우팅을 Paddle ↔ 포트원 전환. 검증 코어는 무변경.
- 원칙: **"결제의 진실은 서버(Worker+KV)가 소유"** — 앱은 결제 성공 여부를 스스로 판단하지 않는다.

```
[Tauri 앱] ─결제요청─▶ [PG 라우터]  ──(기본)──────▶ Paddle 체크아웃(국내+해외)
                          │
                          └──(스위치 ON: 세금계산서/KRW)──▶ 포트원(해당 국내건만)
                                │
            두 PG 웹훅 ─────────▼───────── 공통 "라이선스 발급" 인터페이스
                          [Cloudflare Worker] ──▶ KV
```

---

## 4. 데이터 구조

### 4.1 KV 스키마 (`license:{license_key}`)
```json
{
  "status": "active",            // active | revoked | suspended
  "plan": "pro",
  "email": "buyer@example.com",
  "max_devices": 2,
  "devices": [                    // 머신 바인딩
    { "machine_id": "hash...", "first_seen": "2026-06-23T..." }
  ],
  "created_at": "2026-06-23T...",
  "expires_at": null             // 구독이면 다음 결제일, 영구면 null
}
```

### 4.2 서명 응답 토큰 (Worker → 앱)
```json
{
  "payload": {
    "license_key": "XXXX-XXXX",
    "machine_id": "hash...",
    "nonce": "앱이_보낸_난수",      // replay 차단
    "plan": "pro",
    "issued_at": 1750000000,        // 시계 되돌리기 차단(단조 증가 검사)
    "exp": 1750604800               // 오프라인 유예 만료(예: +7일)
  },
  "signature": "ed25519(payload, 개인키)"
}
```

### 4.3 원격 제어(remote-iroh) capability assertion 의 canonical 바이트 (확정: Rust 바이너리 레이아웃)

위 §4.2 의 JSON 스케치는 **라이선스 엔타이틀먼트**(트랙 B) assertion 의 초기 구상이다.
**원격 제어**(remote::auth, soksak-plugin-remote-iroh)의 capability assertion 은 별도의 토큰이며, 그
canonical 서명 바이트는 JSON 이 아니라 **출하된 Rust 바이너리 레이아웃**이다 —
`src-tauri/src/remote/auth.rs::CapabilityAssertion::canonical_bytes`. 41개+ auth 테스트가
이 형식에 의존하므로 이것이 **단일 진실(source of truth)** 이고, Worker 가 발급자(issuer)로
수렴할 때 이 바이트를 그대로 서명한다("동일 Ed25519 서명" 수렴). 제3의 형식을 만들지 않는다.

길이 프리픽스 바이너리 레이아웃(필드 순서 고정, 모두 little-endian):

```
device_id.len()  : u64 LE (8 bytes)
device_id        : UTF-8 bytes
scope_tag        : 1 byte  (0 = read-only, 1 = write, 2 = destructive)
nonce            : 32 raw bytes
issued_at        : u64 LE (8 bytes)   # Unix seconds
exp              : u64 LE (8 bytes)   # Unix seconds
```

길이 프리픽스(`device_id`)가 `("ab","")` 류 경계 충돌을 막는다. 이 바이트를
Ed25519 개인키로 서명하고, Rust 는 핀닝된 공개키로 `verify_strict`(약·소위수 키 forgery
차단) 한다.

**필드 매핑 (Worker → Rust)** — Rust assertion 은 `device_id` 로 키잉되므로 Worker 는
Rust 의 `device_id` 슬롯을 쓴다:

| Rust 필드 | Worker 출처 | 비고 |
|---|---|---|
| `device_id` | 원격 기기 식별자(`machine_id`) | Rust 가 `device_id` 로 키잉 → Worker 는 그 슬롯 사용 |
| `scope` | `DeviceScope`(`read-only`/`write`/`destructive`) | `scope_tag` 0/1/2 로 인코딩 |
| `nonce` | raw 32바이트 챌린지 nonce | base64url 아님 — 원시 바이트 |
| `issued_at` | Unix seconds(u64) | 단조 증가 가드 |
| `exp` | Unix seconds(u64) | 신선도 가드 |

Worker 측 구현: `worker/src/verify.ts::canonicalCapabilityBytes()` 가 이 바이트를 정확히
재생산하고, `crypto.ts::ed25519Sign()` 으로 서명한다.

**교차언어 골든 벡터(계약 테스트)**: 고정 Ed25519 시드 키(테스트 전용) + 고정 assertion →
정확한 canonical 바이트(hex) + 서명(hex) 을 `worker/test/capability-golden.json` 에 두고,
`src-tauri/src/remote/auth/capability-golden.json` 으로 미러링한다. Worker 테스트
(`worker/test/capability-golden.test.ts`)는 `canonicalCapabilityBytes` === 골든 hex 와
`sign` === 골든 서명을 단언한다. Rust 테스트(`src-tauri/src/remote/auth/golden_tests.rs`,
ADDITIVE — auth.rs 로직 무변경)는 `canonical_bytes` === 골든 hex, 그리고 골든 공개키의
`verify_strict(골든 바이트, 골든 서명) == Ok` 를 단언한다 — **Worker-형식으로 서명된
assertion 이 Rust 측에서 검증됨**을 증명한다. tamper-negative(서명 1바이트·메시지 1바이트
변조 → 검증 실패)도 함께 못박는다.

> **현재 라이브 모델은 그대로 peer 다.** 라이브 Rust 클라이언트는 여전히 기기 자기 키로
> 서명하고 핀닝 공개키로 검증한다(§위협 모델). 이 §4.3 는 **interop 준비(기초)** 이지
> 모델 교체가 아니다 — Worker 발급(issuer) 로의 실제 전환(라이브 원격 제어 클라이언트를
> Worker-발급 assertion 으로 재배선)은 **별도의 후속 통합**이다. 골든 벡터가 그 전환을
> trivial 하게 만든다(양측 바이트·서명이 이미 고정·검증됨).

---

## 5. 인증 흐름 (챌린지-응답)

```
[Tauri 앱]                                  [Cloudflare Worker + KV]
1. 사용자가 라이선스 키 입력
2. machine_id 생성 (하드웨어 핑거프린트 해시)
3. nonce = 암호학적 난수 생성
4. POST /verify {license_key, machine_id, nonce} ─────▶
                                              5. KV 조회:
                                                 · status == active?
                                                 · 환불/취소 아님?
                                                 · devices 수 ≤ max_devices?
                                                 · 새 기기면 바인딩 등록
                                              6. payload 구성 + 개인키로 Ed25519 서명
   ◀──────────────────────── {payload, signature}
7. 공개키로 서명 검증
8. payload.nonce == 내가 보낸 nonce?  (replay 차단)
9. payload.machine_id == 내 machine_id?
10. payload.issued_at ≥ 마지막 저장값?  (시계 되돌리기 차단)
11. 통과 → 토큰을 로컬에 암호화 캐시 (exp까지 오프라인 허용)
12. 기능 활성화 (단순 분기 아님 — §6)
```

### 오프라인 처리
- 캐시된 토큰의 `exp` 이내면 네트워크 없이 동작.
- `exp` 경과 시 재검증 강제.
- `issued_at`을 로컬에 단조 증가로 기록 → 시스템 시계를 과거로 돌려도 무효.

---

## 6. 보안 속성 매트릭스

| 공격 | 방어 장치 | 강도 |
|---|---|---|
| keygen 제작 | 개인키는 Worker Secret에만, 앱엔 공개키만 | ★★★★★ (원천 차단) |
| 위조 라이선스 | Ed25519 서명 검증 | ★★★★★ |
| replay (옛 응답 재사용) | 앱 생성 nonce를 서명 payload에 포함 | ★★★★ |
| 시계 되돌리기 | `issued_at` 단조 증가 검사 | ★★★★ |
| 라이선스 키 공유 | machine_id 바인딩 + `max_devices` | ★★★★ |
| 환불 후 계속 사용 | PG 웹훅 → KV `revoked` → 재검증 차단 | ★★★★ |
| 오프라인 무한 사용 | 토큰 `exp` 만료 강제 | ★★★ |
| 가짜 서버로 우회(MITM) | HTTPS + **인증서/공개키 핀닝** | ★★★ |
| 바이너리 변조 | **기능을 서명 토큰에 엮기** (아래) | ★★★ |
| 검증 코드 NOP 패치 | 검증 분기를 단일점으로 두지 않기 + Rust core | ★★ |

### "기능을 토큰에 엮기" (가장 중요한 안티-변조 기법)
단순히 `if (verified) { unlock() }` 로 두면 그 한 줄을 패치당한다.
대신 **서명 토큰(또는 그로부터 파생한 키)으로 실제 기능 리소스를 복호화**하게 한다:
- 핵심 설정/리소스/데이터를 토큰 파생 키로 AES 복호화
- 또는 핵심 연산 일부를 Worker 응답에 의존
→ 검증을 우회해도 **복호화에 필요한 정답이 없어** 기능이 동작하지 않는다.

---

## 7. Tauri 특화 보안

- [필수] 검증·핑거프린트·복호화 로직을 **`src-tauri`(Rust)** 에 둔다. WebView(JS)에 절대 두지 않는다.
- [필수] 프로덕션 빌드에서 **DevTools 비활성화** (`tauri.conf.json`).
- [권장] Rust 측 `ed25519-dalek` 또는 `ring`으로 서명 검증.
- [권장] machine_id는 `machine-uid` 류 + 솔트 해시. 원본 식별자를 그대로 전송하지 않음.
- [권장] 릴리스 빌드 `strip` + 심볼 제거로 분석 난이도↑.
- [권장] **코드 서명**: Windows(EV/OV 인증서) + macOS(Developer ID + notarization). 변조 탐지 + OS 신뢰 경고 제거. 필수에 가까움.
- [선택] 무결성 자가검증(자기 해시 체크)은 비용 상승용 보조 수단으로만. 근본 차단으로 기대하지 말 것.

---

## 8. 구현 체크리스트 (순서대로)

### Phase 0 — 준비
- [x] 결제 확정: **Paddle 메인(국내+해외) + 포트원 스위치(세금계산서/KRW 필요 시)**
- [ ] Paddle 계정 개설 + 상품/구독 등록, 국내 간편결제(카카오/네이버/삼성/페이코) 활성화
- [ ] Cloudflare 계정 + Wrangler CLI 설치
- [ ] Ed25519 키쌍 생성 (개인키는 절대 커밋 금지)

### Phase 1 — 서버(Worker)
> 상태: Worker **코드는 `worker/` 에 구현·로컬 테스트(vitest 69) 완료** — `/verify`(+`/verify/challenge`), `/webhooks/paddle`, `/pair`, `/device/deactivate`, nonce·issued_at·exp·Ed25519 서명·timing-safe 비교·raw-body-before-parse. 원격 제어 capability assertion 의 canonical 바이트는 Rust `auth.rs` 와 정합(§4.3 교차언어 골든 벡터). **남은 것은 배포**(아래 미체크 — Cloudflare/Paddle 계정 필요).
- [ ] `wrangler secret put PRIVATE_KEY` 로 개인키 등록 (배포 — 계정 필요)
- [ ] KV 네임스페이스 생성, 바인딩 (배포 — 계정 필요)
- [x] `POST /verify` 구현 (조회 → 바인딩 → 서명) — `worker/src/verify.ts` (로컬 테스트됨)
- [x] nonce·issued_at·exp 로직 — `worker/src/verify.ts` (단일사용·만료·단조 테스트됨)
- [x] `POST /webhook/{pg}` 구현 (발급/취소) + 웹훅 서명 검증 — `worker/src/webhook.ts` (HMAC·멱등성·순서·refund→revoke 테스트됨)

### Phase 2 — 클라이언트(Tauri/Rust)
> 상태: 미착수. **주의** — 이 Phase 2 는 *앱 자신의 라이선스* 검증 클라이언트로, 원격 제어(remote-iroh, peer 모델)와는 **별개**다. 둘은 Ed25519/nonce 같은 암호 1차요소를 공유하나 목적이 다르다.
- [ ] 공개키 내장
- [ ] machine_id 핑거프린트
- [ ] nonce 생성 + `/verify` 호출
- [ ] 서명·nonce·machine_id·issued_at 검증
- [ ] 토큰 암호화 캐시 + 오프라인 유예
- [ ] 기능을 토큰 파생 키에 엮기

### Phase 3 — 발급/판매 연동
- [ ] Paddle 웹훅 어댑터 → 공통 "라이선스 발급" 인터페이스 (서명 검증 포함)
- [ ] 웹훅 → 라이선스 자동 발급 → 구매자 전달(이메일)
- [ ] 환불/해지 → revoke 경로 검증
- [ ] (스위치 대비) 포트원 어댑터 인터페이스만 미리 정의 — 활성화는 세금계산서/KRW 필요 시

### Phase 4 — 하드닝
- [ ] 인증서 핀닝
- [ ] DevTools off, strip, 코드 서명/notarization
- [ ] 검증 분기 다층화

---

## 9. 한계 & 정직한 주의사항

- 충분히 숙련된 공격자는 **결국 우회 가능**하다. 이 설계의 목표는 그것이 아니라 "일반 사용자/일반 크래커 차단 + 변조본 무력화"다.
- 완전 오프라인 단독 앱이면 강제력이 약해진다 — 가능한 핵심 가치를 서버/클라우드에 일부라도 두면 방어가 근본적으로 강해진다.
- 머신 바인딩은 정품 사용자 기기 교체 시 불편을 줄 수 있다 → 기기 재설정(deactivate) 기능 필수.
- 보안 난독화에 과투자하지 말 것. 가성비는 **서버 의존 설계 > 난독화**다.
- 가격·편의·지속 가치(업데이트·클라우드)로 **크랙 동기 자체를 낮추는 것**이 기술적 방어보다 효과적일 때가 많다.

---

## Paddle 연동 — 완성 구현 계획 및 코드

이 섹션은 **Paddle Billing**(2026년 기준 검증, 레거시 Classic 미사용)을 Tauri 데스크톱 앱 + Cloudflare Worker 라이선스 시스템에 연동하는 완성된 구현 계획과 코드를 다룬다. 대상 판매자는 한국 사업자이며, 국내 고객과 전 세계 고객 모두에게 판매하는 상황을 전제로 한다. Paddle은 **Merchant of Record(MoR)** 로서 전 세계 부가세/판매세를 대신 계산·징수·납부하지만, 이는 판매자의 한국 소득세/법인세·부가세 신고 의무를 면제하지 않는다 — 자세한 내용은 한국 세무 섹션을 참고한다.

### 종단 간(end-to-end) 시퀀스 개요

전체 신뢰 경계는 단 하나다: **Paddle API 키·웹훅 시크릿·Ed25519 개인키는 Worker에만 존재**하고, 앱에는 32바이트 공개키만 임베드된다. 흐름은 두 개의 비동기 트랙으로 나뉜다.

```
[트랙 A — 결제에서 라이선스 발급까지]
앱 → Worker POST /checkout/session
   → Worker가 order_id 생성 + KV에 pending intent 기록
   → 앱이 시스템 브라우저로 Paddle 체크아웃 오픈 (client_token, price_id, custom_data)
   → 사용자 결제 (KRW: KakaoPay/Naver Pay 등)
   → Paddle 웹훅 POST /webhooks/paddle (Paddle-Signature: ts=…;h1=…)
   → Worker: raw body 먼저 읽기 → HMAC-SHA256 서명 검증 → replay 가드 → JSON.parse
   → event_id 멱등성 + occurred_at 순서 가드
   → data.status로 license state 도출 → KV license:{app_user_id} 기록 → 200

[트랙 B — 앱의 Ed25519 검증]
앱 → Worker POST /verify/challenge { app_user_id } → nonce 발급
앱 → Worker POST /verify { app_user_id, nonce }
   → Worker: nonce 소비 + license state 조회 → assertion 구성 → Ed25519 서명
   → 앱: verify_strict(임베드 공개키) + nonce 일치 + freshness + user 일치 + state 게이트
```

두 트랙은 KV의 라이선스 레코드(`license:{app_user_id}`)를 공유점으로 만난다. 트랙 A는 웹훅이 쓰고, 트랙 B는 `/verify`가 읽는다.

---

## Paddle 연동 개요 · 계정 설정 · 결제 시퀀스

### Billing 선택 근거

이 프로젝트는 **Paddle Billing**을 사용한다. 레거시인 Paddle Classic은 사용하지 않는다. 새 통합은 전적으로 Billing 위에서 구축한다.

- **단일 REST API + 중앙 집중 이벤트 스트림.** Billing은 통합 REST API와 40개 이상의 타입화된 웹훅 이벤트(페이로드가 API 응답 구조를 그대로 미러링)를 제공한다. Classic의 분산된 다중 API와 달리 결제 흐름 전체를 하나의 모델로 다룰 수 있다.
- **`custom_data`로 주문 상관관계 추적.** 체크아웃에서 설정한 `custom_data`가 transaction(및 구독)에 복사되고 관련 웹훅마다 `data.custom_data`로 되돌아온다. 이것이 결제와 앱 사용자/주문을 잇는 유일한 메커니즘이다. (Classic의 `passthrough` 필드는 사용하지 않는다.)
- **한국 결제수단·KRW 네이티브 지원.** KakaoPay, Naver Pay, Samsung Pay, Payco와 KRW 가격이 Billing 체크아웃에 기본 지원된다.
- **웹훅 서명 스킴 호환성.** 아래에서 다루는 `Paddle-Signature` 헤더 + HMAC-SHA256 방식은 Billing 전용 스킴이다. Classic의 스킴(`p_signature` 본문 필드, PHP 직렬화 필드에 대한 RSA/SHA-1)은 완전히 다른 비호환 방식이며, 이 코드베이스 어디에도 구현해서는 안 된다.

또한 Paddle은 **Merchant of Record (MoR)** 다. 즉 Paddle이 최종 고객에 대한 판매자이며, 전 세계 부가세/판매세를 대신 계산·징수·납부한다. 판매자(이 앱 개발사)는 해외 VAT 등록·신고 의무가 없다. 다만 이는 한국 측 소득세/법인세·부가세 신고 의무를 면제하지 않는다 — 자세한 내용은 별도 세무 섹션을 참고한다.

### 환경 분리: 샌드박스 vs 라이브

Paddle의 샌드박스와 라이브는 **완전히 분리된 워크스페이스**다. 각자 고유한 API 키, client-side token, 제품/가격, 웹훅 시크릿을 가진다. 환경 선택은 **베이스 URL 호스트 + 키 prefix 두 가지로 동시에 결정**되므로, 환경마다 올바른 호스트와 자격증명을 짝지어 바인딩해야 한다.

| 항목 | Sandbox | Live |
|---|---|---|
| API 베이스 URL | `https://sandbox-api.paddle.com` | `https://api.paddle.com` |
| API 키 prefix (서버, 비밀) | `pdl_sdbx_apikey_…` | `pdl_live_apikey_…` |
| Client-side token (프론트, 공개) | `test_…` | `live_…` |
| Paddle.js `Paddle.Environment.set()` | `"sandbox"` | `"production"` |
| 웹훅 엔드포인트 시크릿 (목적지별) | `pdl_ntfset_…` | `pdl_ntfset_…` |

> 베이스 URL 관련 참고: `https://sandbox-api.paddle.com`은 문서에서 직접 인용 확인된 값이고, 라이브 호스트 `https://api.paddle.com`은 Paddle의 잘 알려진 운영 호스트로 고신뢰 값이지만, 인증 문서 페이지에서 라이브 문자열이 그대로 재인용되지는 않았다. 운영 배포 전 라이브 인증 페이지에서 5초 확인을 권장한다.

**API 인증은 서버 사이드 전용이다.** 헤더는 `Authorization: Bearer <api_key>` 형식을 쓰며, API 키는 **절대 클라이언트(프론트)에 노출하지 않는다.** 프론트엔드는 공개용 client-side token(`test_…` / `live_…`)만 사용한다.

### 자격증명·시크릿 준비

Paddle 대시보드에서 환경별로 다음을 준비한다. 샌드박스에서 전체 플로우를 검증한 뒤 동일 절차를 라이브에서 반복한다.

1. **API 키** (서버, 비밀)
   - 위치: Dashboard → Developer Tools → Authentication → **API keys** 탭에서 생성.
   - 형식: 69자(언더스코어 정확히 5개), prefix가 환경을 인코딩 (`pdl_sdbx_apikey_…` / `pdl_live_apikey_…`).
   - 보관처: Cloudflare Worker의 시크릿 바인딩에만 둔다. 프론트/리포지토리에 절대 커밋하지 않는다.
   - 용도: 서버에서 `GET /customers/{id}` 등 Paddle REST 호출 시 `Authorization: Bearer` 토큰.

2. **Client-side token** (프론트, 공개)
   - 위치: Dashboard → Developer Tools → Authentication → **Client-side tokens** → New client-side token.
   - 형식: prefix가 환경을 인코딩 (`test_…` 샌드박스 / `live_…` 라이브), 뒤에 27자 랜덤 문자열. 프론트 노출이 안전하도록 권한이 체크아웃 오픈·가격 미리보기 등으로 한정된다.
   - 용도: Paddle.js `Paddle.Initialize({ token })`. 이 토큰은 Worker가 `/checkout/session` 응답으로 앱에 내려준다(앱이 하드코딩하지 않는다).

3. **웹훅 엔드포인트 시크릿** (`pdl_ntfset_…`)
   - 위치: Dashboard의 알림(notification) 목적지 설정에서 목적지별로 발급. 각 목적지가 고유한 시크릿을 가진다.
   - 용도: Worker가 들어오는 웹훅의 `Paddle-Signature`를 HMAC-SHA256으로 검증할 때 키로 사용. **raw UTF-8 문자열 바이트 그대로** 키 머티리얼로 쓴다(base64/hex 디코딩하지 않으며, `pdl_ntfset_` prefix도 키의 일부다).
   - 보관처: Worker 시크릿 바인딩(예: `PADDLE_WEBHOOK_SECRET`).

이와 별개로, `/verify` 챌린지-응답에 쓰이는 **Ed25519 키쌍**이 있다. 개인키는 **오직 Worker만** 보유하고, 32바이트 공개키는 앱 바이너리에 임베드한다. 이 키쌍은 Paddle이 발급하는 것이 아니라 이 프로젝트가 자체 생성하는 라이선스 서명용 키다.

### 제품/가격 등록

Paddle Billing의 카탈로그는 **Product → 다수의 Price** 구조다. Product는 *무엇을* 파는지(이름, 세금 카테고리, 설명, 이미지)를, Price는 *얼마를 / 얼마나 자주* 받는지를 기술한다.

- **REST 경로** (대시보드에서 수동 생성하거나 API로 생성):
  - Products: `POST /products`, `GET /products`, `GET /products/{id}`, `PATCH /products/{id}`
  - Prices: `POST /prices`, `GET /prices`, `GET /prices/{id}`, `PATCH /prices/{id}` (목록은 `recurring` 필터 지원)
  - (참고: 업데이트 HTTP 메서드는 Billing 관례상 `PATCH`다. 코드 작성 전 해당 엔드포인트 레퍼런스 페이지에서 확인 권장.)

- **일회성(perpetual) vs 구독(subscription) 구분은 Price의 `billing_cycle`로 결정된다** (Product가 아니라 Price 레벨):
  - `billing_cycle` = `null` → **일회성 가격** (perpetual 라이선스).
  - `billing_cycle` = `{ interval, frequency }` (예: `interval: "month"`, `frequency: 1`) → **반복 가격** (subscription).
  - `unit_price` = `{ amount, currency_code }`. `amount`는 최소 단위 문자열(예: KRW `"10000"`). 한국 결제수단을 노출하려면 가격을 **KRW**로 등록해야 한다.
  - `trial_period` = `{ interval, frequency }` 또는 `null`. 트라이얼은 `billing_cycle`을 **요구**한다(없으면 `price_trial_period_requires_billing_cycle` 에러).

- **한국 결제수단 노출 조건** (두 조건 모두 충족 시 자동 노출):
  1. 아이템이 **KRW**로 가격 책정되어 있고,
  2. 고객 주소 국가가 **한국**(`countryCode: "KR"`).
  - 결제수단의 **활성화 자체는 대시보드에서만** 한다: Dashboard → Checkout → Checkout settings → General 탭에서 KakaoPay / Naver Pay / Samsung Pay / Payco를 체크 후 저장. 코드의 `allowedPaymentMethods`는 **제한(restrict)만** 할 수 있고 활성화는 못 한다. (검증된 식별자: `kakao_pay`, `naver_pay`, `samsung_pay`, `payco` — 출시 전 메서드 레퍼런스 페이지에서 snake_case 철자 재확인 권장.)

생성한 Price의 ID(`pri_…`)는 Worker의 `/checkout/session` 응답에 담겨 프론트의 `Paddle.Checkout.open({ items: [{ priceId }] })`로 전달된다.

### 결제 → 웹훅 → 발급 → 앱 검증 전체 시퀀스

전체 아키텍처는 **Tauri 데스크톱 앱 → 시스템 브라우저의 Paddle 체크아웃 → Cloudflare Worker로 웹훅 → Worker가 KV에 라이선스 기록 → 앱이 Ed25519 챌린지-응답으로 `/verify`** 흐름이다. 신뢰 경계는 명확하다: API 키와 웹훅 시크릿, Ed25519 개인키는 Worker에만 있고, 앱은 공개키만 가진다.

#### 트랙 A — 결제에서 라이선스 발급까지

```
App (Tauri)            Worker                  Paddle                 Browser
   |                     |                        |                      |
   | 1. POST /checkout/session                    |                      |
   |   { app_user_id, license_kind, price_id }    |                      |
   |-------------------->|                        |                      |
   |                     | 2. order_id 생성, KV에 |                      |
   |                     |    pending intent 기록 |                      |
   |                     |    (order:{order_id} → app_user_id)          |
   |                     |                        |                      |
   |   3. 200 { order_id, client_token,           |                      |
   |        environment, price_id, custom_data }  |                      |
   |<--------------------|                        |                      |
   |                     |                        |                      |
   | 4. opener로 체크아웃 페이지 오픈 (system browser)                    |
   |    Paddle.js: Environment.set + Initialize(client_token)            |
   |    Checkout.open({ items:[{priceId}], customData })                 |
   |--------------------------------------------------------->|          |
   |                     |                        |  5. 사용자 결제       |
   |                     |                        |     (KRW: KakaoPay/   |
   |                     |                        |      Naver Pay 등)    |
   |                     |                        |<---------------------|
   |                     |                        |                      |
   |                     | 6. 웹훅 POST           |                      |
   |                     |   Paddle-Signature: ts=…;h1=…[;h1=…]          |
   |                     |   body = transaction.completed                |
   |                     |          또는 subscription.created            |
   |                     |   data.custom_data = { app_user_id,          |
   |                     |        order_id, license_kind, schema }       |
   |                     |<-----------------------|                      |
   |                     |                        |                      |
   |                     | 7. raw body 먼저 읽기 (request.text(), 1회)   |
   |                     |    서명 검증 (JSON.parse 이전):                |
   |                     |    a. 헤더에서 ts + 모든 h1 파싱              |
   |                     |       (시크릿 로테이션 중 h1 다중 가능)        |
   |                     |    b. 리플레이 가드:                          |
   |                     |       |now - ts| > tolerance(예: 300s) → 거부 |
   |                     |    c. signed = `${ts}:${rawBody}`             |
   |                     |       expected = HMAC-SHA256(                  |
   |                     |         secret=pdl_ntfset_…(raw UTF-8), signed)|
   |                     |       lowercase hex 변환                       |
   |                     |    d. expected == 임의의 h1 (timing-safe)     |
   |                     |       하나라도 일치하면 통과                   |
   |                     |    실패 시 → 401 "Invalid signature"          |
   |                     |    ts 초과 시 → 401 "Stale timestamp"         |
   |                     |                        |                      |
   |                     | 8. 검증 통과 후 JSON.parse                    |
   |                     |    멱등성/순서 가드:                           |
   |                     |    - event:{event_id} 존재 → 200 no-op (중복) |
   |                     |      (dedupe 키는 event_id=evt_…,             |
   |                     |       notification_id=ntf_… 아님)             |
   |                     |    - occurred_at <= last_occurred_at          |
   |                     |      → 200 no-op (지연/역순)                   |
   |                     |    - custom_data 결측 → 200 no-op (미상관)    |
   |                     |                        |                      |
   |                     | 9. license_kind 분기:                         |
   |                     |    perpetual  → transaction.completed가 권위   |
   |                     |    subscription → data.status로 state 결정    |
   |                     |      (trialing→active로 정규화 후 기록)        |
   |                     |    license:{app_user_id} 기록 작성/갱신:       |
   |                     |    { state, paddle:{...}, last_event_id,      |
   |                     |      last_occurred_at, ... }                  |
   |                     |    event:{event_id}="1" TTL 24h               |
   |                     |    → 200 (빠르게 응답)                         |
   |                     |                        |                      |
   |  (선택) 10. deep-link 콜백 myapp://license/callback (빠른 경로)      |
   |    또는 /verify 폴링 (크로스플랫폼 기본 경로)                         |
```

핵심 규칙 요약:

- **raw body는 반드시 검증 전에 1회만 읽는다.** `request.json()`은 raw 바이트를 버리고 재직렬화(키 재정렬/공백)는 다른 HMAC을 만들어 검증을 깨뜨린다. `await request.text()`로 문자열을 잡아 그 문자열로 검증하고, **통과 후에만** `JSON.parse(rawBody)`한다.
- **리플레이 보호는 필수다.** `ts`와 현재 시각의 차이가 허용 윈도우(Paddle SDK 기본 5초; Worker는 시계 편차 대비 더 넓은 값 — 예: 300초 — 권장)를 넘으면 거부한다. 윈도우가 없으면 캡처된 유효 웹훅을 영구 재생할 수 있다. (300초는 Paddle 문서가 명시한 값이 아니라 운영상의 보수적 선택이다.)
- **`h1`은 다중일 수 있다.** 시크릿 로테이션 중 헤더에 `h1`이 여러 개 올 수 있으므로 모든 `h1`을 파싱해 **하나라도 일치하면** 통과시킨다. 단일 `h1` 비교는 로테이션 중 검증을 깨뜨린다.
- **비교는 항상 timing-safe.** Workers에는 `crypto.timingSafeEqual`이 없으므로 길이 확인 후 XOR 누적 방식의 상수시간 비교를 쓴다. `==`/`===` 금지.
- **권위는 이벤트 이름이 아니라 페이로드 상태에 있다.** 이벤트 이름은 핸들러를 고르고, `data.status`(구독) 또는 transaction/adjustment 상태가 라이선스 `state`를 결정한다.
- **구독은 `subscription.created`에서 즉시 접근 부여한다.** `subscription.activated`를 기다리지 않는다. `data.status`가 `trialing`이어도 `active`로 취급한다.
- **환불은 `adjustment.created`/`adjustment.updated`로만 처리한다.** Billing에는 `refund.*` 이벤트가 없다. 전액 환불 시 라이선스를 `refunded`로 revoke한다.
- **멱등성 dedupe 키는 `event_id`(`evt_…`)이며 `notification_id`(`ntf_…`)가 아니다.** 순서 가드는 `occurred_at` 비교로 한다.
- **`data.items`는 배열이다.** 멀티아이템 구독이 존재하므로 `items[0]`만 보지 말고 전체 아이템에 걸쳐 권한을 매핑한다. 플랜/티어 매핑은 `data.items[].price.id`를 권장한다.
- 처리하지 않는 이벤트, 중복, 미상관 결제는 모두 **`200`으로 무시**한다(라이선스를 만들지 않는다).

#### 트랙 B — 앱의 Ed25519 검증

앱은 캐시된 값을 신뢰하지 않고, 매번 서버에 살아있는 서명된 권한을 요청한다. 2단계 nonce 챌린지-응답이다.

```
App (Tauri)                         Worker
   |                                   |
   | 1. POST /verify/challenge         |
   |    { app_user_id }                |
   |---------------------------------->|
   |                                   | 2. nonce 생성 (단일 사용, 짧은 TTL)
   |                                   |    app_user_id에 키잉하여 저장
   |   3. 200 { nonce, expires_at }    |
   |<----------------------------------|
   |                                   |
   | 4. POST /verify                   |
   |    { app_user_id, nonce }         |
   |---------------------------------->|
   |                                   | 5. nonce 검증 (미상용/미만료/단일사용)
   |                                   |    license:{app_user_id} 조회 → state
   |                                   |    assertion 구성 (고정 키 순서):
   |                                   |      app_user_id, state, license_kind,
   |                                   |      nonce, issued_at, expires_at
   |                                   |    Ed25519 개인키로 canonical bytes 서명
   |   6. 200 { assertion, signature } |
   |<----------------------------------|
   |                                   |
   | 7. 클라이언트 수락 조건 (전부 충족해야 함):
   |    a. verify_strict(임베드 공개키, canonical_bytes, sig) == Ok
   |    b. assertion.nonce == 내가 보낸 nonce  (anti-replay)
   |    c. now < assertion.expires_at          (freshness)
   |    d. assertion.app_user_id == 내 사용자
   |    e. assertion.state ∈ {active, past_due} → 권한 부여
   |       (trialing은 Worker가 active로 정규화하므로 여기 active에 포함)
   |       state ∈ {paused, canceled, refunded} → 권한 없음
```

서명 검증의 핵심은 **canonical bytes의 정확한 재구성**이다. `signature`는 `assertion` 객체를 고정 키 순서(`app_user_id`, `state`, `license_kind`, `nonce`, `issued_at`, `expires_at`)로 공백 없는 compact JSON 직렬화한 UTF-8 바이트에 대한 Ed25519 서명이다. Worker는 정확히 그 직렬화로 emit하고, 클라이언트는 동일한 바이트를 재구성해 `ed25519-dalek` v2의 `verify_strict`로 검증한다 — **다른 키 순서로 재직렬화하면 안 된다.**

ed25519-dalek v2 API 주의점:
- `VerifyingKey::from_bytes(&[u8; 32])`는 `Result`를 반환한다(약한/소위수 키 거부 가능).
- `Signature::from_bytes(&[u8; 64])`는 **infallible**이며 `Signature`를 직접 반환한다(v1의 슬라이스 기반 `Result`와 다름).
- 검증은 반드시 `verify_strict`를 쓴다. 일반 `verify()`는 약한 공개키 검사를 생략해, 조작된 약한 키로 임의 메시지가 통과될 수 있다.

캐시된 서명 assertion을 `keyring`(OS 보안 저장소)으로 오프라인 유예용 저장할 수는 있으나, 로드할 때마다 `verify_strict`와 freshness/nonce 검사를 다시 돌려야 한다. 저장소의 기밀성은 보너스일 뿐 신뢰 기준점이 아니다. (`tauri-plugin-store`는 평문 디스크 저장이므로 기밀성이 없다 — 서명으로 무결성은 보장되나 기밀성이 필요하면 keyring을 쓴다.)

#### Worker의 에러 응답 (양 트랙 공통)

HTTP 상태가 클래스를 전달하고, 본문은 `{ "error": "code_string", "message": "..." }` 형태다.

| Status | `error` | 상황 |
|---|---|---|
| `400` | `invalid_request` | 본문 형식 오류 / 필수 필드 결측 |
| `401` | `invalid_signature` | (웹훅) Paddle 서명(HMAC) 검증 실패 또는 헤더 파싱 불가 |
| `401` | `stale_timestamp` | (웹훅) `ts`가 허용 윈도우를 벗어남 — 리플레이 의심 |
| `403` | `not_entitled` | `/verify` 결과 상태가 접근 거부(`paused`/`canceled`/`refunded`) |
| `404` | `no_license` | `app_user_id`에 대한 라이선스 기록 없음 |
| `409` | `nonce_invalid` | `/verify` nonce 미상/만료/재사용 |
| `429` | `rate_limited` | KV 핫키(동일 키 1 write/sec 초과) 또는 레이트 가드 발동 |
| `200` | — | 성공. 웹훅은 무시/중복/미상관 이벤트에도 `200` 반환 |

> 멱등성 주의: KV는 결과적 일관성(동일 위치 read-after-write는 일관, 글로벌 전파 최대 60초) + last-write-wins라 강한 분산 락이 아니다. best-effort dedupe에는 충분하나 엄격한 exactly-once가 필요하면 Durable Objects를 쓴다.

---

## Cloudflare Worker — Paddle 웹훅 수신 · 서명 검증 · 라이선스 발급

이 Worker는 Paddle Billing이 보내는 웹훅을 받아 **서명을 검증한 뒤에만** 페이로드를 신뢰하고, 이벤트별로 KV에 라이선스 레코드를 발급/갱신/취소한다. 보안상 핵심 4가지는 (1) **raw body를 먼저 읽고** 그 위에서 HMAC-SHA256을 계산하는 것, (2) `ts` 허용오차로 replay를 막는 것, (3) `event_id` 기반 멱등성, (4) `occurred_at` 기반 순서 보호다. 엔타이틀먼트 상태는 **이벤트 이름이 아니라 `data.status`(구독) / 트랜잭션·조정 상태**에서 도출한다 — 이벤트 이름은 핸들러만 고른다.

> 보안 경계: 서명 검증을 통과하기 전에는 `JSON.parse`조차 하지 않는다. 검증 실패는 `401`. 미상관/중복/미지원 이벤트는 모두 `200`으로 빠르게 종료해 Paddle 재시도를 유발하지 않는다.

### `wrangler.toml` 바인딩

```toml
name = "paddle-license-worker"
main = "src/index.ts"
compatibility_date = "2025-01-01"

# License records, order index, idempotency keys all live in one namespace.
kv_namespaces = [
  { binding = "LICENSE_KV", id = "<your_kv_namespace_id>" }
]

# Secrets (set via `wrangler secret put`, never commit):
#   PADDLE_WEBHOOK_SECRET   -> per-destination endpoint secret, prefix pdl_ntfset_...
```

`PADDLE_WEBHOOK_SECRET`은 알림 대상(destination)마다 다른 `pdl_ntfset_…` 시크릿이며 **raw UTF-8 문자열 그대로** HMAC 키로 쓴다(base64/hex 디코딩 금지 — 접두사도 키 일부다).

### 전체 Worker 코드 (`src/index.ts`)

```typescript
// Paddle Billing webhook -> Cloudflare KV license issuer.
// SECURITY-CRITICAL: signature is verified over the RAW body BEFORE any JSON.parse.

export interface Env {
  LICENSE_KV: KVNamespace;
  PADDLE_WEBHOOK_SECRET: string; // pdl_ntfset_... (raw UTF-8 HMAC key)
}

// ---- License record types (KV schema, contract section 5.2) ----

type LicenseState = "active" | "past_due" | "paused" | "canceled" | "refunded";
type LicenseKind = "perpetual" | "subscription";

interface LicenseRecord {
  schema: 1;
  app_user_id: string;
  order_id: string;
  license_kind: LicenseKind;
  state: LicenseState;
  paddle: {
    customer_id: string | null;
    subscription_id: string | null;
    transaction_id: string | null;
    price_id: string | null;
    product_id: string | null;
  };
  last_event_id: string;
  last_occurred_at: string; // RFC3339; ordering guard
  created_at: string;
  updated_at: string;
}

// custom_data shape set at checkout (contract section 4).
interface CustomData {
  app_user_id?: string;
  order_id?: string;
  license_kind?: LicenseKind;
  schema?: number;
}

// =====================================================================
// 1. Signature verification (contract section 3 — canonical algorithm)
// =====================================================================

// Hex-encode an ArrayBuffer (Workers-native; no Node Buffer dependency).
function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Constant-time string compare over equal-length hex strings.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// Verify Paddle-Signature header against the RAW body.
// toleranceSec = 300 is a PROJECT decision (Paddle documents only 5s).
async function verifyPaddleSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  toleranceSec = 300,
): Promise<boolean> {
  if (!signatureHeader) return false;

  // Parse "ts=...;h1=...;h1=..." generically (h1 may repeat during rotation).
  // Key is trimmed defensively; Paddle emits no spaces, but proxies may add them.
  let ts: string | null = null;
  const h1s: string[] = [];
  for (const part of signatureHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1);
    if (k === "ts") ts = v;
    else if (k === "h1") h1s.push(v);
  }
  if (!ts || h1s.length === 0) return false;

  // Replay protection: reject if |now - ts| exceeds tolerance.
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - tsNum) > toleranceSec) return false;

  // signed_payload = ts + ":" + raw_request_body  (literal colon).
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret), // pdl_ntfset_... as raw UTF-8, NOT decoded
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}:${rawBody}`));
  const expected = toHex(mac); // lowercase hex (NOT base64)

  // Accept if any h1 matches (constant-time per candidate).
  return h1s.some((h1) => timingSafeEqual(expected, h1));
}

// =====================================================================
// 2. Webhook envelope + payload accessors
// =====================================================================

interface WebhookEnvelope {
  event_id: string; // evt_...  (dedupe key — NEVER notification_id)
  event_type: string;
  occurred_at: string; // RFC3339; ordering guard
  notification_id?: string; // ntf_...  (delivery id, do not dedupe on this)
  data: Record<string, any>;
}

function readCustomData(data: Record<string, any>): CustomData {
  const cd = data?.custom_data;
  return cd && typeof cd === "object" ? (cd as CustomData) : {};
}

// Pick the entitlement-bearing price/product across (possibly multi-item) data.items.
// Contract: data.items is an array — do not assume items[0]. We take the first
// item that carries a price id; multi-item entitlement mapping beyond that is
// out of scope for a single-license record.
function readPriceProduct(data: Record<string, any>): {
  price_id: string | null;
  product_id: string | null;
} {
  const items: any[] = Array.isArray(data?.items) ? data.items : [];
  for (const it of items) {
    const priceId = it?.price?.id ?? null;
    if (priceId) {
      // product_id reachable via price.product_id or item.product.id.
      const productId = it?.price?.product_id ?? it?.product?.id ?? null;
      return { price_id: priceId, product_id: productId };
    }
  }
  return { price_id: null, product_id: null };
}

// =====================================================================
// 3. State derivation (contract section 5.4)
// =====================================================================

// Map a Paddle subscription data.status to our license state.
// Subscription entitlement is driven by status, NOT by event name.
function stateFromSubscriptionStatus(status: string | undefined): LicenseState | null {
  switch (status) {
    case "trialing": // trial treated as active
    case "active":
      return "active";
    case "past_due":
      return "past_due";
    case "paused":
      return "paused";
    case "canceled":
      return "canceled";
    default:
      return null; // unknown status: do not invent a state
  }
}

// Detect a FULL refund on an adjustment. Paddle has no refund.* event; refunds
// are adjustments. We revoke only on a full refund that has been (or is being)
// approved. action === "refund" + a non-rejected status => revoke.
function isFullRefund(data: Record<string, any>): boolean {
  if (data?.action !== "refund") return false;
  const status = data?.status; // e.g. pending_approval | approved | rejected
  return status !== "rejected";
}

// =====================================================================
// 4. KV write path with idempotency + ordering guard (contract 5.5)
// =====================================================================

interface ApplyInput {
  env: Env;
  envelope: WebhookEnvelope;
  custom: CustomData;
  nextState: LicenseState;
  paddlePatch: Partial<LicenseRecord["paddle"]>;
}

// Returns the HTTP status the handler should return (always 200 on the happy
// path and on dedupe/stale; the caller only differs on 401 signature failure).
async function applyLicenseTransition(input: ApplyInput): Promise<number> {
  const { env, envelope, custom, nextState, paddlePatch } = input;
  const appUserId = custom.app_user_id;
  const orderId = custom.order_id;

  // Uncorrelated payment: never mint a license without the join keys.
  if (!appUserId || !orderId) {
    console.log(
      `skip uncorrelated event ${envelope.event_id} (${envelope.event_type}): missing app_user_id/order_id`,
    );
    return 200;
  }

  const eventKey = `event:${envelope.event_id}`;
  const licenseKey = `license:${appUserId}`;
  const orderKey = `order:${orderId}`;

  // (1) Idempotency: already-processed event_id -> no-op. This OWNS duplicate-by-id
  //     detection (Paddle redelivers the SAME event_id on retry / at-least-once).
  const seen = await env.LICENSE_KV.get(eventKey);
  if (seen !== null) {
    return 200;
  }

  // (2) Ordering guard: ignore only STRICTLY-OLDER events (research: "ignore if older").
  //     Use `>` not `>=`: same-instant DISTINCT events (different event_id sharing one
  //     occurred_at, e.g. subscription.updated + subscription.activated) must NOT be
  //     dropped. True same-event duplicates are already caught by step (1) above.
  const existing = await env.LICENSE_KV.get<LicenseRecord>(licenseKey, { type: "json" });
  if (existing && existing.last_occurred_at > envelope.occurred_at) {
    // Strictly-older event: out-of-order redelivery. No-op, but mark the event seen
    // so a later retry of this same stale event short-circuits at step (1).
    await env.LICENSE_KV.put(eventKey, "1", { expirationTtl: 86400 });
    return 200;
  }

  // (3) Apply state transition. Merge paddle fields (only overwrite non-null).
  const nowIso = new Date().toISOString();
  const mergedPaddle = {
    customer_id: paddlePatch.customer_id ?? existing?.paddle.customer_id ?? null,
    subscription_id: paddlePatch.subscription_id ?? existing?.paddle.subscription_id ?? null,
    transaction_id: paddlePatch.transaction_id ?? existing?.paddle.transaction_id ?? null,
    price_id: paddlePatch.price_id ?? existing?.paddle.price_id ?? null,
    product_id: paddlePatch.product_id ?? existing?.paddle.product_id ?? null,
  };

  const record: LicenseRecord = {
    schema: 1,
    app_user_id: appUserId,
    order_id: orderId,
    license_kind: custom.license_kind ?? existing?.license_kind ?? "perpetual",
    state: nextState,
    paddle: mergedPaddle,
    last_event_id: envelope.event_id,
    last_occurred_at: envelope.occurred_at,
    created_at: existing?.created_at ?? nowIso,
    updated_at: nowIso,
  };

  // (4) Persist record, order index, and idempotency marker.
  // KV is best-effort dedup (eventual consistency, last-write-wins), NOT a lock.
  await env.LICENSE_KV.put(licenseKey, JSON.stringify(record));
  await env.LICENSE_KV.put(orderKey, appUserId);
  await env.LICENSE_KV.put(eventKey, "1", { expirationTtl: 86400 });

  console.log(
    `applied ${envelope.event_type} evt=${envelope.event_id} user=${appUserId} -> ${nextState}`,
  );
  return 200;
}

// =====================================================================
// 5. Event routing (handler chosen by event_type; state from payload)
// =====================================================================

async function handleWebhookEvent(env: Env, envelope: WebhookEnvelope): Promise<number> {
  const { event_type: type, data } = envelope;
  const custom = readCustomData(data);
  const { price_id, product_id } = readPriceProduct(data);

  switch (type) {
    // --- One-time (perpetual) purchase ---
    case "transaction.completed": {
      // data.id is the transaction id (txn_...); data.customer_id may be present.
      return applyLicenseTransition({
        env,
        envelope,
        custom,
        nextState: "active",
        paddlePatch: {
          transaction_id: data?.id ?? null,
          customer_id: data?.customer_id ?? null,
          price_id,
          product_id,
        },
      });
    }

    // --- Subscription lifecycle: state derived from data.status ---
    case "subscription.created":
    case "subscription.activated":
    case "subscription.updated": {
      const next = stateFromSubscriptionStatus(data?.status);
      if (next === null) {
        // Unknown status -> ignore safely (200), do not mutate the record.
        console.log(`ignore ${type} evt=${envelope.event_id}: unknown status ${data?.status}`);
        return 200;
      }
      return applyLicenseTransition({
        env,
        envelope,
        custom,
        nextState: next,
        paddlePatch: {
          subscription_id: data?.id ?? null,
          customer_id: data?.customer_id ?? null,
          price_id,
          product_id,
        },
      });
    }

    // --- Subscription state events (state from the event itself) ---
    case "subscription.past_due":
      return applyLicenseTransition({
        env,
        envelope,
        custom,
        nextState: "past_due",
        paddlePatch: { subscription_id: data?.id ?? null, customer_id: data?.customer_id ?? null, price_id, product_id },
      });

    case "subscription.paused":
      return applyLicenseTransition({
        env,
        envelope,
        custom,
        nextState: "paused",
        paddlePatch: { subscription_id: data?.id ?? null, customer_id: data?.customer_id ?? null, price_id, product_id },
      });

    case "subscription.canceled":
      // Revoke only when status is genuinely canceled. A merely scheduled cancel
      // keeps data.status = active and arrives as subscription.updated, not here.
      return applyLicenseTransition({
        env,
        envelope,
        custom,
        nextState: "canceled",
        paddlePatch: { subscription_id: data?.id ?? null, customer_id: data?.customer_id ?? null, price_id, product_id },
      });

    // --- Refunds: the ONLY refund channel is adjustment.* (no refund.* event) ---
    case "adjustment.created":
    case "adjustment.updated": {
      if (!isFullRefund(data)) {
        // Partial refund / credit / non-refund adjustment: keep access.
        console.log(`ignore ${type} evt=${envelope.event_id}: not a full refund`);
        return 200;
      }
      // Adjustment custom_data is not guaranteed; if missing, applyLicenseTransition
      // no-ops on uncorrelated. customer_id is on the adjustment payload.
      return applyLicenseTransition({
        env,
        envelope,
        custom,
        nextState: "refunded",
        paddlePatch: { customer_id: data?.customer_id ?? null },
      });
    }

    // --- Any other event: acknowledged and ignored ---
    default:
      return 200;
  }
}

// =====================================================================
// 6. Worker entry: read raw -> verify -> parse -> route
// =====================================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // This Worker also serves /checkout/session and /verify in the full app;
    // here we route only the webhook path. Other paths fall through to 404.
    if (url.pathname !== "/webhooks/paddle") {
      return new Response("Not Found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // (a) Read the RAW body exactly once, BEFORE any parsing.
    const rawBody = await request.text();
    const signatureHeader = request.headers.get("Paddle-Signature");

    // (b) Verify signature over raw bytes. Fail closed with 401.
    const ok = await verifyPaddleSignature(rawBody, signatureHeader, env.PADDLE_WEBHOOK_SECRET);
    if (!ok) {
      return new Response("Invalid signature", { status: 401 });
    }

    // (c) Parse JSON only AFTER verification passes.
    let envelope: WebhookEnvelope;
    try {
      envelope = JSON.parse(rawBody) as WebhookEnvelope;
    } catch {
      // Verified-but-unparseable should not happen; ack to avoid retry storms.
      return new Response("ok", { status: 200 });
    }
    if (!envelope?.event_id || !envelope?.event_type || !envelope?.occurred_at) {
      return new Response("ok", { status: 200 });
    }

    // (d) Route, dedupe, write license. Always 200 on the verified happy path.
    try {
      await handleWebhookEvent(env, envelope);
    } catch (err) {
      // Returning non-2xx makes Paddle retry. We log and still 200 only for
      // benign errors; for genuine transient KV failures we WANT a retry, so
      // surface a 500 to trigger Paddle's at-least-once redelivery.
      console.error(`handler error evt=${envelope.event_id}:`, err);
      return new Response("internal error", { status: 500 });
    }

    return new Response("ok", { status: 200 });
  },
} satisfies ExportedHandler<Env>;
```

### 동작·보안 노트

- **검증 순서가 곧 보안.** `request.text()`로 raw를 한 번 읽고, 그 문자열로 HMAC을 계산한 뒤에만 `JSON.parse`한다. `request.json()`을 먼저 부르면 원본 바이트가 사라져 재직렬화 시 키 순서·공백이 달라지고 서명이 깨진다.
- **`ts:rawBody` 결합 문자는 콜론 `:`** 하나다(Paddle 문서의 "a colon (-)" 표기는 렌더링 오타이며 모든 SDK가 `:`로 확인된다). 시크릿은 `pdl_ntfset_…`를 **그대로** raw UTF-8 키로 import한다.
- **`h1`은 소문자 hex.** SHA-256 HMAC을 hex로 비교한다(base64 아님 — Cloudflare 공식 "Sign requests" 예제는 base64를 출력하므로 그 줄을 그대로 베끼지 말 것). 시크릿 회전 중에는 `h1`이 여러 개 올 수 있어 `some()`으로 어느 하나라도 일치하면 통과시킨다. 비교는 길이 검사 + XOR 누산의 상수시간 비교다(Workers에는 `crypto.timingSafeEqual`이 없다).
- **허용오차 300초는 이 프로젝트의 결정**이다. Paddle이 문서화한 값은 5초뿐이므로, 값을 바꾸려면 컨트랙트(Section 3 Step 3)에서 먼저 바꾼다. `Math.abs(now - ts)`로 과거·미래 양방향을 모두 막는다.
- **멱등성은 `event_id`(`evt_…`)로만.** `notification_id`(`ntf_…`)는 전달 ID라 중복 제거 키로 쓰면 안 된다. `event:{event_id}`는 24h TTL로 best-effort 중복 차단이다 — KV는 최종적 일관성·last-write-wins이라 강한 락이 아니다. 엄격한 exactly-once가 필요하면 Durable Object로 올려야 한다.
- **순서 보호는 `occurred_at` 비교, 단 `>` (strictly older)만 폐기.** 저장된 `last_occurred_at`보다 **엄격히 오래된** 이벤트만 no-op한다. `>=`를 쓰면 **같은 `occurred_at`을 공유하는 서로 다른 이벤트**(예: `subscription.updated` + `subscription.activated`가 동일 타임스탬프로 도착)를 잘못 폐기할 수 있다. 동일 `event_id`의 진짜 중복은 위 (1) 멱등성 검사가 이미 처리하므로, 순서 가드는 "older"만 책임진다(리서치의 "ignore if older"와 일치). (RFC3339 동일 포맷·UTC 가정하의 사전식 비교다. Paddle은 `…Z` UTC로 보내므로 안전하다.)
- **상태는 페이로드에서 도출.** 구독은 `data.status`로, 환불은 adjustment의 `action`/`status`로 결정한다. 이벤트 이름은 핸들러 선택용일 뿐이다. 예약 취소(`scheduled_change`만 설정)는 `status`가 여전히 `active`이므로 폐기하지 않고, 실제 `canceled`가 될 때만 폐기한다.
- **환불 채널은 `adjustment.*`뿐.** `refund.*` 이벤트는 존재하지 않는다. 여기서는 `action === "refund"` 이면서 `status !== "rejected"`인 경우만 전체 환불로 보고 `refunded`로 폐기한다. **검증 미확정:** adjustment payload의 정확한 `action`/`status` enum 값(`approved`/`pending_approval`/`rejected` 등)과 부분환불 식별 필드는 컨트랙트/리서치에서 verbatim으로 확인되지 않았다 — 라이브 연동 전 adjustment 레퍼런스에서 실제 값을 확인하고 `isFullRefund`를 보정하라.
- **미상관 결제는 발급하지 않는다.** `custom_data`에 `app_user_id` 또는 `order_id`가 없으면 라이선스를 만들지 않고 `200`-noop한다. 특히 `adjustment.*`는 `custom_data`가 항상 echo된다는 보장이 없어, 그 경우 `order:{order_id}` 인덱스나 `customer_id` 역조회가 별도로 필요할 수 있다(이 부분은 컨트랙트 범위 밖의 보강 포인트로 남겨 둔다).
- **에러 시 500 → 재시도.** KV 일시 장애 등은 `500`을 반환해 Paddle의 at-least-once 재전송을 유도한다. 검증 통과 후의 파싱 불가/필수 필드 누락만 `200`으로 ack해 재시도 폭주를 막는다.

---

## Cloudflare Worker — /verify 챌린지-응답 + Ed25519 서명

`/verify`는 앱이 로컬에 캐시한 값을 신뢰하지 않고, **서버가 매번 라이브로 서명한 entitlement 단언(assertion)** 을 받아 검증하는 2단계 nonce 챌린지-응답이다. Worker만 Ed25519 개인키를 보유하고, 앱은 32바이트 공개키를 임베드한다. 흐름은 CONTRACT 6.2를 그대로 따른다:

1. `POST /verify/challenge` — Worker가 단일 사용(single-use)·짧은 TTL nonce를 발급하고 `app_user_id`에 묶어 KV에 저장.
2. `POST /verify` — 앱이 받은 nonce를 echo. Worker는 nonce를 소비(consume)하고, KV 라이선스 레코드의 `state`를 읽어 assertion을 만들고 개인키로 서명해 반환.

### 서명 라이브러리 선택 근거

**Web Crypto API의 네이티브 Ed25519를 사용한다.** 별도 ed25519 npm 라이브러리(`@noble/ed25519`, `tweetnacl`)를 쓰지 않는다.

- Cloudflare Workers 런타임은 `crypto.subtle`에서 `Ed25519` 알고리즘(`importKey`/`sign`/`verify`/`generateKey`)을 네이티브로 지원한다. 외부 의존성·번들 크기·감사 표면이 0이다.
- 같은 코드베이스의 webhook 검증부(CONTRACT §3)가 이미 순수 Web Crypto(HMAC-SHA256, no Node Buffer)로 작성되어 있어, 동일한 `crypto.subtle` 패턴을 재사용하는 것이 일관적이다.
- 개인키는 PKCS#8 DER을 base64로 인코딩해 Worker 시크릿(`env.ED25519_PRIVATE_KEY_PKCS8_B64`)으로 주입한다. Web Crypto의 `importKey("pkcs8", …)`이 이 포맷을 직접 받는다.

> 주의(검증되지 않은 운영 디테일): Workers의 `Ed25519` `crypto.subtle` 지원은 현재 런타임에서 사용 가능하지만, 환경/배포 시점에 따라 `compatibility_date` 또는 `compatibility_flags`가 필요할 수 있다. 배포 전 `wrangler dev`에서 `crypto.subtle.importKey("pkcs8", …, "Ed25519", …)`이 throw하지 않는지 확인하라. 만약 런타임이 `Ed25519`를 거부하면, 같은 인터페이스를 유지한 채 서명 함수 내부만 `@noble/ed25519`로 교체하면 된다(공개키·서명 바이트 와이어 포맷은 동일).

### 키 페어 생성 (배포 전 1회, Worker 외부에서 실행)

개인키는 **절대 Worker 코드/저장소에 두지 않는다.** 아래 Node 스크립트로 생성한 뒤, base64 PKCS#8을 `wrangler secret put ED25519_PRIVATE_KEY_PKCS8_B64`로 주입하고, raw 공개키 32바이트(base64url)는 Tauri 앱에 임베드한다.

```js
// gen-keypair.mjs — run once with Node (NOT in the Worker).
// Output: PKCS#8 private key (base64, -> Worker secret)
//         raw 32-byte public key (base64url, -> embed in Tauri app).
import { webcrypto as crypto } from "node:crypto";

const { privateKey, publicKey } = await crypto.subtle.generateKey(
  { name: "Ed25519" },
  true, // extractable
  ["sign", "verify"],
);

const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));
const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey)); // 32 bytes

const b64 = (u8) => Buffer.from(u8).toString("base64");
const b64url = (u8) =>
  Buffer.from(u8).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

console.log("ED25519_PRIVATE_KEY_PKCS8_B64 (Worker secret):\n" + b64(pkcs8) + "\n");
console.log("PUBLIC KEY raw 32 bytes (embed in app, base64url):\n" + b64url(rawPub));
```

> Tauri 클라이언트 검증: 이 raw 32바이트 공개키를 `ed25519_dalek::VerifyingKey::from_bytes(&[u8; 32])`(Result)로 로드하고, 64바이트 서명을 `Signature::from_bytes(&[u8; 64])`(infallible)로 만든 뒤, **`verify()`가 아니라 `verify_strict()`** 로 검증한다. `verify_strict`만이 약한(small-order) 키 공격을 막는다. 검증 대상 메시지 바이트는 아래 `canonicalAssertionBytes()`가 만든 6키 compact JSON과 **바이트 단위로 동일**해야 한다.

### 디바이스 바인딩 / max_devices — 명시적 프로젝트 확장 (CONTRACT 미정의)

CONTRACT는 권위 출처다. 그런데 `/verify` 요청(§6.2)에는 `machine_id`가 없고, 라이선스 레코드 스키마(§5.2)에도 기기/`max_devices` 필드가 없다. 따라서 기기 바인딩은 **CONTRACT 위에 얹는 추가 레이어**로 구현하며, 그 사실을 코드에 인라인으로 표시한다. 절대 CONTRACT의 nonce 단언 바이트 정렬(키 순서)이나 KV 키 패턴을 바꾸지 않는다:

- `machine_id`는 `/verify/challenge`와 `/verify` 요청에 **선택적**으로 추가한다(둘 다 보내지 않으면 기기 바인딩을 건너뛰고 순수 CONTRACT 동작). CONTRACT가 정의한 필수 필드(`app_user_id`, `nonce`)는 그대로 유지한다.
- 기기 등록 상태는 **별도 KV 키** `device:{app_user_id}`에 저장한다(CONTRACT의 `license:` 레코드를 오염시키지 않기 위해 분리). 이 키 패턴은 CONTRACT §5.1에 없는 확장 키임을 코드에 명시한다.
- `assertion`은 CONTRACT §6.2가 못박은 6개 키(`app_user_id`, `state`, `license_kind`, `nonce`, `issued_at`, `expires_at`) **순서·집합 그대로** 직렬화해 서명한다. 기기 정보는 assertion에 넣지 않는다(넣으면 임베드된 앱의 검증 바이트가 깨지므로). 기기 위반은 서명 발급 자체를 막는 게이트로만 작동한다.

> 확장 한계: `max_devices` 정원은 환경변수 `env.MAX_DEVICES`(미설정 시 기본 3)로 둔다. KV는 강한 락이 아니므로(§5.1, last-write-wins·최대 1 write/sec per key) 이 기기 카운팅은 best-effort다. 정확한 동시성 보장이 필요하면 Durable Object로 이전해야 한다 — 이 코드는 그 보장을 제공하지 않는다.

### 전체 Worker 코드 (`/verify/challenge` + `/verify`)

```js
// verify.js — Cloudflare Worker: /verify/challenge + /verify (Ed25519 challenge-response).
// CONTRACT §6.2 is authoritative for request/response shapes and assertion byte order.
// Device-binding (machine_id / max_devices) is an explicit project EXTENSION layered on
// top — NOT defined by CONTRACT. It uses a separate KV key and never alters the signed
// assertion's key set/order.

// ----- KV key helpers (CONTRACT §5.1 + flagged extension) -----
const kLicense = (appUserId) => `license:${appUserId}`;     // CONTRACT §5.1
const kNonce = (appUserId) => `verify-nonce:${appUserId}`;  // EXTENSION: /verify nonce store
const kDevices = (appUserId) => `device:${appUserId}`;      // EXTENSION: device binding store

// Nonce lifetime: short, single-use (CONTRACT §6.2 "short TTL, single-use").
const NONCE_TTL_SEC = 120;          // 2 min — survives user latency, well under any replay risk
const ASSERTION_TTL_SEC = 60;       // assertion.expires_at = issued_at + 60s (freshness window)

// CONTRACT §5.4 access decision: grant if state in {active, past_due}; deny otherwise.
// Mirrors RESEARCH[lifecycle-map] (c): grant while status ∈ {trialing, active, past_due}.
// `trialing` is included because a license in trial is fully entitled (grant on created,
// read data.status). Records persisted by the webhook Worker use these same enum values.
const ENTITLED_STATES = new Set(["trialing", "active", "past_due"]);

// ----- small encoding helpers (no Node Buffer) -----
function b64urlEncode(u8) {
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64ToBytes(b64) {
  // Standard base64 (with padding) -> Uint8Array. Used for the PKCS#8 secret.
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// CONTRACT §6.3 error envelope.
function errorResponse(httpStatus, code, message) {
  return jsonResponse({ error: code, message }, httpStatus);
}

// ----- Ed25519 private key import (cached per isolate) -----
let _privateKeyPromise = null;
function getSigningKey(env) {
  // Import once per isolate; reuse across requests. importKey returns a CryptoKey
  // bound to this isolate, safe to memoize (the secret never leaves the Worker).
  if (!_privateKeyPromise) {
    const pkcs8 = b64ToBytes(env.ED25519_PRIVATE_KEY_PKCS8_B64);
    _privateKeyPromise = crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      { name: "Ed25519" },
      false,          // non-extractable
      ["sign"],
    );
  }
  return _privateKeyPromise;
}

// ----- Canonical assertion serialization (CONTRACT §6.2, BINDING) -----
// Fixed key order: app_user_id, state, license_kind, nonce, issued_at, expires_at.
// Compact JSON (no insignificant whitespace). The client reconstructs THESE bytes.
function canonicalAssertionBytes(a) {
  // Build the string by hand to guarantee key order regardless of JSON.stringify behavior.
  // (V8's JSON.stringify preserves insertion order for string keys, but we do not rely on it.)
  const json =
    "{" +
    `"app_user_id":${JSON.stringify(a.app_user_id)},` +
    `"state":${JSON.stringify(a.state)},` +
    `"license_kind":${JSON.stringify(a.license_kind)},` +
    `"nonce":${JSON.stringify(a.nonce)},` +
    `"issued_at":${JSON.stringify(a.issued_at)},` +
    `"expires_at":${JSON.stringify(a.expires_at)}` +
    "}";
  return new TextEncoder().encode(json);
}

// ----- POST /verify/challenge (CONTRACT §6.2 Step 1) -----
async function handleChallenge(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_request", "Malformed JSON body.");
  }

  const appUserId = body?.app_user_id;
  if (typeof appUserId !== "string" || appUserId.length === 0) {
    return errorResponse(400, "invalid_request", "Missing app_user_id.");
  }

  // A license record must exist to issue a challenge (otherwise no_license at /verify anyway).
  const record = await env.LICENSES.get(kLicense(appUserId), { type: "json" });
  if (!record) {
    return errorResponse(404, "no_license", "No license record for app_user_id.");
  }

  // Generate a 32-byte random nonce (CONTRACT response: "b64url-32-random-bytes").
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = b64urlEncode(nonceBytes);

  const now = Date.now();
  const expiresAt = new Date(now + NONCE_TTL_SEC * 1000).toISOString();

  // EXTENSION: bind the optional machine_id to this nonce so /verify can enforce that the
  // same device that challenged is the one verifying. Stored under verify-nonce:{app_user_id}.
  // CONTRACT keeps the nonce "keyed to app_user_id"; machine_id is additive metadata only.
  const machineId = typeof body?.machine_id === "string" ? body.machine_id : null;

  const nonceEntry = JSON.stringify({ nonce, machine_id: machineId, issued_at: now });
  // Single-use is enforced at /verify by deleting on consume. TTL bounds the lifetime.
  // KV last-write-wins: a fresh challenge overwrites any prior unconsumed nonce for this user.
  await env.LICENSES.put(kNonce(appUserId), nonceEntry, { expirationTtl: NONCE_TTL_SEC });

  return jsonResponse({ nonce, expires_at: expiresAt });
}

// ----- EXTENSION: device binding / max_devices -----
// device:{app_user_id} -> { devices: { [machine_id]: { first_seen, last_seen } } }
// Returns { ok: true } if the device is allowed, or { ok: false, code } if max_devices exceeded.
async function enforceDeviceBinding(env, appUserId, machineId) {
  if (!machineId) return { ok: true }; // no machine_id -> pure CONTRACT path, skip binding.

  // NOTE: MAX_DEVICES="0" would be coerced to the default 3 by `|| 3`. A cap of 0 is
  // nonsensical for this flow (it would lock out every device), so the fallback is intended.
  const maxDevices = Number(env.MAX_DEVICES ?? 3) || 3;
  const key = kDevices(appUserId);
  const state = (await env.LICENSES.get(key, { type: "json" })) || { devices: {} };
  const devices = state.devices || {};
  const now = new Date().toISOString();

  if (devices[machineId]) {
    // Known device: refresh last_seen, allow.
    devices[machineId].last_seen = now;
  } else {
    // New device: enforce the cap.
    if (Object.keys(devices).length >= maxDevices) {
      return { ok: false, code: "device_limit" };
    }
    devices[machineId] = { first_seen: now, last_seen: now };
  }

  // Best-effort write (KV is not a strong lock; see CONTRACT §5.1). max 1 write/sec per key.
  // No TTL: device registrations persist for the life of the license.
  await env.LICENSES.put(key, JSON.stringify({ devices }));
  return { ok: true };
}

// ----- POST /verify (CONTRACT §6.2 Step 2) -----
async function handleVerify(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_request", "Malformed JSON body.");
  }

  const appUserId = body?.app_user_id;
  const nonce = body?.nonce;
  if (typeof appUserId !== "string" || appUserId.length === 0) {
    return errorResponse(400, "invalid_request", "Missing app_user_id.");
  }
  if (typeof nonce !== "string" || nonce.length === 0) {
    return errorResponse(400, "invalid_request", "Missing nonce.");
  }

  // --- Consume the nonce (single-use). Read, validate, delete. ---
  const stored = await env.LICENSES.get(kNonce(appUserId), { type: "json" });
  if (!stored || stored.nonce !== nonce) {
    // Unknown, expired (TTL elapsed -> get returns null), or mismatched -> 409 nonce_invalid.
    return errorResponse(409, "nonce_invalid", "Nonce unknown, expired, or already used.");
  }
  // Delete immediately to enforce single-use. A replay of the same nonce now 409s.
  // NOTE: KV delete is eventually consistent across edges; at the same edge it is read-after-
  // write consistent. This is best-effort single-use, not a strong lock (CONTRACT §5.1).
  await env.LICENSES.delete(kNonce(appUserId));

  // --- EXTENSION: device binding. The verifying machine_id must match the challenge's. ---
  const machineId = typeof body?.machine_id === "string" ? body.machine_id : null;
  if (stored.machine_id || machineId) {
    if (stored.machine_id !== machineId) {
      // The device that requested the challenge is not the one verifying.
      return errorResponse(409, "nonce_invalid", "Nonce was issued to a different device.");
    }
    const bind = await enforceDeviceBinding(env, appUserId, machineId);
    if (!bind.ok) {
      // Device cap exceeded -> deny access (mapped onto CONTRACT's not_entitled class).
      return errorResponse(403, "not_entitled", "Device limit reached for this license.");
    }
  }

  // --- Load the license record and resolve state (CONTRACT §5.2 / §5.3). ---
  const record = await env.LICENSES.get(kLicense(appUserId), { type: "json" });
  if (!record) {
    return errorResponse(404, "no_license", "No license record for app_user_id.");
  }

  const state = record.state;          // CONTRACT §5.3 enum
  const licenseKind = record.license_kind;

  // Access decision (CONTRACT §5.4): deny paused/canceled/refunded.
  if (!ENTITLED_STATES.has(state)) {
    return errorResponse(403, "not_entitled", `License state '${state}' denies access.`);
  }

  // --- Build the assertion (CONTRACT §6.2). ---
  const nowMs = Date.now();
  const issuedAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + ASSERTION_TTL_SEC * 1000).toISOString();

  const assertion = {
    app_user_id: appUserId,
    state,
    license_kind: licenseKind,
    nonce,
    issued_at: issuedAt,
    expires_at: expiresAt,
  };

  // --- Sign the EXACT canonical bytes (CONTRACT §6.2 canonicalization, BINDING). ---
  const messageBytes = canonicalAssertionBytes(assertion);
  const signingKey = await getSigningKey(env);
  const sigBuf = await crypto.subtle.sign("Ed25519", signingKey, messageBytes);
  const signature = b64urlEncode(new Uint8Array(sigBuf)); // 64-byte sig -> base64url

  // Response shape per CONTRACT §6.2. The Worker MUST emit `assertion` in the same key order
  // it signed (the client re-serializes those keys in that order to verify). We return the
  // canonical JSON string directly to guarantee byte-for-byte match with what was signed.
  const assertionJson = new TextDecoder().decode(messageBytes);
  return new Response(`{"assertion":${assertionJson},"signature":${JSON.stringify(signature)}}`, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// ----- Router -----
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method !== "POST") {
      return errorResponse(405, "invalid_request", "Method Not Allowed.");
    }

    if (url.pathname === "/verify/challenge") {
      return handleChallenge(request, env);
    }
    if (url.pathname === "/verify") {
      return handleVerify(request, env);
    }

    return errorResponse(404, "invalid_request", "Unknown endpoint.");
  },
};
```

### 핵심 설계 결정 요약

- **assertion 바이트는 손으로 직렬화한다.** `canonicalAssertionBytes()`는 `JSON.stringify`의 키 순서 동작에 의존하지 않고 6개 키를 CONTRACT §6.2가 못박은 순서로 직접 붙인다. 그리고 응답 본문에 **서명한 바로 그 바이트열**(`assertionJson`)을 다시 디코드해 넣어, 클라이언트가 재구성하는 바이트와 1:1로 일치시킨다. 이것이 임베드된 공개키 `verify_strict`가 통과하기 위한 필수 조건이다.
- **entitlement는 `state`로 결정한다.** RESEARCH[lifecycle-map](c)의 매핑을 그대로 따라 `trialing`/`active`/`past_due`는 grant, `paused`/`canceled`는 deny다. `trialing`을 빠뜨리면 체험 중 사용자가 잘못 차단되므로 `ENTITLED_STATES`에 포함했다. 라이선스 레코드의 `state`는 webhook Worker가 `subscription.*` 이벤트에서 `data.status`를 기록한 값이다(트라이얼은 webhook Worker가 `active`로 정규화하므로 여기서도 일관).
- **nonce single-use**는 read → match → `delete` 순으로 강제한다. 동일 nonce 재전송은 KV `get`이 null을 반환(삭제됨 또는 TTL 만료)하므로 `409 nonce_invalid`가 된다. KV의 edge간 eventual consistency 때문에 best-effort임을 코드에 명시했다.
- **에러 코드는 CONTRACT §6.3 표를 그대로** 사용한다: `400 invalid_request`, `403 not_entitled`, `404 no_license`, `409 nonce_invalid`. 기기 한도 초과는 접근 거부 클래스이므로 `403 not_entitled`에 매핑했다(CONTRACT에 별도 `device_limit` HTTP 코드가 없으므로 신규 코드를 발명하지 않음).
- **개인키**는 `importKey("pkcs8", …)`로 isolate당 1회 임포트하고 non-extractable로 둔다. CONTRACT가 요구하는 "private key lives ONLY in the Worker"를 만족한다.

### wrangler 설정 / 시크릿

```toml
# wrangler.toml (발췌)
name = "license-worker"
main = "verify.js"
compatibility_date = "2024-09-23"   # Ed25519 in crypto.subtle 사용 가능한 날짜로 핀

[[kv_namespaces]]
binding = "LICENSES"
id = "<your-kv-namespace-id>"

[vars]
MAX_DEVICES = "3"                    # EXTENSION: 기기 정원 (미설정 시 코드 기본 3)
```

```bash
# 개인키는 vars가 아닌 secret으로 주입 (저장소·로그에 노출 금지)
wrangler secret put ED25519_PRIVATE_KEY_PKCS8_B64
# gen-keypair.mjs가 출력한 base64 PKCS#8 문자열 붙여넣기
```

> 같은 `LICENSES` KV 네임스페이스를 webhook Worker(CONTRACT §5)와 공유한다. `license:{app_user_id}` 레코드는 webhook이 쓰고 `/verify`가 읽는다. `verify-nonce:` / `device:` 키는 `/verify`만 쓰는 확장 키다.

### 잠재적 이슈 / 검증 권고 (구현 후 리뷰)

- **Ed25519 런타임 가용성**: 배포 환경에서 `crypto.subtle`가 `"Ed25519"`를 거부하면 서명이 throw한다. `wrangler dev`에서 키 임포트·서명을 1회 실행해 확인하라. 거부 시 서명 함수만 `@noble/ed25519`로 교체(와이어 포맷 동일).
- **KV 1 write/sec per key 한도**: 같은 `app_user_id`가 1초에 여러 번 `/verify/challenge`를 치면 nonce 키 쓰기가 `429`로 막힐 수 있다. 필요 시 `/verify/challenge`에 레이트 가드를 추가하고 CONTRACT §6.3의 `429 rate_limited`를 반환하라(현재 코드는 이 가드 미포함 — 의도적 단순화).
- **기기 카운팅 동시성**: `enforceDeviceBinding`의 read-modify-write는 KV last-write-wins라 동시 다발 신규 기기 등록 시 정원을 초과 통과시킬 수 있다. 엄격한 보장이 필요하면 Durable Object로 이전.
- **assertion 바이트 정렬 회귀**: 클라이언트(Rust) 측 재직렬화가 같은 6키 순서·compact JSON을 만드는지 통합 테스트로 고정하라. 이 합의가 깨지면 모든 `/verify`가 클라이언트에서 서명 실패한다.
- **제안 테스트**: (1) 정상 active → 서명·클라이언트 `verify_strict` 통과, (2) 재사용 nonce → 409, (3) 만료 nonce(TTL 경과) → 409, (4) `state=paused` → 403, (5) 레코드 없음 → 404, (6) `machine_id` 정원 초과 → 403, (7) challenge와 다른 `machine_id`로 verify → 409, (8) assertion JSON 바이트가 서명 메시지와 정확히 일치하는지 바이트 비교, (9) `state=trialing` → 200(grant).

---

## Tauri v2 (Rust) — 체크아웃 열기 + 라이선스 검증 + 캐시

이 섹션은 데스크톱 앱(Tauri v2, Rust)이 담당하는 클라이언트 측 전부를 다룬다. Worker가 `/checkout/session`으로 내려준 `client_token`·`environment`·`price_id`·`custom_data`로 시스템 브라우저에서 Paddle 체크아웃을 열고, 결제 후 결과를 받아와(deep link fast-path 또는 polling), `reqwest`로 `/verify` 챌린지-리스폰스를 수행하고, `ed25519-dalek` v2 `verify_strict`로 서명·nonce·`app_user_id`·`issued_at`/`expires_at`를 검증한 뒤, 서명된 assertion을 `keyring`에 암호화 저장해 오프라인 유예(grace)를 제공한다.

핵심 신뢰 경계: **로컬에 캐시된 어떤 값도 신뢰하지 않는다.** 캐시는 편의일 뿐이고, 매번 로드할 때마다 `verify_strict` + nonce + freshness를 다시 돌린다. private 서명 키는 Worker에만 있고, 앱은 32바이트 public 키만 embed한다.

### Cargo 의존성

연구에서 crates.io로 검증된 버전(2026-06-23 기준)을 그대로 핀한다.

```toml
# src-tauri/Cargo.toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-opener = "2.5.4"            # open checkout URL in system browser (v2 successor to core shell API)
tauri-plugin-deep-link = "2.4.9"        # OPTIONAL fast-path callback (myapp://...)
tauri-plugin-single-instance = { version = "2", features = ["deep-link"] } # required on Win/Linux for deep-link delivery

reqwest = { version = "0.13", features = ["json"] }  # async HTTPS JSON; rustls/native-tls default per platform
serde = { version = "1", features = ["derive"] }
serde_json = "1"

ed25519-dalek = "2"   # v2: VerifyingKey + Signature::from_bytes(&[u8;64]) infallible + verify_strict
base64 = "0.22"       # decode b64url signature / nonce wire values
keyring = "4.1.2"     # OS-native secure storage (Keychain / Credential Manager / Secret Service)

time = { version = "0.3", features = ["parsing"] }   # RFC3339 parsing for issued_at/expires_at — std cannot parse RFC3339
tokio = { version = "1", features = ["time", "macros"] }
thiserror = "2"
```

> 주의 — `reqwest` 0.13의 기본 TLS 백엔드(rustls vs native-tls) 세부는 연구에서 재검증되지 않았다. TLS 백엔드를 고정해야 하면 `rustls-tls` 또는 `native-tls` feature를 명시적으로 핀하라(여기서는 기본값에 의존).

### 임베드된 public 키와 wire DTO

```rust
// src-tauri/src/license/types.rs
use serde::{Deserialize, Serialize};

/// Worker's Ed25519 public verifying key, 32 bytes, embedded at build time.
/// Replace with the real key. The matching private key lives ONLY in the Worker.
pub const WORKER_PUBKEY: [u8; 32] = [
    0x3d, 0x40, 0x17, 0xc3, 0xe8, 0x43, 0x89, 0x5a,
    0x92, 0x8b, 0x75, 0xb6, 0x14, 0x7b, 0xca, 0x67,
    0x10, 0x65, 0xab, 0xe4, 0x57, 0x86, 0xa2, 0x4f,
    0x1d, 0x5b, 0xa8, 0x83, 0x95, 0xfa, 0x21, 0xde,
]; // EXAMPLE bytes — substitute the Worker's actual 32-byte public key.

/// Base URL of the Cloudflare Worker (not Paddle). Switch sandbox/live as needed.
pub const WORKER_BASE_URL: &str = "https://worker.example.com";

// --- POST /checkout/session ---

#[derive(Serialize)]
pub struct CheckoutSessionRequest {
    pub app_user_id: String,
    pub license_kind: String, // "perpetual" | "subscription"
    pub price_id: String,
}

/// custom_data echoed verbatim from the Worker. The app MUST NOT fabricate it.
#[derive(Deserialize, Serialize, Clone)]
pub struct CustomData {
    pub app_user_id: String,
    pub order_id: String,
    pub license_kind: String,
    pub schema: u32,
}

#[derive(Deserialize)]
pub struct CheckoutSessionResponse {
    pub order_id: String,
    pub client_token: String,        // "test_..." | "live_..."
    pub environment: String,         // "sandbox" | "production"
    pub price_id: String,
    pub custom_data: CustomData,
}

// --- POST /verify/challenge ---

#[derive(Serialize)]
pub struct ChallengeRequest {
    pub app_user_id: String,
}

#[derive(Deserialize)]
pub struct ChallengeResponse {
    pub nonce: String,        // b64url 32 random bytes
    pub expires_at: String,   // RFC3339
}

// --- POST /verify ---

#[derive(Serialize)]
pub struct VerifyRequest {
    pub app_user_id: String,
    pub nonce: String,
}

/// The signed assertion. Field order here is the canonicalization order the
/// contract fixes: app_user_id, state, license_kind, nonce, issued_at, expires_at.
/// Do NOT reorder — the signature is over the exact compact-JSON bytes in this order.
///
/// SECURITY (see verify.rs note): re-serializing this parsed struct to reproduce
/// the signed bytes is only safe when the Worker emits byte-identical compact JSON
/// (same key order, same Unicode-escaping rules). Re-serialization is the fragile
/// path; the robust contract is for the Worker to return the canonical assertion
/// STRING and for the client to verify over that exact string before parsing.
#[derive(Deserialize, Serialize, Clone)]
pub struct Assertion {
    pub app_user_id: String,
    pub state: String,        // active | past_due | paused | canceled | refunded
    pub license_kind: String, // perpetual | subscription
    pub nonce: String,
    pub issued_at: String,    // RFC3339
    pub expires_at: String,   // RFC3339
}

#[derive(Deserialize)]
pub struct VerifyResponse {
    pub assertion: Assertion,
    pub signature: String,    // b64url ed25519 64 bytes
}

/// Uniform Worker error envelope (Section 6.3).
#[derive(Deserialize)]
pub struct ApiError {
    pub error: String,
    pub message: String,
}
```

### 에러 타입

```rust
// src-tauri/src/license/error.rs
use thiserror::Error;

#[derive(Debug, Error)]
pub enum LicenseError {
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),

    /// Worker returned a non-200 with the uniform error envelope.
    #[error("worker error [{status}] {code}: {message}")]
    Worker { status: u16, code: String, message: String },

    #[error("signature verification failed")]
    BadSignature,

    #[error("nonce mismatch: expected the nonce we sent")]
    NonceMismatch,

    #[error("assertion expired or not yet valid")]
    Freshness,

    #[error("assertion app_user_id does not match the local user")]
    UserMismatch,

    /// state resolved to paused/canceled/refunded.
    #[error("not entitled: state={0}")]
    NotEntitled(String),

    #[error("base64 decode: {0}")]
    Base64(#[from] base64::DecodeError),

    #[error("signature must be exactly 64 bytes, got {0}")]
    SignatureLength(usize),

    #[error("canonicalization failed: {0}")]
    Canonical(String),

    #[error("keyring: {0}")]
    Keyring(#[from] keyring::Error),

    #[error("time parse: {0}")]
    Time(String),

    #[error("no cached assertion")]
    NoCache,
}
```

### Assertion 정규화(canonicalization)와 Ed25519 검증

계약상 서명 메시지는 `assertion`을 키 순서 `app_user_id, state, license_kind, nonce, issued_at, expires_at`로 **compact JSON(불필요한 공백 없음)** 직렬화한 UTF-8 바이트다. `serde_json::to_vec`는 struct 필드 정의 순서를 그대로 유지하고 공백 없이 직렬화하므로, 위 `Assertion` struct의 필드 순서가 곧 정규화 순서가 된다. 다른 순서로 재직렬화하면 검증이 깨지므로 절대 재정렬하지 않는다.

> **[보안 — 정규화 발산 위험, 반드시 확인]** 이 클라이언트는 파싱된 struct를 **재직렬화**해서 Worker가 서명한 바이트를 재현한다. 이 방식은 Worker와 클라이언트가 **바이트 단위로 동일한** compact JSON을 내놓을 때만 안전하다. JSON 인코더마다 (1) 키 순서, (2) 비-ASCII/제어문자의 escape 규칙(예: JS `JSON.stringify` vs Rust `serde_json`), (3) 정수/문자열 표기가 달라질 수 있고, 이 중 하나라도 어긋나면 **정당한 서명이 거부**된다(false reject). 반대로 escape 정규화가 느슨하면 서로 다른 입력이 같은 바이트로 접히는 **canonicalization 충돌** 위험도 있다. 견고한 계약은 **Worker가 정규 assertion 문자열을 그대로 내려주고, 클라이언트는 그 문자열 바이트 위에서 서명을 검증한 뒤 파싱**하는 것이다(파싱된 struct를 재직렬화하지 않는다). 아래 코드는 계약이 "이 순서의 compact JSON"을 **양측에서 동일하게** 고정한다는 가정에 의존하므로, 채택 전 Worker 서명 입력 바이트와 `serde_json::to_vec` 출력 바이트가 비-ASCII `app_user_id`를 포함해 일치하는지 골든 벡터로 검증하라.

```rust
// src-tauri/src/license/verify.rs
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signature, VerifyingKey};

use super::error::LicenseError;
use super::types::{Assertion, WORKER_PUBKEY};

/// Produce the exact canonical bytes the Worker signed.
/// serde_json serializes struct fields in declaration order with no insignificant
/// whitespace, which matches the contract's fixed key order verbatim — PROVIDED the
/// Worker emits byte-identical compact JSON (see the security note above). Verify
/// this with a golden vector (including non-ASCII app_user_id) before shipping.
pub fn canonical_assertion_bytes(a: &Assertion) -> Result<Vec<u8>, LicenseError> {
    serde_json::to_vec(a).map_err(|e| LicenseError::Canonical(e.to_string()))
}

/// Decode a b64url (no padding) signature into a fixed 64-byte array.
fn decode_sig_64(b64url: &str) -> Result<[u8; 64], LicenseError> {
    let raw = URL_SAFE_NO_PAD.decode(b64url)?;
    let len = raw.len();
    let arr: [u8; 64] = raw
        .try_into()
        .map_err(|_| LicenseError::SignatureLength(len))?;
    Ok(arr)
}

/// Verify the Ed25519 signature over the canonical assertion bytes using the
/// embedded public key. verify_strict rejects weak / small-order keys.
pub fn verify_signature(assertion: &Assertion, signature_b64url: &str) -> Result<(), LicenseError> {
    let vk = VerifyingKey::from_bytes(&WORKER_PUBKEY) // fallible in v2
        .map_err(|_| LicenseError::BadSignature)?;
    let sig_bytes = decode_sig_64(signature_b64url)?;
    let sig = Signature::from_bytes(&sig_bytes); // infallible in v2 (&[u8; 64])

    let msg = canonical_assertion_bytes(assertion)?;
    vk.verify_strict(&msg, &sig)
        .map_err(|_| LicenseError::BadSignature)
}
```

### 수락 규칙(Section 6.2의 5개 조건 전부)

서명 검증 → nonce 일치 → freshness → user 일치 → state 평가. 5개 모두 통과해야 entitled. RFC3339 비교는 `time` 크레이트로 처리한다(표준 라이브러리만으로는 RFC3339를 파싱하지 못한다).

```rust
// src-tauri/src/license/verify.rs (continued)
use super::types::VerifyResponse;

/// RFC3339 -> Unix seconds. The contract uses RFC3339 strings; std cannot parse
/// RFC3339, so we use `time::OffsetDateTime::parse` with the Rfc3339 format.
/// Requires `time = { version = "0.3", features = ["parsing"] }`.
fn rfc3339_to_unix(s: &str) -> Result<i64, LicenseError> {
    use time::format_description::well_known::Rfc3339;
    use time::OffsetDateTime;
    OffsetDateTime::parse(s, &Rfc3339)
        .map(|dt| dt.unix_timestamp())
        .map_err(|e| LicenseError::Time(e.to_string()))
}

fn now_unix() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Apply ALL acceptance rules from Section 6.2. Returns Ok(true) if entitled,
/// Ok(false) if validly signed/fresh/matched but the state denies access.
/// Returns Err for any cryptographic, nonce, freshness, or identity failure.
pub fn accept_assertion(
    resp: &VerifyResponse,
    sent_nonce: &str,
    expected_app_user_id: &str,
) -> Result<bool, LicenseError> {
    // Rule 1: signature verifies via verify_strict.
    verify_signature(&resp.assertion, &resp.signature)?;

    // Rule 2: nonce equals what we sent in this exchange (anti-replay).
    if resp.assertion.nonce != sent_nonce {
        return Err(LicenseError::NonceMismatch);
    }

    // Rule 3: issued_at <= now < expires_at (freshness; reject future-dated and expired).
    let now = now_unix();
    let issued = rfc3339_to_unix(&resp.assertion.issued_at)?;
    let exp = rfc3339_to_unix(&resp.assertion.expires_at)?;
    if now < issued || now >= exp {
        return Err(LicenseError::Freshness);
    }

    // Rule 4: app_user_id matches the local user.
    if resp.assertion.app_user_id != expected_app_user_id {
        return Err(LicenseError::UserMismatch);
    }

    // Rule 5: state in {active, past_due} -> entitled; otherwise not.
    let entitled = matches!(resp.assertion.state.as_str(), "active" | "past_due");
    Ok(entitled)
}
```

### Worker 클라이언트: `/checkout/session`, `/verify/challenge`, `/verify`

`reqwest::Client` 하나를 재사용한다. 비-200 응답은 계약의 uniform error envelope(Section 6.3)로 디코드해 `LicenseError::Worker`로 매핑한다.

```rust
// src-tauri/src/license/client.rs
use reqwest::Client;

use super::error::LicenseError;
use super::types::*;

pub struct WorkerClient {
    http: Client,
    base: String,
}

impl WorkerClient {
    pub fn new() -> Result<Self, LicenseError> {
        Ok(Self {
            http: Client::builder().build()?, // default TLS per platform
            base: WORKER_BASE_URL.to_string(),
        })
    }

    /// Decode a non-2xx response into the uniform error envelope.
    async fn into_worker_err(resp: reqwest::Response) -> LicenseError {
        let status = resp.status().as_u16();
        match resp.json::<ApiError>().await {
            Ok(e) => LicenseError::Worker { status, code: e.error, message: e.message },
            Err(_) => LicenseError::Worker {
                status,
                code: "unknown".into(),
                message: "non-JSON error body".into(),
            },
        }
    }

    /// POST /checkout/session — get Worker-issued order_id + client_token + custom_data.
    pub async fn create_checkout_session(
        &self,
        app_user_id: &str,
        license_kind: &str,
        price_id: &str,
    ) -> Result<CheckoutSessionResponse, LicenseError> {
        let body = CheckoutSessionRequest {
            app_user_id: app_user_id.to_string(),
            license_kind: license_kind.to_string(),
            price_id: price_id.to_string(),
        };
        let resp = self
            .http
            .post(format!("{}/checkout/session", self.base))
            .json(&body)
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(Self::into_worker_err(resp).await);
        }
        Ok(resp.json::<CheckoutSessionResponse>().await?)
    }

    /// POST /verify/challenge — get a single-use server nonce.
    pub async fn request_challenge(&self, app_user_id: &str) -> Result<ChallengeResponse, LicenseError> {
        let resp = self
            .http
            .post(format!("{}/verify/challenge", self.base))
            .json(&ChallengeRequest { app_user_id: app_user_id.to_string() })
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(Self::into_worker_err(resp).await);
        }
        Ok(resp.json::<ChallengeResponse>().await?)
    }

    /// POST /verify — echo the nonce, receive the signed assertion.
    pub async fn verify(&self, app_user_id: &str, nonce: &str) -> Result<VerifyResponse, LicenseError> {
        let resp = self
            .http
            .post(format!("{}/verify", self.base))
            .json(&VerifyRequest {
                app_user_id: app_user_id.to_string(),
                nonce: nonce.to_string(),
            })
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(Self::into_worker_err(resp).await);
        }
        Ok(resp.json::<VerifyResponse>().await?)
    }
}
```

### 전체 verify 플로우 (챌린지 → verify → 수락 → 캐시)

`/verify/challenge`로 nonce를 받고, 그 nonce를 echo해 `/verify`를 호출하고, 받은 nonce를 기준으로 수락 규칙을 적용한 뒤, 통과하면 서명된 assertion을 캐시한다. nonce는 우리가 보낸 값을 그대로 anti-replay 기준으로 쓴다 — Worker가 돌려준 assertion의 nonce가 우리가 보낸 nonce와 같아야 한다.

```rust
// src-tauri/src/license/flow.rs
use super::cache::AssertionCache;
use super::client::WorkerClient;
use super::error::LicenseError;
use super::verify::accept_assertion;

pub struct VerifyOutcome {
    pub entitled: bool,
    pub state: String,
}

/// Online verification: challenge -> verify -> accept (all 5 rules) -> cache.
pub async fn verify_online(
    client: &WorkerClient,
    cache: &AssertionCache,
    app_user_id: &str,
) -> Result<VerifyOutcome, LicenseError> {
    // Step 1: get a fresh single-use nonce from the Worker.
    let challenge = client.request_challenge(app_user_id).await?;
    let sent_nonce = challenge.nonce;

    // Step 2: ask the Worker to sign an assertion over that nonce.
    let resp = client.verify(app_user_id, &sent_nonce).await?;

    // Apply all acceptance rules against the nonce WE sent and OUR user id.
    let entitled = accept_assertion(&resp, &sent_nonce, app_user_id)?;
    let state = resp.assertion.state.clone();

    // Cache the signed assertion + signature for offline grace. Storage is a
    // convenience, not the trust anchor: every load re-runs verify_strict.
    cache.store(app_user_id, &resp)?;

    Ok(VerifyOutcome { entitled, state })
}
```

### 암호화 캐시 + 오프라인 유예

서명된 assertion과 signature를 `keyring`(OS 네이티브 보안 저장소)에 JSON으로 저장한다. 오프라인에서 로드할 때도 **반드시** `verify_strict` + freshness를 다시 돌린다 — 다만 오프라인에서는 새 nonce를 받을 수 없으므로 nonce 일치 검사는 적용할 수 없다. 따라서 오프라인 경로의 신뢰는 (a) 서명, (b) `app_user_id` 일치, (c) `issued_at` 기반 유예 윈도우에 의존한다.

`expires_at`은 분 단위로 짧다(계약 예시 60초). 오프라인 유예를 원한다면 `issued_at` + 정책적 grace 윈도우를 별도로 적용한다. 즉 `expires_at`을 넘겼더라도 `issued_at + GRACE_SECONDS` 이내면 "오프라인 유예"로 접근을 허용하되, 온라인 복구 시 즉시 재검증한다.

```rust
// src-tauri/src/license/cache.rs
use keyring::Entry;

use super::error::LicenseError;
use super::types::{Assertion, VerifyResponse};
use super::verify::{verify_signature};

const SERVICE: &str = "com.example.myapp.license";

/// Offline grace: how long after issued_at we keep honoring a cached, validly
/// signed assertion when the Worker is unreachable. Project policy, not Paddle.
const OFFLINE_GRACE_SECONDS: i64 = 7 * 24 * 60 * 60; // 7 days

/// What we persist: the signed assertion + its signature, exactly as received.
#[derive(serde::Serialize, serde::Deserialize)]
struct CachedAssertion {
    assertion: Assertion,
    signature: String, // b64url, same bytes the Worker sent
}

pub struct AssertionCache;

impl AssertionCache {
    pub fn new() -> Self {
        Self
    }

    fn entry(&self, app_user_id: &str) -> Result<Entry, LicenseError> {
        // keyring v4: keyed by service + username (here the app user id).
        Ok(Entry::new(SERVICE, app_user_id)?)
    }

    /// Persist the freshly verified assertion to OS-native secure storage.
    pub fn store(&self, app_user_id: &str, resp: &VerifyResponse) -> Result<(), LicenseError> {
        let cached = CachedAssertion {
            assertion: resp.assertion.clone(),
            signature: resp.signature.clone(),
        };
        let json = serde_json::to_string(&cached)
            .map_err(|e| LicenseError::Canonical(e.to_string()))?;
        self.entry(app_user_id)?.set_password(&json)?;
        Ok(())
    }

    /// Load + RE-VERIFY the cached assertion for offline grace.
    ///
    /// Re-runs verify_strict (integrity), app_user_id match (identity), and an
    /// offline grace-window freshness check based on issued_at. The nonce check
    /// from the online path is intentionally NOT applied here: offline we cannot
    /// obtain a fresh server nonce, so anti-replay reduces to the signed
    /// expires_at + the issued_at grace window. Returns Ok(true) if the cached
    /// entitlement may still be honored offline.
    pub fn load_offline(&self, app_user_id: &str) -> Result<bool, LicenseError> {
        let json = match self.entry(app_user_id)?.get_password() {
            Ok(s) => s,
            Err(keyring::Error::NoEntry) => return Err(LicenseError::NoCache),
            Err(e) => return Err(LicenseError::Keyring(e)),
        };
        let cached: CachedAssertion =
            serde_json::from_str(&json).map_err(|e| LicenseError::Canonical(e.to_string()))?;

        // Integrity: signature must still verify. Tampering is caught here,
        // which is why plaintext-equivalent storage would still be safe — keyring
        // adds confidentiality on top, not the trust anchor.
        verify_signature(&cached.assertion, &cached.signature)?;

        // Identity: must be this user.
        if cached.assertion.app_user_id != app_user_id {
            return Err(LicenseError::UserMismatch);
        }

        // Offline grace freshness: honor only within [issued_at, issued_at + GRACE].
        // Reject future-dated (clock skew / tampered issued_at) and past-grace caches.
        let issued = rfc3339_to_unix(&cached.assertion.issued_at)?;
        let now = now_unix();
        if now < issued || now > issued + OFFLINE_GRACE_SECONDS {
            return Err(LicenseError::Freshness);
        }

        // State gate, identical to online Rule 5.
        let entitled = matches!(cached.assertion.state.as_str(), "active" | "past_due");
        Ok(entitled)
    }

    pub fn clear(&self, app_user_id: &str) -> Result<(), LicenseError> {
        match self.entry(app_user_id)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(LicenseError::Keyring(e)),
        }
    }
}

// Time helpers, module-local to cache.rs (verify.rs keeps its own private copies;
// these are NOT shared across modules — each module defines its own).
fn now_unix() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn rfc3339_to_unix(s: &str) -> Result<i64, LicenseError> {
    use time::format_description::well_known::Rfc3339;
    use time::OffsetDateTime;
    OffsetDateTime::parse(s, &Rfc3339)
        .map(|dt| dt.unix_timestamp())
        .map_err(|e| LicenseError::Time(e.to_string()))
}
```

> 진입점 정책: 앱 시작 시 먼저 `verify_online`을 시도하고, 네트워크 실패 시에만 `load_offline`으로 폴백한다. 온라인이 복구되면 즉시 `verify_online`을 다시 돌려 캐시를 갱신한다. 오프라인 grace는 Worker 미도달 상황의 임시 허용일 뿐, 영구 우회 경로가 아니다.

### 체크아웃 열기 + 결과 수신 (Tauri commands)

체크아웃 URL은 `tauri-plugin-opener`로 시스템 브라우저에서 연다. 계약상 앱은 `order_id`·`custom_data`를 절대 생성하지 않고 Worker가 내려준 값을 verbatim으로 쓴다. Paddle.js 오버레이를 띄우는 호스팅 페이지로 `client_token`·`environment`·`price_id`·`custom_data`를 query/fragment로 전달한다(아래는 Worker가 제공하는 호스팅 체크아웃 페이지 URL을 가정).

```rust
// src-tauri/src/commands.rs
use tauri::State;
use tauri_plugin_opener::OpenerExt;

use crate::license::client::WorkerClient;
use crate::license::cache::AssertionCache;
use crate::license::flow::verify_online;
use crate::license::types::WORKER_BASE_URL;

/// Shared app state holding the Worker client + cache.
pub struct LicenseState {
    pub client: WorkerClient,
    pub cache: AssertionCache,
}

/// Open Paddle checkout in the system browser.
/// 1) Ask the Worker for a session (it issues order_id + custom_data).
/// 2) Open a Worker-hosted checkout page that runs Paddle.js with those values.
///    The app passes Worker-issued values verbatim — it never fabricates them.
#[tauri::command]
pub async fn open_checkout(
    app: tauri::AppHandle,
    state: State<'_, LicenseState>,
    app_user_id: String,
    license_kind: String,
    price_id: String,
) -> Result<String, String> {
    let session = state
        .client
        .create_checkout_session(&app_user_id, &license_kind, &price_id)
        .await
        .map_err(|e| e.to_string())?;

    // The Worker-hosted page reads these query params and calls Paddle.Checkout.open()
    // with environment / token / priceId / customData EXACTLY as issued.
    // custom_data is round-tripped via order_id; the page fetches the rest itself,
    // so we only need to hand it the order_id + token + environment to bootstrap.
    let url = format!(
        "{base}/checkout?order_id={order}&token={token}&env={env}&price_id={price}",
        base = WORKER_BASE_URL,
        order = urlencoding(&session.order_id),
        token = urlencoding(&session.client_token),
        env = urlencoding(&session.environment),
        price = urlencoding(&session.price_id),
    );

    // Open in the system browser. Requires capabilities:
    //   "opener:allow-open-url", "opener:allow-default-urls"
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())?;

    // Return order_id so the frontend can start polling (see below).
    Ok(session.order_id)
}

/// Run the full online challenge-response verification and report entitlement.
#[tauri::command]
pub async fn verify_license(
    state: State<'_, LicenseState>,
    app_user_id: String,
) -> Result<bool, String> {
    match verify_online(&state.client, &state.cache, &app_user_id).await {
        Ok(outcome) => Ok(outcome.entitled),
        // Network failure -> fall back to offline grace.
        Err(_) => state.cache.load_offline(&app_user_id).map_err(|e| e.to_string()),
    }
}

/// Minimal percent-encoder for query values (avoids pulling a URL crate just for this).
fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}
```

### 결과 수신: deep link fast-path vs polling (트레이드오프)

결제 완료 후 결과를 앱으로 되돌리는 두 경로 모두 구현하되, polling을 기본값으로 두고 deep link를 저지연 fast-path로 덧붙인다. **어느 경로든 토큰/결과를 도착 즉시 신뢰하지 않는다** — deep link payload는 spoofable하므로, 두 경로 모두 최종적으로 `verify_online`(Ed25519 챌린지-리스폰스)을 통과해야 한다.

| 경로 | 장점 | 단점 / 제약 |
|---|---|---|
| **Deep link** (`tauri-plugin-deep-link`) | 즉시·이벤트 기반, 서버 폴링 부하 없음 | OS scheme 등록이 fragile(dev vs installed). Linux/Windows는 새 프로세스로 도착 → `tauri-plugin-single-instance`(deep-link feature)를 **가장 먼저** 등록해야 running instance가 받음. 런타임 `register()`는 Linux/Windows만; macOS/iOS/Android는 `UnsupportedPlatform`(scheme를 번들에 baked해야 하고 `/Applications`의 설치본에서만 발화). payload는 spoofable — 반드시 서명 검증 |
| **Polling** (`/verify` 반복) | OS scheme 설정 불필요, 전 플랫폼·dev 동일 동작, 브라우저 리다이렉트 quirk에 견고 | poll 간격만큼 지연, backoff·timeout 필요, 요청 루프 유지 |

> 트레이드오프 narrative는 연구의 종합 분석이며 단일 문서 인용은 아니다(연구에서 명시적으로 flag됨). 권장: polling을 robust 기본값으로, deep link를 UX 저지연 업그레이드로 병행. 많은 앱이 둘 다 쓴다 — deep link fast-path + polling fallback.

**Deep link fast-path 등록** (Linux/Windows에서 single-instance를 첫 번째 플러그인으로):

```rust
// src-tauri/src/lib.rs
use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;

use crate::license::{cache::AssertionCache, client::WorkerClient};
use crate::commands::{open_checkout, verify_license, LicenseState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance MUST be registered FIRST so a second launch (which is how
        // Linux/Windows deliver a deep link) is funneled into the already-running
        // instance instead of spawning a copy. With the single-instance "deep-link"
        // feature enabled (see Cargo.toml), the deep-link plugin auto-forwards the
        // URL from the new-process argv to on_open_url below — this closure does NOT
        // need to parse the URL itself; it only refocuses the existing window.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = app.get_webview_window("main").map(|w| w.set_focus());
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let client = WorkerClient::new().expect("worker client");
            app.manage(LicenseState {
                client,
                cache: AssertionCache::new(),
            });

            // Fast-path: when the checkout success page redirects to
            // myapp://license/callback?order_id=..., re-run verification.
            // We do NOT trust the URL payload — arrival merely triggers verify.
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    if url.scheme() == "myapp" {
                        // Extract app_user_id from app state / URL, then verify.
                        // The verify call is the authority, not the deep link.
                        let _ = &handle;
                        // spawn: state.client.verify_online(...) -> update UI
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_checkout,
            verify_license
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

deep-link scheme은 `tauri.conf.json`에 정적으로 선언한다:

```json
{ "plugins": { "deep-link": { "desktop": { "schemes": ["myapp"] } } } }
```

**Polling fallback** — `open_checkout`이 돌려준 `order_id` 기준으로 `verify_online`을 backoff로 반복하다 entitled가 되거나 timeout이면 멈춘다. polling 자체가 `/verify` 챌린지-리스폰스를 돌리므로 별도 status 엔드포인트의 미서명 값을 신뢰하지 않는다.

```rust
// src-tauri/src/commands.rs (continued)
use std::time::Duration;

/// Poll the verify flow until entitled or timeout. Each poll is a full signed
/// challenge-response, so the result is never trusted from an unsigned source.
#[tauri::command]
pub async fn poll_until_entitled(
    state: State<'_, LicenseState>,
    app_user_id: String,
    max_attempts: u32,
) -> Result<bool, String> {
    let mut delay = Duration::from_secs(2);
    let max_delay = Duration::from_secs(15);

    for _ in 0..max_attempts {
        match verify_online(&state.client, &state.cache, &app_user_id).await {
            Ok(o) if o.entitled => return Ok(true),
            // not-yet-entitled or transient error -> wait and retry with backoff
            _ => {
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(max_delay);
            }
        }
    }
    Ok(false)
}
```

### Capabilities

`opener` 사용에는 capability 파일에 다음 권한이 필요하다:

```json
{
  "identifier": "license-checkout",
  "windows": ["main"],
  "permissions": [
    "opener:allow-open-url",
    "opener:allow-default-urls"
  ]
}
```

### 검증되지 않은/주의 항목 (inline)

- **정규화 발산이 이 섹션 최대 위험이다.** 파싱된 `Assertion` struct를 `serde_json::to_vec`로 재직렬화해 서명 메시지를 재현하는 방식은 Worker와 클라이언트가 바이트 단위로 동일한 compact JSON을 내야만 성립한다. 비-ASCII `app_user_id`/`state`의 escape 차이, 키 순서 차이로 정당한 서명이 거부될 수 있다. 견고한 설계는 Worker가 **정규 assertion 문자열을 그대로 내려주고 클라이언트가 그 문자열 위에서 서명을 검증**하는 것이다. 현 구조 채택 전 골든 벡터(비-ASCII 포함)로 양측 바이트 일치를 반드시 검증하라.
- `reqwest` 0.13의 기본 TLS 백엔드(rustls vs native-tls) 세부는 재검증되지 않았다. 고정이 필요하면 feature를 명시하라.
- `keyring` v4의 정확한 API 표면(`Entry::new(service, user)`, `set_password`/`get_password`/`delete_credential`)은 4.x 계열 기준으로 작성했다. 채택 전 핀한 버전의 docs.rs로 메서드명을 확인하라(특히 `delete_credential` vs 구버전 `delete_password`).
- RFC3339 파싱을 위해 `time = { version = "0.3", features = ["parsing"] }`가 필요하다(위 Cargo 목록에 포함됨). 표준 라이브러리만으로는 RFC3339를 파싱하지 못한다. `verify.rs`와 `cache.rs`는 각자 자기 모듈-로컬 `now_unix`/`rfc3339_to_unix`를 정의한다(공유가 아니라 모듈별 중복 정의 — 컴파일은 문제없다).
- deep link callback 핸들러에서 `app_user_id` 추출 방식은 앱 상태 설계에 따라 달라진다 — 위 코드는 trigger 지점만 보이고, 실제 추출은 앱의 사용자 세션 저장 방식에 맞춰 채운다. 핵심 불변식은 "deep link는 트리거일 뿐, 권위는 `verify_online`"이다. Linux/Windows에서는 single-instance의 `deep-link` feature가 켜져 있어야 새 프로세스 argv의 URL이 `on_open_url`로 전달된다(위 single-instance 클로저는 URL을 직접 파싱하지 않고 창 포커스만 담당).
- Worker-hosted `/checkout` 페이지가 `order_id`로 나머지 세션 데이터(`custom_data` 포함)를 되조회한다고 가정했다. 만약 Worker가 페이지에 직접 모든 값을 내려주는 설계라면 query 파라미터 집합을 그에 맞춰 조정하되, 앱은 여전히 Worker가 발급한 값만 verbatim으로 전달한다.

---

## 키 생성 · 샌드박스 테스트 · 배포 체크리스트

이 절은 시스템을 처음 세우거나 운영에 올릴 때 필요한 실행 절차를 다룬다. (1) Worker가 `/verify` 어서션에 서명할 Ed25519 키쌍 생성, (2) `wrangler`로 시크릿·KV를 주입하는 명령, (3) Paddle **샌드박스**에서 웹훅·결제를 E2E로 검증하는 절차, (4) 운영 배포 전 마지막 체크리스트(시크릿 관리, 코드서명/notarization, 인증서 핀닝)를 순서대로 정리한다.

핵심 신뢰 경계는 단 하나다. **Ed25519 개인키는 오직 Worker에만 존재**하고, 앱에는 32바이트 공개키만 임베드된다. 아래 모든 절차는 이 경계를 깨지 않도록 설계되어 있다.

> 참고: 위 `/verify` Worker 섹션은 개인키를 PKCS#8 base64(`ED25519_PRIVATE_KEY_PKCS8_B64`)로 import하는 경로를 보였다. 아래 키 생성 절차는 동일 키쌍을 **raw 32바이트 seed** 형식으로도 출력한다(둘 다 동일 Ed25519 키쌍이다). 어느 시크릿 포맷을 채택하든 Worker의 `importKey` 호출과 짝을 맞추면 된다 — 한 환경에서 두 포맷을 혼용하지 말고 하나로 통일하라.

### 1. Ed25519 키쌍 생성

`/verify` 어서션 서명에 쓰는 Ed25519 키쌍을 생성한다. 출력은 두 가지다.

- **개인키 32바이트** (seed) → Worker 시크릿으로만 주입. 절대 저장소·앱에 넣지 않는다.
- **공개키 32바이트** → 앱 소스에 `[u8; 32]` 상수로 임베드 (`VerifyingKey::from_bytes` 입력, 계약 §6.2).

Web Crypto와 Rust(`ed25519-dalek` v2, 검증 버전 2.2.0)가 모두 다루기 쉬운 **raw 32바이트 seed** 형식을 1차 진실로 삼는다. 아래 스크립트는 Node 18+의 내장 Web Crypto만 사용하므로 추가 의존성이 없다.

```bash
#!/usr/bin/env bash
# gen-ed25519.sh — generate an Ed25519 keypair for the /verify signing path.
# Output:
#   - private key: 32-byte raw seed, base64 (Worker secret only)
#   - public key:  32-byte raw, both hex (for Rust [u8;32]) and base64
# Requires: Node 18+ (built-in WebCrypto + node:crypto JWK export).
set -euo pipefail

node - <<'NODE'
const { webcrypto } = require("node:crypto");
const { subtle } = webcrypto;

(async () => {
  // Ed25519 is supported by Node's WebCrypto for key generation + JWK export.
  const kp = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);

  // Export private key as JWK; "d" is the base64url 32-byte seed.
  const privJwk = await subtle.exportKey("jwk", kp.privateKey);
  // Export public key as raw 32 bytes.
  const pubRaw = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));

  const b64urlToBytes = (s) => {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
    return Uint8Array.from(Buffer.from(b64, "base64"));
  };
  const seed = b64urlToBytes(privJwk.d); // 32-byte private seed

  if (seed.length !== 32) throw new Error(`private seed must be 32 bytes, got ${seed.length}`);
  if (pubRaw.length !== 32) throw new Error(`public key must be 32 bytes, got ${pubRaw.length}`);

  const toHex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
  const toB64 = (u8) => Buffer.from(u8).toString("base64");

  console.log("=== PRIVATE KEY (Worker secret only — never commit) ===");
  console.log("SIGNING_PRIVATE_KEY (base64, 32-byte seed):");
  console.log(toB64(seed));
  console.log("");
  console.log("=== PUBLIC KEY (embed in the app) ===");
  console.log("Rust [u8; 32] (hex):");
  console.log(toHex(pubRaw));
  console.log("");
  console.log("Public key (base64) — use this for the JWK \"x\" field if your Workers runtime requires it (§2.2):");
  console.log(toB64(pubRaw));
})();
NODE
```

생성된 공개키 hex를 앱 소스에 임베드한다. 아래 헬퍼는 hex 문자열을 컴파일 타임 상수로 안전하게 변환한다.

```rust
// build-time embedded public verifying key (32 bytes).
// Paste the hex emitted by gen-ed25519.sh here. Do NOT embed the private key.
const PUBKEY_HEX: &str = "PASTE_64_HEX_CHARS_HERE";

/// Decode the embedded hex public key into a fixed 32-byte array at startup.
/// Panics on malformed input — a wrong key is a build/config error, not a runtime path.
fn embedded_pubkey() -> [u8; 32] {
    hex_decode_32(PUBKEY_HEX).expect("PUBKEY_HEX must be 64 hex chars (32 bytes)")
}

fn hex_decode_32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        let hi = (s.as_bytes()[2 * i] as char).to_digit(16)?;
        let lo = (s.as_bytes()[2 * i + 1] as char).to_digit(16)?;
        out[i] = ((hi << 4) | lo) as u8;
    }
    Some(out)
}
```

> 키 회전: 앱에 임베드된 공개키는 릴리스에 묶이므로 회전이 어렵다. 회전이 필요하면 신·구 공개키 둘 다 받아들이는 앱 버전을 먼저 배포한 뒤 Worker 서명 키를 교체한다. Paddle 웹훅 시크릿(`pdl_ntfset_…`)은 이와 무관하게 독립적으로 회전 가능하며, 계약 §3의 다중 `h1` 매칭이 회전 구간을 흡수한다(Paddle은 시크릿 회전 중 한 헤더에 복수 `h1`을 실어 보낼 수 있으므로 **모든** `h1`에 대해 매칭을 시도해야 한다).

### 2. wrangler 시크릿 · KV 설정

Worker가 참조하는 환경 의존성은 두 종류다. **시크릿**(암호화 저장, 코드에서 `env.X`로 접근)과 **KV 네임스페이스 바인딩**(`wrangler.toml`에 선언). 환경(sandbox/live)은 Paddle처럼 Worker에서도 완전히 분리한다.

#### 2.1 KV 네임스페이스 생성 + 바인딩

라이선스 레코드(`license:`), 주문 인덱스(`order:`), 멱등성 키(`event:`), nonce(`verify-nonce:`)가 모두 한 네임스페이스에 들어간다(계약 §5.1). 환경별로 별도 네임스페이스를 만든다.

```bash
# Create one KV namespace per environment.
# wrangler prints an `id` — paste each into the matching [env.*] block below.
wrangler kv namespace create LICENSE_KV --env sandbox
wrangler kv namespace create LICENSE_KV --env production
```

```toml
# wrangler.toml — environment-separated config.
name = "license-worker"
main = "src/index.js"
compatibility_date = "2025-01-01"

# --- Sandbox ---
[env.sandbox]
vars = { PADDLE_ENV = "sandbox" }   # non-secret; selects api host + client token shape

[[env.sandbox.kv_namespaces]]
binding = "LICENSE_KV"
id = "PASTE_SANDBOX_KV_ID"

# --- Production ---
[env.production]
vars = { PADDLE_ENV = "production" }

[[env.production.kv_namespaces]]
binding = "LICENSE_KV"
id = "PASTE_PRODUCTION_KV_ID"
```

> 바인딩 이름 주의: 위 webhook Worker는 KV 바인딩을 `LICENSE_KV`로, `/verify` Worker는 `LICENSES`로 참조했다. 단일 배포로 합칠 때는 한 바인딩 이름으로 통일하라(예: 모두 `LICENSE_KV`). 두 Worker가 같은 네임스페이스를 가리키는 한 키 패턴(`license:`/`order:`/`event:`/`verify-nonce:`/`device:`)은 그대로 공유된다.

#### 2.2 시크릿 주입

Worker가 쓰는 시크릿 목록:

| 시크릿 이름 | 값 형식 | 출처 / 용도 |
|---|---|---|
| `PADDLE_WEBHOOK_SECRET` | `pdl_ntfset_…` (raw UTF-8) | 웹훅 서명 HMAC 키. **per-destination** 비밀. 계약 §3 Step 5 |
| `PADDLE_API_KEY` | sandbox `pdl_sdbx_apikey_…` / live `pdl_live_apikey_…` | 서버 측 REST 호출 `Authorization: Bearer`. (선택적 `GET /customers/{id}`로 이메일 조회 등 — 구독 웹훅에는 이메일이 없음) |
| `SIGNING_PRIVATE_KEY` | base64 32바이트 seed | `/verify` Ed25519 서명. §1에서 생성 |
| `PADDLE_CLIENT_TOKEN` | sandbox `test_…` / live `live_…` | `/checkout/session` 응답의 `client_token` (계약 §6.1). public 토큰이지만 환경별 분리를 위해 시크릿으로 관리 |

> API key 형식 참고: live는 `pdl_live_apikey_…`, sandbox는 `pdl_sdbx_apikey_…` 접두사이며 환경은 base URL 호스트(`https://api.paddle.com` vs `https://sandbox-api.paddle.com`)와 키 접두사 **둘 다**로 결정된다(sandbox/live는 완전 분리된 workspace).

```bash
# Inject secrets per environment. wrangler prompts for the value (no shell history leak).
# Paste each value when prompted — do NOT pass via command-line argument.

# --- Sandbox ---
wrangler secret put PADDLE_WEBHOOK_SECRET --env sandbox   # pdl_ntfset_... (sandbox destination)
wrangler secret put PADDLE_API_KEY        --env sandbox   # pdl_sdbx_apikey_...
wrangler secret put SIGNING_PRIVATE_KEY   --env sandbox   # base64 32-byte seed (sandbox keypair)
wrangler secret put PADDLE_CLIENT_TOKEN   --env sandbox   # test_...

# --- Production ---
wrangler secret put PADDLE_WEBHOOK_SECRET --env production   # pdl_ntfset_... (live destination)
wrangler secret put PADDLE_API_KEY        --env production   # pdl_live_apikey_...
wrangler secret put SIGNING_PRIVATE_KEY   --env production   # base64 32-byte seed (live keypair)
wrangler secret put PADDLE_CLIENT_TOKEN   --env production   # live_...

# Verify (lists names only, never values):
wrangler secret list --env sandbox
wrangler secret list --env production
```

Worker 안에서 base64 seed를 Ed25519 서명 키로 import하는 코드:

```js
// Import the base64 32-byte seed as an Ed25519 signing key (Web Crypto, no Node Buffer).
// Workers' subtle.importKey accepts "jwk" with crv "Ed25519".
function bytesToB64Url(u8) {
  let bin = "";
  for (const b of u8) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// env.SIGNING_PUBLIC_KEY is OPTIONAL: the base64 32-byte public key from §1.
// Provide it if your Workers runtime rejects a "d"-only Ed25519 JWK (see note below).
async function importSigningKey(seedB64, pubB64 /* optional */) {
  const seed = b64ToBytes(seedB64); // 32-byte private seed
  if (seed.length !== 32) throw new Error("SIGNING_PRIVATE_KEY must be a 32-byte base64 seed");

  const jwk = {
    kty: "OKP",
    crv: "Ed25519",
    d: bytesToB64Url(seed),
    key_ops: ["sign"],
    ext: false,
  };
  // Some runtimes require the public component "x". If a base64 public key is
  // supplied, include it as base64url; otherwise rely on derivation from "d".
  if (pubB64) {
    const pub = b64ToBytes(pubB64);
    if (pub.length !== 32) throw new Error("SIGNING_PUBLIC_KEY must be a 32-byte base64 key");
    jwk.x = bytesToB64Url(pub);
  }
  return crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
}

// Usage at /verify (signs canonical assertion bytes per contract §6.2):
async function signAssertion(env, canonicalBytes) {
  const key = await importSigningKey(env.SIGNING_PRIVATE_KEY, env.SIGNING_PUBLIC_KEY);
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, canonicalBytes); // 64 bytes
  return new Uint8Array(sig);
}
```

> 검증되지 않음(inline note): Cloudflare Workers의 Ed25519 `importKey("jwk", …)`에서 `d`만 주고 `x`를 생략했을 때의 동작은 런타임 버전에 따라 다를 수 있다. 위 코드는 `SIGNING_PUBLIC_KEY`(§1의 공개키 base64)가 주어지면 `x`에 채워 넣어 양쪽 런타임을 모두 커버한다. 배포 전 샌드박스에서 `signAssertion` 결과를 앱의 `verify_strict`로 한 번 왕복 검증해 확정하라(§3.3).

### 3. Paddle 샌드박스 E2E 테스트

샌드박스는 live와 **완전히 분리된 workspace**다(sandbox/live는 자체 키·토큰을 가진 별도 환경). 샌드박스 대시보드의 자체 가격(`pri_…`), 자체 client token(`test_…`), 자체 API key(`pdl_sdbx_apikey_…`), 자체 웹훅 destination secret(`pdl_ntfset_…`)을 쓴다. 아래는 의존성 낮은 순서로 검증한다.

#### 3.1 사전 준비 (Paddle 샌드박스 대시보드)

1. **샌드박스 workspace 진입**: Paddle 대시보드에서 sandbox 토글.
2. **상품·가격 생성**: 테스트용 Product → Price. 영구 라이선스는 일회성 가격(`billing_cycle: null`), 구독은 `billing_cycle` 설정 가격으로 만든다(가격 구분은 `billing_cycle`의 유무). 한국 결제수단 노출을 검증하려면 **KRW 가격**을 별도로 만든다(KRW 가격 + 고객 주소 국가 KR이 **둘 다** 충족돼야 KakaoPay 등이 자동 노출).
3. **웹훅 destination 등록**: Developer Tools → Notifications → 새 destination, URL = `https://<worker>.workers.dev/webhooks/paddle` (sandbox 배포 주소). 구독할 이벤트는 계약 §2의 다음 이벤트만 선택한다(모두 검증된 Paddle Billing 이벤트명). 영구 라이선스: `transaction.completed`. 구독: `subscription.created`, `subscription.activated`, `subscription.updated`, `subscription.past_due`, `subscription.paused`, `subscription.canceled`. 환불/조정: `adjustment.created`, `adjustment.updated`.
4. **destination secret 복사** → `wrangler secret put PADDLE_WEBHOOK_SECRET --env sandbox`로 주입(§2.2). 이 secret은 destination마다 다르다.
5. **한국 결제수단 토글**: Checkout → Checkout settings → General에서 KakaoPay/Naver Pay/Samsung Pay/Payco 체크(활성화는 대시보드 전용. `allowedPaymentMethods`는 *제한/사전선택*만 하며 활성화 수단이 아니다).

> 이벤트명 주의: Paddle Billing은 전용 `refund.*` 이벤트가 **없다**. 환불은 **adjustment**로 모델링되며 `adjustment.created`/`adjustment.updated`를 듣고 adjustment의 action/status로 전액 환불을 판별한다. 또한 `subscription.canceled`는 미국식 철자(`l` 하나)이며, 다양한 상태 변화(갱신·업/다운그레이드·재개)는 `subscription.updated` 하나로 들어오므로 별도 이벤트가 필요 없다.

#### 3.2 웹훅 서명 검증 단위 테스트 (결제 없이 먼저)

실제 결제 전에 §3 서명 알고리즘이 정확한지 로컬에서 못 박는다. 같은 시크릿으로 HMAC을 직접 만들어 Worker에 던진다. 이 단계가 통과하지 않으면 결제 E2E는 의미가 없다.

```bash
#!/usr/bin/env bash
# webhook-sig-test.sh — forge a valid Paddle-Signature and POST it to the Worker.
# Confirms the §3 algorithm (signed payload = "ts:rawBody", HMAC-SHA256 lowercase hex,
# key = raw-UTF-8 secret) end-to-end.
set -euo pipefail

WORKER_URL="${1:?usage: webhook-sig-test.sh <worker-url> <webhook-secret>}"
SECRET="${2:?missing pdl_ntfset_... secret}"

# A minimal but contract-shaped subscription.created payload.
# Envelope fields are at TOP LEVEL (event_id/event_type/occurred_at/notification_id/data),
# NOT nested under data — this mirrors Paddle's verified webhook envelope.
# custom_data MUST carry app_user_id + order_id or the Worker 200-noops (§4 reconciliation).
RAW_BODY='{"event_id":"evt_test_0001","event_type":"subscription.created","occurred_at":"2026-06-23T10:00:00.000000Z","notification_id":"ntf_test_0001","data":{"id":"sub_test_0001","status":"trialing","customer_id":"ctm_test_0001","custom_data":{"app_user_id":"usr_test","order_id":"ord_test","license_kind":"subscription","schema":1},"items":[{"price":{"id":"pri_test_0001","product_id":"pro_test_0001"}}],"scheduled_change":null}}'

TS="$(date +%s)"

# HMAC-SHA256 over EXACTLY "ts:rawBody", lowercase hex. Key is the raw UTF-8 secret string.
# printf '%s' avoids the trailing newline that `echo` would add (would break the signature).
SIG_INPUT="${TS}:${RAW_BODY}"
H1="$(printf '%s' "$SIG_INPUT" | openssl dgst -sha256 -hmac "$SECRET" -r | awk '{print $1}')"

echo "POST -> ${WORKER_URL}"
curl -sS -i -X POST "$WORKER_URL" \
  -H "Content-Type: application/json" \
  -H "Paddle-Signature: ts=${TS};h1=${H1}" \
  --data-raw "$RAW_BODY"
echo ""
echo "Expected: HTTP/1.1 200 (verified + handled)"
echo "Tamper test: change one byte of RAW_BODY WITHOUT recomputing H1 -> expect 401 Invalid signature"
```

> `openssl dgst … -r | awk '{print $1}'`로 hex만 뽑는다. (OpenSSL 1.x는 `(stdin)= HEX`, 3.x는 `SHA2-256(stdin)= HEX`를 출력하므로 prefix 의존 파싱은 피한다. `-r`는 `HEX *stdin` coreutils 포맷이라 `awk '{print $1}'`이 양 버전에서 안정적이다.)

검증 포인트:

- 정상 페이로드 → **200**.
- `H1`을 한 글자 바꾸거나 `RAW_BODY`를 변형하고 `H1`을 재계산하지 않으면 → **401** (계약 §3 Step 6).
- `TS`를 `now - 400`으로 만들면 → **401** (Worker tolerance 초과). **주의:** Paddle SDK 기본 tolerance는 **5초**이며, 본 Worker는 큐·프록시 클럭 스큐를 흡수하려 **300초**로 넓혔다(이 더 넓은 값은 Paddle 문서가 명시한 값이 아니라 운영상 선택이다). tolerance를 바꾸면 이 경계 테스트 값도 함께 조정한다.
- 같은 `event_id`로 두 번 보내면 두 번째는 멱등 처리되어 **200**이되 라이선스 레코드 재작성 없음(계약 §5.5). dedup 키는 `event_id`(`evt_…`)이지 `notification_id`(`ntf_…`)가 아니다.

> Worker는 `request.text()`로 읽은 **원문 바이트**에 HMAC을 계산한다(계약 §3 Step 1, raw body를 파싱·재직렬화하면 서명이 깨진다). 따라서 여기서도 동일한 바이트여야 하며 `JSON.parse`는 서명 검증 **통과 후**에만 한다.

#### 3.3 `/verify` 왕복 테스트 (Ed25519 서명 ↔ 검증)

Worker가 서명한 어서션을 앱의 `verify_strict`가 받아들이는지 확인한다. 계약 §6.2의 **고정 키 순서 compact JSON** 직렬화가 양쪽에서 동일해야 한다.

```bash
# 1) challenge: get a nonce
curl -sS -X POST "$WORKER_URL/verify/challenge" \
  -H "Content-Type: application/json" \
  --data-raw '{"app_user_id":"usr_test"}'
# -> {"nonce":"...","expires_at":"..."}

# 2) verify: echo the nonce, receive {assertion, signature}
curl -sS -X POST "$WORKER_URL/verify" \
  -H "Content-Type: application/json" \
  --data-raw '{"app_user_id":"usr_test","nonce":"PASTE_NONCE_FROM_STEP_1"}'
# -> {"assertion":{...},"signature":"b64url-64-bytes"}  (if state ∈ {active,past_due})
# -> 403 not_entitled  (if state ∈ {paused,canceled,refunded})
# -> 404 no_license    (if no record for usr_test)
# -> 409 nonce_invalid (if nonce unknown/expired/reused)
```

Rust 측 왕복 검증 테스트(앱에 임베드된 공개키로 §6.2 canonical 바이트를 재구성해 `verify_strict`). `ed25519-dalek` v2(2.2.0) 기준 — `VerifyingKey::from_bytes`는 `Result`(fallible), `Signature::from_bytes(&[u8;64])`는 infallible:

```rust
use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;

#[derive(Deserialize)]
struct Assertion {
    app_user_id: String,
    state: String,
    license_kind: String,
    nonce: String,
    issued_at: String,
    expires_at: String,
}

/// Rebuild the EXACT signed bytes per contract §6.2: compact JSON, fixed key order
/// app_user_id, state, license_kind, nonce, issued_at, expires_at.
/// Manual construction guarantees byte-for-byte match (serde field order is not contractual).
fn canonical_assertion_bytes(a: &Assertion) -> Vec<u8> {
    fn esc(s: &str) -> String {
        // JSON string escaping for the subset of chars these fields contain.
        s.replace('\\', "\\\\").replace('"', "\\\"")
    }
    format!(
        r#"{{"app_user_id":"{}","state":"{}","license_kind":"{}","nonce":"{}","issued_at":"{}","expires_at":"{}"}}"#,
        esc(&a.app_user_id),
        esc(&a.state),
        esc(&a.license_kind),
        esc(&a.nonce),
        esc(&a.issued_at),
        esc(&a.expires_at),
    )
    .into_bytes()
}

/// Verify a /verify response against the embedded public key.
/// `sig_64` is the decoded 64-byte signature; `pubkey_32` is the embedded key.
fn verify_assertion(
    assertion: &Assertion,
    sig_64: &[u8; 64],
    pubkey_32: &[u8; 32],
    sent_nonce: &str,
    app_user_id: &str,
    now_rfc3339: &str,
) -> Result<bool, Box<dyn std::error::Error>> {
    let vk = VerifyingKey::from_bytes(pubkey_32)?; // fallible in v2
    let sig = Signature::from_bytes(sig_64);       // infallible in v2 (&[u8; 64])
    let msg = canonical_assertion_bytes(assertion);

    // Rule 1 — signature must verify. verify_strict rejects weak/small-order public keys
    // that plain verify() would accept (verified: use verify_strict for license tokens).
    // If the signature is invalid this returns Err, so the whole fn fails closed.
    vk.verify_strict(&msg, &sig)?;

    // Rules 2-5 (contract §6.2): nonce match, freshness, user match, state gate.
    let nonce_ok = assertion.nonce == sent_nonce; // single-use nonce echoed back (replay defense)
    let user_ok = assertion.app_user_id == app_user_id;
    // RFC3339 lexical comparison is valid ONLY when both strings are zero-padded,
    // same fractional-second width, and the SAME UTC offset (always "Z" here).
    // The Worker must emit issued_at/expires_at and the client must emit `now` in that
    // identical canonical form, else compare numerically instead.
    let fresh_ok = now_rfc3339 < assertion.expires_at.as_str();
    let entitled = matches!(assertion.state.as_str(), "active" | "past_due");

    Ok(nonce_ok && user_ok && fresh_ok && entitled)
}
```

> 정규화 경고 (트랙 B와 동일): 이 테스트의 `canonical_assertion_bytes`는 손으로 escape를 처리한다. 실제 클라이언트 코드(`serde_json::to_vec` 경로)와 이 테스트, 그리고 Worker의 `canonicalAssertionBytes`가 **비-ASCII `app_user_id`를 포함해 동일 바이트**를 내는지 골든 벡터로 고정하라. 양측 escape 규칙이 어긋나면 정당한 서명이 거부된다.

샌드박스에서 라이선스 상태별로 `state`를 바꿔가며(없음→404, active→통과, paused→403) 위 함수가 계약 §5.4 접근 규칙대로 결정하는지 확인한다.

#### 3.4 전체 결제 E2E

1. 앱에서 `POST /checkout/session` 호출 → Worker가 `order_id` 생성, pending intent 저장, `client_token`+`environment`+`price_id`+`custom_data` 반환(계약 §6.1).
2. 앱이 반환값을 **그대로** 써서 시스템 브라우저(`tauri-plugin-opener` 2.5.4의 `open_url`)로 Paddle 호스티드 체크아웃을 연다. 앱은 `order_id`/`custom_data`를 임의 생성하지 않는다. (v2에서는 core shell API가 제거되고 URL 열기는 `opener` 플러그인으로 분리됨. capability `opener:allow-open-url` + `opener:allow-default-urls` 필요.)
3. 체크아웃에서 **샌드박스 테스트 카드**로 결제 완료. (한국 결제수단 노출 확인은 KRW 가격 + 주소 국가 KR로 진행.)
4. Paddle이 destination으로 웹훅 발사 → Worker가 서명 검증·멱등 처리·KV write. (Paddle은 at-least-once 전송이라 같은 이벤트가 중복·역순으로 올 수 있다 — `event_id` dedup + `occurred_at` 역전 무시가 필수.)
5. 앱이 `/verify/challenge` → `/verify`로 라이선스 활성 확인.

검증 체크:

```bash
# After a sandbox purchase, inspect KV directly to confirm the write path.
wrangler kv key get "license:usr_test" --binding LICENSE_KV --env sandbox
wrangler kv key get "order:ord_test"   --binding LICENSE_KV --env sandbox   # -> app_user_id
wrangler kv key get "event:evt_..."    --binding LICENSE_KV --env sandbox   # -> "1" (TTL 24h)
```

시나리오별 기대값. **엔타이틀먼트는 이벤트명이 아니라 `data.status`로 결정한다**(구독 access는 status로 구동). 트라이얼(`status=trialing`)도 접근 허용이며, `subscription.created`에서 이미 접근을 부여하고 `subscription.activated`를 기다리지 않는다:

| 시나리오 | 트리거 이벤트 | `data.status` | KV `state` | `/verify` 결과 |
|---|---|---|---|---|
| 영구 라이선스 구매 | `transaction.completed` | — (트랜잭션) | `active` | 200 entitled |
| 구독 생성(트라이얼) | `subscription.created` | `trialing` | `active` | 200 entitled |
| 구독 활성화 | `subscription.activated` | `active` | `active` | 200 entitled |
| 결제 연체 | `subscription.past_due` (또는 `updated`) | `past_due` | `past_due` | 200 entitled (경고 배너) |
| 일시정지 | `subscription.paused` (또는 `updated`) | `paused` | `paused` | 403 not_entitled |
| 구독 취소 | `subscription.canceled` (또는 `updated`) | `canceled` | `canceled` | 403 not_entitled |
| 전액 환불 | `adjustment.created` (full refund) | — (조정) | `refunded` | 403 not_entitled |

> 예약 취소 주의: `scheduled_change`만 설정된 동안은 `data.status`가 여전히 `active`다(scheduled_change는 effective_at까지 status를 바꾸지 않는다). 샌드박스에서 "다음 결제일 취소"를 걸어도 즉시 `403`이 되면 안 된다 — 실제로 status가 `canceled`로 바뀔 때만 revoke한다.
>
> 다중 항목 주의: `data.items`는 배열이다(멀티 항목 구독 존재). 플랜/티어 매핑은 `items[0]`만이 아니라 전체 항목을 보고, 매핑 키는 product보다 `items[].price.id`를 우선한다(한 product에 여러 price가 있을 수 있음).
>
> 이메일 주의: 구독 웹훅 payload에는 고객 이메일이 **없다**(`customer_id`만 존재). 이메일이 필요하면 `GET /customers/{customer_id}` 또는 `customer.created`/`customer.updated` 웹훅으로 별도 취득한다.

샌드박스 전체 통과 후에야 `--env production`으로 동일 절차를 반복한다.

### 4. 운영 배포 체크리스트

#### 4.1 시크릿 관리

- [ ] live 시크릿 4종이 **production 환경에만** 주입됨(`wrangler secret list --env production`). sandbox 값이 production에 섞이지 않았는지 확인.
- [ ] `SIGNING_PRIVATE_KEY`(개인키)가 저장소·CI 로그·앱 번들 어디에도 없음. `git log -p`와 빌드 산출물 grep으로 32바이트 seed 흔적 점검.
- [ ] 앱에 임베드된 공개키가 **production 키쌍**의 공개키와 일치(§1에서 생성한 live 키쌍 기준). sandbox 공개키로 빌드된 릴리스가 나가지 않도록 확인.
- [ ] `PADDLE_WEBHOOK_SECRET`이 **live destination**의 secret(`pdl_ntfset_…`)인지 확인. sandbox destination secret과 다름.
- [ ] `PADDLE_API_KEY`가 `pdl_live_apikey_…` 접두사인지 확인. (서버 전용, 클라이언트 노출 금지.)
- [ ] 키 회전 절차 문서화: 공개키는 앱 릴리스에 묶이므로 신·구 동시 수용 → Worker 키 교체 순서를 따른다(§1 주석).

#### 4.2 코드서명 / notarization (Tauri 데스크톱 앱)

> 아래 절차의 일부 세부(Apple notarization 명령 플래그, Tauri 서명 환경변수 정확한 키 이름)는 본 계약·연구 범위 밖이다. 표시된 항목은 Tauri/Apple 공식 문서로 확정한 뒤 적용하라. 검증된 사실만 기재한다.

- [ ] **macOS**: Developer ID Application 인증서로 코드서명 + Apple notarization. notarization을 통과해야 Gatekeeper가 "확인되지 않은 개발자" 차단을 풀고, deep link 콜백(`tauri-plugin-deep-link` 2.4.9)이 설치된 `/Applications` 번들에서만 동작하는 제약(macOS는 스킴을 번들에 baked-in해야 하고 `tauri dev`에서 deep link 신뢰성 있게 테스트 불가)도 정식 서명 빌드에서 검증한다.
- [ ] **Windows/Linux deep link**: 딥링크가 *새* 프로세스의 CLI 인자로 도착하므로 `tauri-plugin-single-instance`(deep-link feature, 가장 먼저 등록)가 필요하다. 폴링 방식(`/verify` 반복)을 fallback으로 둘지 결정.
- [ ] **딥링크 토큰은 신뢰 금지**: deep link로 도착한 토큰/어서션은 스푸핑 가능하므로 도착 즉시 신뢰하지 말고 반드시 §3.3의 Ed25519 `verify_strict`로 검증한다.
- [ ] **Windows**: 코드서명 인증서(OV/EV)로 서명. 미서명 시 SmartScreen 경고.
- [ ] 서명 키·인증서는 CI 시크릿 저장소에만 두고 저장소에 커밋하지 않는다.
- [ ] 서명된 릴리스 빌드에서 §3.4 결제 E2E를 1회 더 실행해 deep link / 시스템 브라우저 열기(`tauri-plugin-opener`)가 정상 동작하는지 확인.

#### 4.3 인증서 핀닝 (TLS)

앱 ↔ Worker 통신은 전부 HTTPS JSON이다(계약 §6, `reqwest` 0.13으로 호출). `/verify` 신뢰 앵커는 **Ed25519 서명**이지 TLS가 아니다 — TLS 핀닝은 중간자에 의한 트래픽 관찰·교체를 막는 추가 방어선이다.

- [ ] `reqwest` 클라이언트에 Worker(`*.workers.dev` 또는 커스텀 도메인) 인증서/공개키 핀 적용 검토. 핀은 leaf가 아닌 **중간 CA 또는 SPKI** 수준으로 두어 인증서 갱신 시 앱이 죽지 않게 한다.
- [ ] 핀 만료/회전 대비: 현행 핀 + 차기 핀을 동시에 수용하는 백업 핀 전략. (Cloudflare 엣지 인증서는 주기적으로 갱신되므로 leaf 핀은 위험.)
- [ ] **핀 실패 시 fallback 정책 명시**: 핀 검증 실패를 hard-fail로 둘지(가용성↓·보안↑) 결정. 라이선스 검증의 최종 신뢰는 어차피 Ed25519 `verify_strict`이므로(계약 §6.2), 핀은 강제하되 실패 시 사용자에게 명확한 네트워크 오류를 노출하는 편을 권장.

> 핀닝의 한계: `reqwest` 0.13의 정확한 핀닝 구성 방식(`native-tls` 콜백 vs `rustls` `ServerCertVerifier`)은 활성화한 TLS 백엔드 feature에 따라 다르며 본 연구에서 확정되지 않았다(0.13의 기본 TLS 백엔드 feature 미확인). 채택 전 백엔드(`rustls-tls` vs `native-tls`)를 고정하고 해당 API로 검증하라.

#### 4.4 운영 마지막 점검

- [ ] Worker가 구독·트랜잭션·조정 이벤트(계약 §2의 구독 대상) 외 이벤트에 **200 무시** 응답(빠르게 2xx 응답, 미구독 이벤트는 무시).
- [ ] `custom_data`에 `app_user_id`/`order_id` 누락 시 라이선스 발급 없이 **200-noop**(계약 §4 reconciliation). `custom_data`는 Paddle Billing 필드이며 Classic의 `passthrough`가 아니다.
- [ ] 멱등성: `event:{event_id}` 중복 시 no-op, 저장된 `occurred_at`보다 엄격히 오래된(역전) 이벤트 시 no-op(계약 §5.5). dedup 키는 `evt_…`이지 `ntf_…`가 아님.
- [ ] `/verify` nonce 단일 사용·짧은 TTL 동작 확인(재사용 시 409 `nonce_invalid`).
- [ ] KV hot-key 대비: 동일 키 **1 write/sec** 초과 시 **429**. 또한 KV는 최종 일관성(전파 최대 60초)·last-write-wins라 강한 exactly-once 락이 아니다 — 엄격 exactly-once가 필요하면 Durable Objects 검토(KV는 best-effort dedup).

---

## 한국 사업자 Paddle 신청 · 심사 · 정산 가이드

> 이 절은 절차·행정 안내입니다. 세무·법률 판단은 면허 있는 한국 세무사 확인이 필요합니다. 아래 정산·과세 항목 중 다수가 사실관계에 따라 달라지므로, 결정 전 확인하십시오.

Paddle은 **Merchant of Record(MoR, 등록판매자)** 입니다. 즉 최종 고객에게 제품을 판매하는 주체는 판매자가 아니라 Paddle이며, 이 구조가 해외 부가세·세금 처리를 바꿉니다(아래 정산·과세 항목 참조). 단, 신청·심사·정산 메커니즘 자체는 다른 나라와 동일합니다. **한국 전용 가입 포털은 없습니다.** 대한민국은 Paddle의 미지원 국가 목록(북한 등)에 포함되지 않으므로 개인사업자·법인 모두 신청 가능합니다. 다만 Paddle이 "한국 지원"을 명시적으로 공표한 문구는 확인되지 않았으므로, 의심스러우면 신청 전 Paddle 지원팀에 직접 확인할 것을 권합니다.

### 1. 판매자 계정 신청 → 심사 흐름

기본 가입 후 계정 검증은 **3단계 순차 절차**로 진행됩니다. 모든 단계가 통과되어야 Paddle이 MoR로서 동작하기 시작합니다.

**Step 0 — 가입 (Paddle 대시보드)**
- **사업자 도메인 이메일**(`you@yourdomain.com`)을 사용하십시오. gmail/naver 같은 무료 메일은 흔한 마찰·거절 트리거입니다.
- 입력하는 이름은 이후 업로드할 **정부 발급 신분증과 정확히 일치**해야 합니다. 한국인은 라틴 알파벳 이름이 일치하는 **여권**을 권장합니다.

**Step 1 — 도메인 / 웹사이트 심사** (Dashboard → Checkout → "Website approval")
라이브 사이트가 내비게이션으로 접근 가능하게 아래를 명확히 노출해야 합니다.
- 제품/서비스 설명 + 핵심 기능/제공물
- 가격 페이지 (아직 라이브가 아니면 스크린샷도 허용)
- **이용약관(Terms & Conditions)** — 반드시 **법적 사업자명**을 포함
- 환불 정책 (Refund Policy)
- 개인정보처리방침 (Privacy Policy)
- 사이트는 **라이브 + HTTPS(유효 SSL)** 여야 함

대부분 도메인은 즉시 자동 승인되며, 수동 심사 시 영업일 기준 약 5~7일이 소요됩니다(공식 보장값 아님, 추정).

**Step 2 — 사업자 식별(Business Identification)** — 등록 사업자(법인)만 해당. (아래 KYC 항목)

**Step 3 — 본인 확인(Identity Verification)** — 최소 1인의 사업 소유자 확인. 플래그될 경우 Paddle 파트너 **Sumsub**를 통해 정부 발급 신분증 + 주소 증빙을 업로드. 사업자 검증은 즉시 통과되는 경우가 많고, 수동 심사 시 영업일 기준 약 2~4일.

**흔한 거절 · 지연 사유**
1. 제품이 Paddle **Acceptable Use Policy(AUP)** 위반
2. 도메인이 고위험으로 플래그되거나 약관 비준수
3. Paddle의 정보 요청에 **무응답** — 빠른 회신이 가장 큰 승인 가속 요인
4. 법적 페이지(약관·개인정보·환불) 누락/미비
5. 무료 메일 가입 주소, 신분증과 이름 불일치

거절은 거절 이메일에 회신하여 이의 제기할 수 있습니다.

### 2. KYC · 본인확인 서류 (한국 사업자)

**개인 / 개인사업자**
- **사업자 식별(Business Identification) 단계는 불필요** ("개인 또는 단독 사업자는 이 단계가 필요 없음").
- 단, **본인 확인(Identity Verification)** 대상: 플래그 시 Sumsub로 정부 발급 신분증(여권 권장) + 주소 증빙.
- 사업자등록이 전혀 없는 한국 개인도 신청 가능(한국 실무자 가이드 기준). 사업자등록은 MoR 관계의 하드 전제조건이 아닙니다.

**법인 — 사업자 식별까지 통과 필요**
1. **법적 사업자명·주소·등록번호·소유 구조·이해관계자 명의가 표시된 정부 발급 사업자 등록 문서.** 한국의 경우 **사업자등록증 / 법인등기부등본**. **PDF**, 또는 로그인 없이 접근 가능한 공개 등기 링크로 제출.
2. **소유/주주 구성** — **25% 초과** 소유자 전원과 지분율을 명시(UBO 공개). 한국 법인은 **주주명부**에 해당.

**사업자 서류로 인정되지 않는 것:** 공과금 고지서, 회계 서류, 세금 ID만 기재된 기록. 한국의 경우 단순 사업자등록번호 슬립만으로는 불충분하며 전체 등록 문서를 제출해야 합니다.

### 3. 한국 정산 (Payouts)

**정산 방법:** Paddle은 **(1) 은행/전신 송금(wire)** 또는 **(2) Payoneer**로 지급합니다. (구버전 문서·블로그는 PayPal을 언급하나, 현재 헬프 센터는 wire + Payoneer만 표기. PayPal은 신규 계정 기준 레거시/미확인으로 취급.)

**정산 주기 (매월 고정)**
- 매월 **1일**: 잔액이 임계값을 초과하면 정산 대상으로 전환
- **2~15일**: Paddle이 **15일까지** 지급
- 입금까지 **추가 영업일 최대 3일**
- 임계값 미만 잔액은 다음 달로 이월

**최소 정산액(임계값):** **$100** (또는 £100 / €100). 최대 $100,000까지 상향 조정 가능.

**정산 통화 — 은행/전신 송금 지원 13종:** AUD, GBP, CAD, CNY, CZK, DKK, EUR, HUF, PLN, ZAR, SEK, CHF, USD.
- **KRW(원화)는 이 목록에 없습니다.** 이것이 한국의 핵심 주의점입니다(아래 5항).
- **Payoneer:** **USD 전용**.
- 잔액 통화에서 환전 시 Paddle은 표준 마진과 별도로 **최대 1.5% 환전 마진**을 부과할 수 있습니다.

**SWIFT/전신 수수료:** 대부분 국가는 무료이나, 일부 국가의 국제 송금에는 **$15 SWIFT 수수료**가 적용될 수 있습니다. 한국행 USD 전신 송금은 국제 SWIFT이므로 정산 건당 **$15** 수수료를 예산에 반영하십시오.

**한국 계좌가 필요한가, Wise/Payoneer가 필요한가?** 아래 중 무엇이든 사용 가능합니다.
1. **한국 은행 계좌 직접** — Transfer Preferences에 BIC/SWIFT + 계좌번호 입력. **USD로 지급**되며(KRW 미지원), 한국 은행이 자체 환율로 원화 환전 + 해외송금 수취 수수료를 부과할 수 있음. SWIFT 라우팅 필요.
2. **Payoneer** — **USD로 수취** 후 한국 은행으로 출금(한국 자료 기준 출금 수수료 약 1.2%). 한국 1인 개발자가 흔히 선택.
3. **Wise / Payoneer "Global Receiving Account"** — **USD 계좌의 BIC/SWIFT + 계좌번호**를 발급받아 Paddle Transfer Preferences에 입력. 이후 USD→KRW를 중간 환율 근처로 환전(보통 한국 은행 SWIFT 수취보다 유리한 FX). Paddle 헬프가 BIC/SWIFT/IBAN을 가진 Wise형 계좌 사용을 명시(메커니즘 확인됨). 단, **Wise/Payoneer의 현재 정확한 수수료 수치는 미확인** — 각 제공사에서 직접 확인할 것.

**설정:** 첫 정산 전에 대시보드의 Transfer Preferences에 Payment Method, Transfer Currency(= **USD**), BIC/SWIFT, 계좌번호, 필요 시 IBAN을 구성하십시오.

### 4. 개인사업자 vs 법인 차이

| 항목 | 개인 / 개인사업자 | 법인 |
|---|---|---|
| 사업자 식별(Business Identification) | **불필요** | **필요** (사업자등록증/법인등기부등본 PDF + 주주명부) |
| 본인 확인(Identity Verification) | 필요 (플래그 시 Sumsub) | 필요 (소유자 1인 이상) |
| 사업자등록 전제조건 | 없음 (무등록 개인도 신청 가능) | 법인 등록 문서 필수 |
| 한국 소득 신고 | 종합소득세(사업소득) | 법인세 |

### 5. 한국 특유 주의점

1. **KRW는 Paddle 정산 통화가 아니다.** **USD**(또는 13종 중 하나)로 지급됩니다. 환전 + 수취 처리 비용을 계획하십시오.
2. **$15 SWIFT 수수료**가 한국 은행 직접 전신 송금(국제 SWIFT)에 적용될 가능성이 있습니다. **Wise/Payoneer USD 수취 계좌**로 이를 회피하고 더 나은 FX를 얻을 수 있습니다(메커니즘 확인됨, 건당 수수료 수치는 미확인).
3. **MoR = 해외 디지털 판매에 대한 한국 부가세/판매세 신고 부담 없음.** Paddle이 한국 부가세 및 타 관할 세금을 계산·징수·납부하고 세금계산서를 자동 발행합니다(확인됨). **단(미확인):** 이것이 판매자 본인의 **한국 소득세/법인세** 신고 의무를 자동 면제하지는 않습니다. 정산 수입에 대한 한국 세무 처리는 한국 세무사 확인 필요.
4. **구매자 측 결제는 한국에서 잘 지원됩니다**(Naver Pay, Kakao Pay, PAYCO, Samsung Pay, KRW 가격). 이는 고객이 한국인일 때 관련되며, 판매자 정산과는 별개입니다. (한국 결제수단이 체크아웃에 표시되려면 KRW 가격 + KR 고객 주소가 필요하며, 대시보드에서 각 수단을 ON으로 토글해야 합니다.)
5. **한국 소득세/법인세는 그대로 판매자 의무.** 해외 플랫폼을 거치므로 국세청이 데이터를 자동 조회할 수 없어 매출 누락 위험이 높습니다. Paddle 명세서를 직접 받아 **총매출(gross)**로 성실 신고해야 합니다(수수료·원천세를 차감한 순액이 아님).
6. **영세율(0%) 적용은 불확실 — 자동이 아님.** Paddle 정산의 영세율 적용 여부는 어떤 출처로도 확정되지 않았습니다. 가장 가까운 유사 사례인 PayPal NTS 유권해석(서면-2016-법령해석부가-3979)은 **불리**합니다(원화 직수취 또는 PayPal 경유 환전은 영세율 미적용). 영세율의 핵심 증빙인 **외화입금증명서**(외국환은행 발급)를 MoR 정산으로 확보하기 어렵다는 점이 구조적 갭입니다. 반드시 세무사가 영세율 vs 과세대상 제외 분류를 판정하게 하십시오.
7. **한국 고객 대상 세금계산서/현금영수증 발행 불가.** 외국 MoR인 Paddle은 한국 고객에게 한국 세금계산서·현금영수증을 발행하지 않습니다. 한국 내수 고객이 있다면 이 의무를 Paddle로 충족할 수 없으므로, 내수는 별도 PG/포트원 등 분리 검토가 필요합니다(이 전환 근거는 추론이며 단일 출처로 명시 확인되지 않음).
8. Paddle은 위험/컴플라이언스 사유로 추가 정보 요청 또는 지급 보류를 행사할 수 있으니 서류를 상시 준비하십시오.

### 6. 단계별 체크리스트

1. **사이트 완성** — HTTPS + 4개 페이지: 제품/가격, **약관(법적 entity명 포함)**, 환불 정책, 개인정보처리방침.
2. **가입** — 대시보드에서 **도메인 이메일**로 가입, 이름은 **여권과 일치**하게 입력.
3. **도메인 제출** — Checkout → Website approval. 자동 승인 또는 영업일 약 5~7일 대기.
4. **사업자 식별 준비** — 법인: **사업자등록증/법인등기부등본(PDF)** + **주주명부(25% 초과 소유자)**. 개인사업자/개인: 이 단계 생략.
5. **본인 확인** — 프롬프트되면 **Sumsub**(여권 + 주소 증빙)로 통과. **Paddle 이메일에는 즉시 회신.**
6. **정산 레일 결정** — **Wise 또는 Payoneer USD 수취 계좌** 개설($15 SWIFT + 은행 FX 회피 권장) 또는 한국 은행 SWIFT 정보 직접 사용.
7. **Transfer Preferences 입력** — 통화 = **USD**, BIC/SWIFT, 계좌번호. 임계값 ≥ **$100** 설정.
8. **첫 정산** — 잔액이 임계값 이상이 된 다음 달, **15일까지** 발송, **영업일 3일 내** 입금 예상.
9. **세무 준비(한국)** — Paddle이 매월 발행하는 **Statement + Reverse Invoice(US / Rest-of-World 분리, 1~2건) + Remittance Advice**를 수령·보관. 이를 한국 소득세/법인세·부가세 신고의 매출 근거로 사용하되, 영세율 적용·내수 세금계산서 처리는 **세무사 확인 필수**.

---

## 한국 세금 신고 방법 (Paddle MoR 기준)

> **면책 고지 (반드시 읽어주세요)**
> 이 문서는 공개 자료를 정리한 **일반 정보**이며 세무 자문이 아닙니다. Paddle 같은 MoR(Merchant of Record) 정산금의 한국 세무 처리 — 특히 **영세율(0%) 적용 가능 여부** — 는 사실관계에 따라 달라지고 실무자 사이에서도 견해가 갈립니다. **신고 전 반드시 한국 세무사의 확인을 받으세요.** 아래 일부 항목은 `[불확실]`로 명시했습니다.

### 1. MoR 세무 분담: Paddle vs 본인

Paddle은 **판매자(seller of record / reseller)** 로서 최종 고객에게 제품을 재판매하는 구조입니다. 이 분담을 명확히 구분하는 것이 모든 신고의 출발점입니다.

| 구분 | Paddle이 처리 | 본인(한국 사업자)이 처리 |
|---|---|---|
| 해외 부가세/판매세(VAT/GST/US sales tax) | **전부 대행**: 100여 개 관할에서 계산·징수·납부, 모든 책임·리스크 부담 | 없음 (해외 VAT 등록·신고 의무 없음) |
| B2B 역과세(reverse charge) | 구매자가 유효 VAT ID 입력 시 면제 처리 | 없음 |
| 정산금 지급 | 총액에서 해외세·수수료 차감한 **순액(net)** 지급 | — |
| **한국 소득세/법인세** | 처리 안 함 | **본인 신고 (종합소득세 또는 법인세)** |
| **한국 부가가치세** | 처리 안 함 | **본인 신고 (1월/7월)** |

> **핵심**: Paddle은 본인의 **한국 세금을 신고·납부하지 않습니다.** 해외 간접세만 Paddle이 가져갑니다. 한국 소득세·법인세·부가세 신고는 100% 본인 책임입니다.

### 2. 부가가치세(VAT) 처리

#### 2.1 국내 매출 vs 해외 매출 분리 (필수)

- **한국 고객 대상 매출**: 일반 **10% 과세**. 반드시 해외 매출과 분리해 신고.
- **해외(비거주자) 고객 대상 매출**: 전자적 용역의 수출로 보아 영세율 적용 여부를 검토.

#### 2.2 전자적 용역 수출의 영세율(0%) — 가장 논쟁적인 부분 `[불확실]`

부가가치세법 §24 / 시행령 §33의 "그 밖의 외화를 획득하는 용역"에 대한 영세율은 **대금 수취 형태**에 엄격한 요건을 둡니다. 전통적 영세율 경로는 대금을 **외국환은행을 통해 외화로 수취·환전**하고 이를 **외화입금증명서**로 입증할 것을 요구합니다.

문제는 가장 가까운 유권해석이 **불리하다**는 점입니다.

> **국세청 유권해석 서면-2016-법령해석부가-3979 (2016.07.07)**: 대금을 **원화로 직접** 받거나 **PayPal 계정을 통해 원화로 전환**해 받는 경우 **영세율이 적용되지 않음** (부가법 §24①3호, 시행령 §33②1호).

Paddle은 PayPal처럼 **수수료·세금을 이미 차감한 순액을 지급하는 중개자(intermediary)** 이며, 종종 USD로 정산되더라도 본인이 원화로 환전해 수취하는 구조에 해당할 수 있습니다. 따라서 **Paddle 정산금이 영세율 대상인지는 어떤 자료로도 확정되지 않았습니다.** PayPal 해석을 유추 적용하면 **불리**하며, 보수적으로 보면 영세율 요건(특히 외화입금증명서)을 충족하지 못해 영세율이 거부되거나, 입증을 잘못하면 10% 과세로 처리될 위험이 있습니다.

- **`[불확실]` — 영세율은 자동이 아닙니다.** 해당 정산 구조에 대해 영세율(0%) / 과세대상 제외 중 무엇이 맞는지는 **세무사가 판단**해야 합니다.

#### 2.3 영세율을 시도할 때 필요한 증빙

서비스 수출에 영세율을 적용하려면 다음 서류가 필요합니다.

- **영세율매출명세서**
- **외화획득명세서** (부가법 §24, 시행령 §31–33의 부속서류)
- **외화입금증명서** (외국환은행 발급) — **MoR 구조에서 확보가 가장 어려운 서류**
- **용역공급계약서 사본 + 대금청구서** — 여기서는 Paddle 약관 + Paddle 명세서/리버스 인보이스
- 플랫폼별 정산 상세 (Paddle Statement)

### 3. 외화 정산의 회계 기록과 환율 환산

#### 3.1 매출은 총액(gross)으로 기록

Paddle 정산금은 본인의 **한국 원천 사업소득**이며 **전액**을 신고해야 합니다. 한국 회계 원칙상 **순액(net payout)이 아니라 총매출**을 잡고, 플랫폼 수수료·차감세액은 **매출에 포함하여 인식한 뒤 비용으로 처리**합니다. ("앱 개발 매출은 플랫폼 수수료 포함해 신고")

> **누락 리스크 주의**: 자금이 **해외 플랫폼**을 거치므로 국세청이 데이터를 자동으로 가져오지 못합니다. 본인이 Paddle 명세서를 직접 내려받아 **성실하게** 신고해야 하며, 매출 누락 가능성이 높은 구조임을 인지해야 합니다.

#### 3.2 환율 환산 규칙

부가세 과세표준 환산은 **공급시기**를 기준으로 합니다.

- 공급시기 **이전**에 원화로 환전한 경우 → **실제 환전 금액** 사용.
- 공급시기 시점에 **외화로 보유/수취**한 경우 → 공급시기 당일의 **기준환율 / 재정환율** (외국환거래법) 사용.

### 4. Paddle 증빙 활용: 지급명세 / 스테이트먼트

Paddle은 정산금과 **별도로** 매월 다음 문서를 제공하며, 이것이 본인 매출의 1차 증빙이 됩니다.

- **Statement (명세서)** — 지급 임계치 미달이어도 **항상 발급**.
- **Reverse Invoice (리버스 인보이스)** — 본인이 Paddle에게 정산액을 청구하는 형태의 문서. **1~2장**으로, **미국 매출분**(Paddle.com Inc.)과 **그 외 지역분**(Paddle UK/Ireland 법인)으로 분리될 수 있음.
- **Remittance Advice (송금 통지)**.
- 대시보드(Admin/Finance 권한) → 정산·매출·세액 리포트 다운로드.

> **증빙의 한계**: 이 리버스 인보이스·명세서는 매출 입증 자료는 되지만, **한국의 외화입금증명서가 아닙니다.** 바로 이 점이 위 2.2의 영세율 증빙 공백입니다.

### 5. 홈택스 전자신고 대상과 신고 시기

모든 신고는 **홈택스**(hometax.go.kr)에서 전자신고하며, 모바일은 **손택스**입니다. 영세율 첨부서류(외화입금증명서·외화획득명세서·영세율매출명세서)는 **홈택스가 자동으로 채워주지 않으므로**(해외 데이터는 국세청이 보유하지 않음) 본인이 직접 업로드해야 합니다.

| 신고 | 대상 | 신고 기간 (매년) |
|---|---|---|
| **부가가치세 2기 확정** | 개인 일반과세자 / 법인 | **1/1 – 1/25** (전년 7~12월분) |
| **부가가치세 1기 확정** | 개인 일반과세자 / 법인 | **7/1 – 7/25** (당년 1~6월분) |
| 부가세 예정신고 | 법인 등 | **4월 / 10월** 예정신고 |
| **종합소득세** | 개인 | **5/1 – 5/31** (성실신고확인 대상자 → **6/30**) |
| **법인세** | 법인 | **사업연도 종료 후 3개월 내** (12월 결산 → **3/31**) |

> 참고: 종합소득세 기한일(5/31)이 주말이면 국세청이 익일로 순연합니다 (예: 2025년 귀속 → 2026/6/1).

### 6. 세금계산서·현금영수증의 한계와 포트원(PortOne) 연계

#### 6.1 한국 세무 문서 발행의 공백

- **해외 B2C/B2B 수출 매출**: 한국 구매자가 없으므로 발행할 **세금계산서가 없습니다.** (영세율이 적용되는 특정 요건에서만 전자세금계산서에 "영세율" 유형을 선택해 발행하나, 익명 해외 최종소비자 대상에는 일반적으로 해당하지 않음.)
- **현금영수증 / 세금계산서 의무는 국내 구매자에게 귀속**됩니다. 그런데 Paddle은 해외 seller-of-record로서 **한국 고객에게 한국 세금계산서·현금영수증을 발행하지 않습니다.** 따라서 **한국 고객을 Paddle로 결제받으면** 본인은 그 거래에 대한 한국 국내 세무문서 발행 의무(세금계산서/현금영수증)를 Paddle을 통해 **충족할 수 없습니다.**

#### 6.2 포트원(PortOne) 스위치 연계 `[추론]`

포트원은 약 25개 국내외 PG를 통합하고 **국내 PG를 통해 원화(KRW)로 정산**하며 **한국 세금 문서를 발행**하는 한국 결제 연동/정산 레이어입니다.

실무적 동기(아래는 **추론**이며 단일 권위 출처로 확인된 바 없음): **한국 고객용으로는 포트원, 글로벌 고객용으로는 Paddle**을 병행(또는 Paddle→포트원 전환)하여, Paddle(해외 MoR)이 제공하지 못하는 **한국 세금계산서/현금영수증 발행과 국내 원화 정산**을 한국 고객 거래에 한해 회복하려는 것입니다.

- **`[불확실]`** "Paddle→포트원 전환" 의 구체적 근거는 포트원의 국내 세무문서 기능과 MoR의 문서 공백으로부터 **추론**한 것이며, 이 전환 시나리오를 명시적으로 문서화한 출처는 확인되지 않았습니다.

### 7. 요약 — 확인된 사항 vs 세무사 확인 필요 사항

**확인됨(VERIFIED)**
- Paddle의 MoR 역할: 해외 VAT/GST 전부 계산·징수·납부, 본인은 해외 간접세 의무 없음.
- 본인은 Paddle **총매출**을 한국 사업소득(종소세/법인세)으로 신고해야 함.
- 국내 매출과 해외 매출은 분리 신고.
- 공급시기 기준 환율 환산 규칙.
- Paddle은 Statement + Reverse Invoice(미국/그 외 분리) + Remittance Advice 제공.
- 신고 기간: 부가세 7/25·1/25, 종소세 5/31, 법인세 결산월+3개월.
- 영세율 증빙 세트(외화입금증명서·외화획득명세서·영세율매출명세서).

**세무사 확인 필요 (`[불확실]`)**
1. **Paddle 정산금의 영세율 적용 여부** — PayPal 유권해석(서면-2016-법령해석부가-3979)이 중개자/원화 전환 수취에 **불리**하며 Paddle도 유사. 영세율 비적용/과세대상 제외일 수 있으며 자동 0%가 **아님**.
2. **Paddle→포트원 전환의 구체적 근거** — 포트원의 한국 세무문서 기능과 MoR 공백으로부터 **추론**.
3. **해외 MoR 경유 시 국내 고객 세금계산서/현금영수증 처리**.

> 다시 강조합니다: 위 내용은 일반 정보이며, 실제 신고 전 반드시 **한국 세무사**의 확인을 받으시기 바랍니다.

---

## 이벤트 → 라이선스 상태 매핑

엔타이틀먼트는 **이벤트 이름이 아니라 페이로드 상태**(`data.status` / 트랜잭션·조정 상태)로 결정한다. 이벤트 이름은 핸들러만 고른다. 아래 표는 webhook Worker가 KV `license:{app_user_id}.state`에 기록하는 값과 `/verify` 접근 결정을 정리한다.

| 트리거 이벤트 | 페이로드 신호 | KV `state` | `/verify` 접근 | 비고 |
|---|---|---|---|---|
| `transaction.completed` | (트랜잭션 완료) | `active` | 부여 (200) | 영구(perpetual) 구매 권위 이벤트 |
| `subscription.created` | `data.status = trialing` | `active` | 부여 (200) | 트라이얼도 즉시 부여. `activated` 대기 안 함 |
| `subscription.created` | `data.status = active` | `active` | 부여 (200) | |
| `subscription.activated` | `data.status = active` | `active` | 부여 (200) | |
| `subscription.updated` | `data.status` 값 따름 | status 매핑값 | status 따름 | 갱신·업/다운그레이드·재개의 catch-all |
| `subscription.past_due` / `updated` | `data.status = past_due` | `past_due` | 부여 (200) | 접근 유지 + 경고 배너 권장 |
| `subscription.paused` / `updated` | `data.status = paused` | `paused` | 거부 (403) | |
| `subscription.canceled` / `updated` | `data.status = canceled` | `canceled` | 거부 (403) | `scheduled_change`만 설정 시 status는 여전히 `active` → 거부 안 함 |
| `adjustment.created` / `updated` | `action = refund`, `status != rejected` (전액) | `refunded` | 거부 (403) | `refund.*` 이벤트는 없음. 환불은 adjustment로만 |
| `adjustment.created` / `updated` | 부분 환불 / 크레딧 / 비환불 | (변경 없음) | 변경 없음 | 접근 유지 |
| 기타 / 미상관 / 중복 | — | (변경 없음) | — | 200 no-op (라이선스 미생성) |

> 정규화 규칙: webhook Worker는 `trialing`을 `state="active"`로 정규화해 기록하므로, `/verify` Worker와 Tauri 클라이언트의 접근 게이트(`state ∈ {active, past_due}`)에서 트라이얼 사용자도 일관되게 부여된다. `/verify` Worker의 `ENTITLED_STATES`는 방어적으로 `trialing`도 포함하지만, 정규화 덕에 레코드 `state`에는 `trialing`이 남지 않는다.

---

## 한계 / 주의

- **정규화(canonicalization) 발산이 최대 위험.** Ed25519 서명 메시지는 6키 고정 순서 compact JSON이다. Worker(JS `JSON.stringify` 또는 수동 직렬화)와 클라이언트(Rust `serde_json::to_vec` 또는 수동 직렬화)가 **비-ASCII `app_user_id`/`state`를 포함해 바이트 단위로 동일**해야 한다. escape 규칙·키 순서가 어긋나면 정당한 서명이 거부된다. 채택 전 골든 벡터로 양측 바이트 일치를 고정하라. 견고한 대안은 Worker가 정규 assertion 문자열을 그대로 내려주고 클라이언트가 그 문자열 위에서 검증하는 것이다.
- **KV는 강한 락이 아니다.** 최종적 일관성(전파 최대 60초), last-write-wins, 동일 키 1 write/sec(초과 시 429). `event_id` 멱등성·기기 카운팅·nonce single-use는 모두 best-effort다. 엄격한 exactly-once가 필요하면 Durable Objects로 이전하라.
- **replay tolerance 300초는 운영상 선택**이며 Paddle 문서값(5초)이 아니다. 큐·프록시 클럭 스큐를 흡수하려는 값이므로, 보안 요구가 높으면 줄이고 테스트 경계값도 함께 조정하라.
- **adjustment enum 미확정.** `isFullRefund`가 의존하는 `action`/`status` enum 값(`approved`/`pending_approval`/`rejected` 등)과 부분환불 식별 필드는 verbatim 확인되지 않았다. 라이브 연동 전 adjustment 레퍼런스에서 실제 값을 확인하고 보정하라. 또한 `adjustment.*`는 `custom_data` echo가 보장되지 않아 `order:` 인덱스·`customer_id` 역조회 보강이 필요할 수 있다.
- **런타임/버전 미확정 항목.** Workers의 Ed25519 `crypto.subtle` 지원(`compatibility_date`/flag 필요 여부, `d`-only JWK 수용 여부), `reqwest` 0.13 기본 TLS 백엔드, `keyring` v4 정확한 메서드명(`delete_credential` vs `delete_password`), 라이브 API 호스트 문자열, Paddle 결제수단 snake_case 식별자 철자 — 모두 배포 전 핀한 버전/공식 페이지에서 재확인하라.
- **라이브 베이스 URL·결제수단 활성화는 대시보드 의존.** `https://api.paddle.com`은 고신뢰값이나 인증 문서에서 재인용 미확인. 한국 결제수단(KakaoPay/Naver Pay/Samsung Pay/Payco)은 코드가 아니라 대시보드 토글로만 활성화되며, KRW 가격 + KR 고객 주소 두 조건이 충족돼야 노출된다.
- **한국 세무는 일반 정보일 뿐.** 영세율 적용 여부, 외화입금증명서 확보, 내수 고객 세금계산서/현금영수증 처리, Paddle→포트원 전환은 모두 미확정이거나 추론이다. 신고 전 반드시 한국 세무사 확인을 받으라.

---

## 부록: 참고 출처
- Stripe 한국 미지원: https://www.onesafe.io/blog/does-stripe-work-in-korea
- Paddle 지원국(한국 포함): https://developer.paddle.com/concepts/sell/supported-countries-locales/
- Lemon Squeezy 정산/Stripe 인수: https://www.lemonsqueezy.com/blog/2026-update
- 한국 SaaS 결제 전략: https://www.mashupventures.co/contents/global-payment-solutions-for-saas-startups
- 포트원 국내 PG 비교: https://blog.portone.io/opi_pg-comparison2026/
