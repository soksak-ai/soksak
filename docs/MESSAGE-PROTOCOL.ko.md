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

`delta`는 핵심 내용(URL·노드 제목)만 싣고 프레임 단어는 두지 않는다 — 피드가 `<명령>: <delta>`로 렌더하므로 명령명이 문맥을 주고 델타는 번역이 필요 없다(P0). 활동 허브에 publish된다. 출처: ① 사이드카 이벤트(engine `event` 채널·service NDJSON `ev` 스트림) — **소비 플러그인이 표준 progress로 변환해 publish**(코어는 blind relay 유지, A14 준수); ② 터미널 출력; ③ AI thinking/stream. 단발 명령은 델타를 안 낸다.

델타의 턴 접합은 두 층이다: `payload.parentId`가 있으면 **정확 상관**(§4)으로 그 세트에 접히고, 없으면 소비자(피드)가 같은 창+명령명+실행 시간창 휴리스틱으로 접는다 — 상관 id 없는 세계(플러그인 `events.progress`)의 후방 호환.

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

`message`는 **명령이 소유한다** — 필수 `CommandSpec.message(data) => string`. 추측 계층(형태 파생)·`code` 에코 폴백은 없다(모든 명령이 자기 답을 안다). 문장은 키 테이블(i18n `msg.<이름>`)에서 `tmsg` 로 현재 언어 해소한 값이다 — 언어 추가 = 테이블 열 추가(P0). `execute`는 핸들러 반환을 봉투로 정규화한다: 예약키 분리, 나머지는 `data`에 중첩, `message`는 `spec.message(data)`.

성공·실패는 대칭이다 — 관찰이 1급이라, 성공한 명령도 관찰자에게 `code`와 `message`를 진다.

### 낭독 — 축은 message(눈)/speak(귀) 둘뿐

모든 명령 실행은 기본적으로 낭독 대상이다: 활동로그 소비자(TTS 낭독 플러그인)가 엔트리의 유효 문장을 소리 내어 읽는다. 유효 문장은 계측 지점에서 한 번 계산되어(`effectiveTts`, registry) 활동 엔트리 `payload.tts`로 흐른다.

- **낭독은 opt-in**: 명령이 `CommandSpec.speak(outcome)`를 선언해야만 낭독된다 — `message` 폴백 없음. `message`(눈)는 피드에 언제나 뜨지만, 읽기·진단 명령까지 전부 낭독하면 소음이라 낭독할 값어치는 명령이 정한다. `speak` 있으면 성공·실패 불문 그 반환이 낭독 문장, 빈 문자열(`""`) = 침묵, `speak` 없으면 침묵.
- **귀의 문장에는 경로·식별자(창 label·해시·URL)를 싣지 않는다** — 그것은 눈의 정보(`message`)다. 예: `window.snapshot` — summarize 는 저장 경로, speak 는 "화면을 저장했어요".
- 낭독을 수행하는 명령(`say` 류)은 `speak: () => ""` — 낭독→기록→낭독 무한 전파의 유일한 차단점.
- 소비자는 자체 읽기/건너뛰기 규칙을 만들지 않는다: `payload.tts`가 있으면 도착 순서대로 읽고(스킵 없음), 없으면 침묵. `turn.ended`(AI 발화)에는 `tts`가 실리지 않는다.
- 과거의 `CommandSpec.tts`(boolean)와 봉투 `tts` 오버라이드는 폐기 — speak 하나가 대체한다(파편화 제거).

### 표시 미디어 (선택)

렌더할 내용을 가진 응답은 스스로 선언한다 — 소비자는 data 키를 냄새 맡지 않는다:

```
media?: { kind: string /* MIME, 예 "image/png" */, base64?: string, path?: string }
```

`window.snapshot`은 두 모드 모두 `media`를 싣는다(파일 모드=`path`, base64/rect 모드=`base64`). 피드는 이를 인라인 렌더한다 — 저장된 캡처가 경로 문자열이 아니라 이미지로 보인다(`path`는 `read_file_base64`로 지연 로드). 인라인 이미지를 클릭하면 확대된다(라이트박스, 클릭/ESC 닫기).

## 4. 상관(parentId) — 대화 세트

한 대화 턴에서 비롯된 모든 실행은 그 턴으로 묶인다: **대화 → 명령 → 답변이 하나의 활동 세트다.**

```
chat.prompt { text, turnId }                          ← 세트 개설(사용자 자연어)
command.progress { delta, parentId: turnId }          ← 진행(에이전트 스트림, 뭉치 발행)
command.executed { …, parentId: turnId }              ← 턴이 낳은 명령 실행들
chat.answer { text, parentId: turnId, ok, code }      ← 세트 닫음(에이전트 최종 답변)
```

