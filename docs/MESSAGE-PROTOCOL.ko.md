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
| `tts` | 낭독 오버라이드(선택) — 문자열이면 `message` 대신 그 문장을 낭독, `false`면 이번 응답만 침묵. 아래 "낭독(tts)" 참조 |
| `data` | 기계 페이로드(선택, **중첩** — 평면 스프레드 아님, 예약 봉투키와 충돌 없음) |

`message`는 `CommandSpec.summarize?(data) => string`에서 온다. 없으면 `execute`가 `code`를 `message`로 에코(`"OK"`)한다 — 파생/파싱 변환이 아니라 코드 에코. `execute`는 모든 핸들러 반환(자유 객체 또는 `{ok:false,…}`)을 이 봉투로 정규화한다: 예약키 분리, 나머지는 `data`에 중첩.

성공·실패는 대칭이다 — 관찰이 1급이라, 성공한 명령도 관찰자에게 `code`와 `message`를 진다.

### 낭독(tts)

모든 명령 실행은 기본적으로 낭독 대상이다: 활동로그 소비자(TTS 낭독 플러그인)가 엔트리의 유효 문장을 소리 내어 읽는다. 유효 문장은 계측 지점에서 한 번 계산되어(`effectiveTts`, registry) 활동 엔트리 `payload.tts`로 흐른다.

- `CommandSpec.tts` — 생략 = `true`(기본: 이 명령의 실행이 낭독됨, 문장 = `message`). `false` = **응답이 무엇을 말하든 절대 낭독 금지**. 낭독을 수행하는 명령(`say` 류)만 선언한다 — 낭독→활동 엔트리→낭독의 무한 전파를 끊는 유일한 차단점.
- 봉투 `tts` — 문자열이면 이번 응답의 낭독 문장을 `message` 대신 교체, `false`면 이번 응답만 침묵.
- 소비자는 자체 읽기/건너뛰기 규칙을 만들지 않는다: `payload.tts`가 있으면 도착 순서대로 읽고(스킵 없음), 없으면 침묵. `turn.ended`(AI 발화)에는 `tts`가 실리지 않는다.

### 표시 미디어 (선택)

렌더할 내용을 가진 응답은 스스로 선언한다 — 소비자는 data 키를 냄새 맡지 않는다:

```
media?: { kind: string /* MIME, 예 "image/png" */, base64?: string, path?: string }
```

`window.snapshot`은 두 모드 모두 `media`를 싣는다(파일 모드=`path`, base64/rect 모드=`base64`). 피드는 이를 인라인 렌더한다 — 저장된 캡처가 경로 문자열이 아니라 이미지로 보인다(`path`는 `read_file_base64`로 지연 로드). 인라인 이미지를 클릭하면 확대된다(라이트박스, 클릭/ESC 닫기).

## 명령 라벨

표시 표면(오케스트레이터 피드와 이후의 어떤 소비자든)은 raw 명령 키를 보이지 않는다. 라벨 소유 구조는 언어 수와 무관하게 확장된다:

- **플러그인 명령** — 매니페스트 `contributes.commands[].title`(LocalizedText). 플러그인 저자가 소유·번역한다. 로더가 등록 스펙에 싣고, `execute` 계측이 활동 스트림(`title`)에 실어 나르므로, 그 플러그인을 로드하지 않은 창(오케스트레이터)에서도 라벨이 해소된다. 스트림은 자족적이다.
- **코어 명령** — 언어별 메시지 테이블의 `cmd.<이름>` 키. 언어 추가 = 테이블 1장 추가이며 명령 정의는 불변이다. 전체 커버리지는 `commandTitles.test.ts` 게이트가 강제한다 — 라벨 없는 코어 명령은 빌드가 실패한다.
- 둘 다 없으면 영어 `description`이 보인다 — raw 키는 어떤 경우에도 렌더되지 않는다.

## 사이드카 경계 (A14)

사이드카 자체 wire(engine C-ABI / service stdio / iroh socket)는 코어가 계약상 해석하지 않는다 — 코어는 의미 모르는 바이트를 릴레이한다. **표준은 명령 표면**(코어+플러그인+사이드카노출명령)을 다스리지 사이드카 wire가 아니다. 사이드카를 앞세우는 플러그인 어댑터(`main.js`·`adapter.ts`)가 ① 사이드카 이벤트를 표준 `command.progress`로 변환, ② 최종 결과를 응답 봉투로 매핑한다. 세 사이드카 wire를 하나로 통일하는 건 범위 밖(A14); 진행 노출로 "사이드카가 무엇을 했는지"는 확보한다.

## 강제

- **코어 `execute`**가 핸들러 반환을 봉투로 정규화하고, `summarize`(또는 `code` 에코)에서 `message`를 주입하며, `ok`/`code`/`message`를 예약한다.
- **플러그인 로더**가 등록 시점에 `summarize` 미제공 명령을 경고한다 — 표준 답변이 `code` 에코로 열화하기 때문. runbook의 `ok()/err()` 쌍이 준거. `PluginCommandSpec.summarize`는 코어 spec 으로 흘러 같은 정규화를 탄다.

## 마이그레이션

M1은 표준 확립 — 봉투 타입, `summarize` 계약, `command.progress` kind, 오케스트레이터 버블(요청→델타→message), 문서. M2는 코어 전 명령 완료. M4는 플러그인 API `events.progress(command, delta)` 발행기로 사이드카 어댑터를 배선 — workflow 플러그인이 exec-stage 자식 이벤트(`{ev:add}` 라인)를 라이브 델타로, chromium 플러그인이 open/navigate 로드를 알린다. M3(플러그인별 `error`→`code`/`message`+`summarize` 정비)은 로더 경고 아래 플러그인 단위로 진행한다.

예약키 규칙(과거: 핸들러 데이터에 top-level `id`/`ok`/`code`/`message` 금지)은 이제 구조적이다 — 핸들러는 자유 데이터를 반환하고, `execute`가 `data`에 중첩하며, 봉투가 예약키를 소유한다.
