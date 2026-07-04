# 메시지 프로토콜

soksak이 실행하는 모든 명령(코어·플러그인·사이드카 노출)의 단일 계약. 명령은 **요청 → (진행) → 응답** 교환이고, 세 부분 모두 형태가 고정돼 있어 어떤 소비자(UI·오케스트레이터·`sok` CLI·MCP·폰)든 추측 없이 읽는다. 명령 핸들러가 제각각 형태를 반환하는 게 아니라 이 표준을 따른다.

AI·원격 클라이언트가 1급 소비자다 — 그래서 모든 명령이 표준·관찰가능한 답을 내야 하고, 요청·진행·응답 각각이 고정된 한 형태만 가진다.

## 1. 요청 봉투

```
{ command: string, params: Record<이름, 값> }
```

`params`는 명령의 `ParamSpec` 스키마(`{type, description, required?, enum?, default?}`)로 중앙 `validate`가 검증한다 — 선언 안 된 키 거부, 필수 강제, 기본값 채움. 이 절반은 코어 ~158 + 플러그인 ~328 명령에서 이미 표준이다.

## 2. 진행 델타 (선택, 스트리밍만)

장시간 명령은 최종 답만이 아니라 *무엇을 하는 중인지*를 흘린다 — textdelta/thinking 개념.

```
{ kind: "command.progress", command, seq, ts, delta }
```

`delta`는 사람이 읽는 한 줄 또는 구조화 조각으로 활동 허브에 publish된다. 출처: ① 사이드카 이벤트(engine `event` 채널·service NDJSON `ev` 스트림) — **소비 플러그인이 표준 progress로 변환해 publish**(코어는 blind relay 유지, A14 준수); ② 터미널 출력; ③ AI thinking/stream. 단발 명령은 델타를 안 낸다.

## 3. 응답 봉투 (대칭)

```
{ ok: boolean, code: string, message: string, data?: object }
```

성공·실패가 **한 형태**를 공유한다 — `data`만 선택.

| 필드 | 의미 |
|---|---|
| `ok` | 성공/실패 |
| `code` | 결과 코드 — 성공 `"OK"`(또는 도메인 `CREATED`/`NOOP`/`UNCHANGED`…), 실패 닫힌 `ErrCode` 열거형. `error` 문자열 방언 폐기 |
| `message` | 사람이 읽는 한 줄 **표준 답변**(성공·실패 모두) — 버블이 이걸 렌더. 명령이 제공하고, 코어는 추측하지 않는다 |
| `data` | 기계 페이로드(선택, **중첩** — 평면 스프레드 아님, 예약 봉투키와 충돌 없음) |

`message`는 `CommandSpec.summarize?(data) => string`에서 온다. 없으면 `execute`가 `code`를 `message`로 에코(`"OK"`)한다 — 파생/파싱 변환이 아니라 코드 에코. `execute`는 모든 핸들러 반환(자유 객체 또는 `{ok:false,…}`)을 이 봉투로 정규화한다: 예약키 분리, 나머지는 `data`에 중첩.

성공·실패는 대칭이다 — 관찰이 1급이라, 성공한 명령도 관찰자에게 `code`와 `message`를 진다.

## 사이드카 경계 (A14)

사이드카 자체 wire(engine C-ABI / service stdio / iroh socket)는 코어가 계약상 해석하지 않는다 — 코어는 의미 모르는 바이트를 릴레이한다. **표준은 명령 표면**(코어+플러그인+사이드카노출명령)을 다스리지 사이드카 wire가 아니다. 사이드카를 앞세우는 플러그인 어댑터(`main.js`·`adapter.ts`)가 ① 사이드카 이벤트를 표준 `command.progress`로 변환, ② 최종 결과를 응답 봉투로 매핑한다. 세 사이드카 wire를 하나로 통일하는 건 범위 밖(A14); 진행 노출로 "사이드카가 무엇을 했는지"는 확보한다.

## 강제

- **코어 `execute`**가 핸들러 반환을 봉투로 정규화하고, `summarize`(또는 `code` 에코)에서 `message`를 주입하며, `ok`/`code`/`message`를 예약한다.
- **plugin-spec / doctor**가 플러그인 명령이 봉투(`ok`/`code`+`message`)를 내고 `summarize`를 제공하는지 검사한다. runbook의 `ok()/err()` 쌍이 준거.

## 마이그레이션

M1(이번)은 표준 확립 — 봉투 타입, `summarize` 계약, `command.progress` kind, 오케스트레이터 버블(요청→델타→message), doctor 골격, 문서, 대표 코어 명령 몇 개의 `summarize`. M2는 코어 전 명령, M3은 플러그인 통일(`error`→`code`/`message` + `summarize`), M4는 사이드카 어댑터(이벤트→progress).

예약키 규칙(과거: 핸들러 데이터에 top-level `id`/`ok`/`code`/`message` 금지)은 이제 구조적이다 — 핸들러는 자유 데이터를 반환하고, `execute`가 `data`에 중첩하며, 봉투가 예약키를 소유한다.