- **운반**: 오케스트레이터(`orchestrator.ask`)가 에이전트를 스폰할 때 env `SOKSAK_PARENT=turnId`를 주입한다. `sok`이 이를 요청 봉투 meta `parent`로 싣고(`SOKSAK_PANE`/`SOKSAK_WINDOW`와 같은 모델), 소켓 → executor `ctx.parent` → registry trace `parentId` → 활동 엔트리 `payload.parentId`로 관통한다. MCP(`soksak.run`)도 같은 지점을 지나므로 자동 커버.
- **정박**: 세트의 표시 단위는 부모(`chat.prompt`)다 — 카드 가시성은 부모 기준이며, 자식이 다른 창(w-*)의 실행이어도 세트는 완전체로 보인다. 부모가 링/버퍼 밖으로 밀려난 고아 자식은 단독 표시된다(유실 없음).
- **순서는 사실 그대로**: 중단(stop) 뒤 이미 발사된 실행이 늦게 도착하면 답변 뒤에 그대로 표시된다 — 세트는 seq 순의 기록이지 연출이 아니다.
- **낭독과의 관계**: `chat.prompt`(사용자 자신의 말)·`chat.answer`(AI 발화)·진행 델타에는 `tts`가 실리지 않는다 — 침묵. 턴 안의 `command.executed`는 각자의 tts 스펙(§3)대로 낭독된다.
- **계측 제외 선언** `CommandSpec.trace: false` — 동일 사실의 이중 기록 방지 전용(§5 R2): `orchestrator.ask`(chat.prompt/answer 가 그 턴의 대표 기록)만 선언한다.

## 5. 활동의 자격 — 기록과 노출은 다른 축이다

- **R1 거짓은 소멸** — 일어나지 않은 일의 표식은 기록이 아니라 오염이다. 방출기에서 원천 제거한다: D(종료)는 C(실행)와 짝일 때만(shell-integration.zsh — 첫 프롬프트·빈 Enter 는 D 를 내지 않는다), 부트 복원은 project.created 가 아니다(diff 재씨딩).
- **R2 사실은 전량 기록** — 실제로 실행된 것은 전부 기록된다: 내부 조회(project.recent·백필 activity.recent)·낭독 실행(say)·스케줄 발화 포함. `trace:false` 의 유일한 정당 사유는 **동일 사실의 이중 기록 방지**(`orchestrator.ask` — chat.prompt/answer 가 그 턴의 대표 기록)다. 소음 억제 목적의 trace:false 는 금지 — 그건 노출 축의 몫.
- **R3 노출이 선별** — origin(발화자)이 표시·낭독을 결정하지 기록을 결정하지 않는다: 생략=사람(정상 표시, tts 스펙대로 낭독) / `"schedule"`=예약된 의도(흐림+"스케줄" 라벨, 무낭독) / `"internal"`=자동 행위·자기 조회(흐림, 무낭독). 시스템 유래(origin 보유)는 registry 계측 지점에서 tts 가 소거된다 — 낭독→기록→낭독 루프는 이 축이 끊는다(기록 자체는 선형이라 되먹임이 아니다). 환경의 사실(view.activated·turn.ended)은 조용한 한 줄, 무낭독.
- **R2a 기록은 관찰 요약** — `command.executed` 는 응답 `data` 를 싣지 않는다(command·code·message·paramKeys·media 참조·상관 축이 전부다). 실측 사고: 조회 기록이 조회 결과(그 안의 이전 기록까지)를 물어 75MB/행으로 자기증식 → json 파스 226MB malloc → 앱 즉사. 영속본은 추가로 media.base64 를 스트립하고 행 크기 불변식(256KB, 초과 = 상관 축만 남긴 요약 강등)을 강제한다 — 라이브(링·이벤트)만 원본이다.
- **R4 보관 제로섬 해소** — 저신호(origin 보유)는 신호와 영속 캡을 다투지 않는다: scope `app`(신호)/`app-low`(저신호) 별도 보관(각 5000). 링(라이브 뷰 2000)은 시간창이 본질이라 혼합 — 역사 보증은 영속의 몫. seq 재개는 전 scope 최댓값.

origin 운반: Rust 내부 발화(스케줄러)는 `request_command(origin:"schedule")`, 플러그인 자동 행위는 `app.commands.execute(name, params, {origin:"internal"})` 자기 선언, 핸들러의 중첩 실행은 `inv.execute` 상속 — ctx → trace → 엔트리 payload.origin 으로 관통한다. 새 자동화 부류는 origin 값 추가로 확장한다.

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
