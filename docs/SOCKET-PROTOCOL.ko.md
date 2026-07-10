# 소켓 프로토콜

앱 제어 소켓의 와이어 계약 — 프레이밍, 요청 봉투, 버전 협상, 호환창. 모든 소켓 소비자(`sok`,
MCP, 원격 포워더, E2E 하니스)가 이 계약을 말한다. 그 위에 실리는 명령 페이로드는
[MESSAGE-PROTOCOL.ko.md](MESSAGE-PROTOCOL.ko.md)가 규정한다.

**단일 진실**: `soksak-protocol` 크레이트(`src-tauri/protocol`). 버전 상수, 호환창, 순수 판정
함수가 여기 산다. 앱과 모든 클라이언트가 이 크레이트에 의존한다 — 아무도 상수를 베끼지
않으므로, 와이어 양쪽이 무언으로 어긋날 수 없다.

## 1. 전송과 프레이밍

- 서버는 `<identity 홈>/<identifier>.sock`(예: `~/.soksak-dev/com.soksak.dev.sock`)의 Unix
  도메인 소켓, 퍼미션 `0600`.
- 양방향 모두 한 줄에 JSON 객체 하나. 요청 한 줄은 같은 연결에서 응답 한 줄을 낳고, 요청의
  `id`를 그대로 싣는다.
- `events.subscribe`는 확인 응답 1회 후 연결을 push 스트림으로 전환한다 — 연결 수명이 곧
  구독 수명이다.
- JSON-RPC 서버는 전송 시임(`src-tauri/src/ipc.rs`의 `IpcListenerSeam` / `IpcConnection`)을
  통해서만 OS에 닿는다. Windows named pipe 전송은 같은 시임에 꽂힌다 — 전송이 바뀌어도
  프로토콜 코드는 변하지 않는다.

## 2. 요청 봉투

```
{ id?, method, params?, protocol?, pane?, window?, parent?, origin?, timeoutMs? }
```

| 필드 | 의미 |
|---|---|
| `id` | 응답 줄에 그대로 반향된다 |
| `method` | 명령 이름 — 앱 command registry 가 해소한다 |
| `params` | 명령 매개변수(MESSAGE-PROTOCOL §1) |
| `protocol` | 이 클라이언트가 말하는 소켓 프로토콜 판. **부재 = 0**(협상 이전 레거시 클라이언트) |
| `pane` / `window` / `parent` / `origin` / `timeoutMs` | 타겟팅·상관 컨텍스트(AI-CONTROL.md) |

미지의 필드는 양쪽 모두 무시한다 — 이 관용이 창 안에서 새 피어가 옛 피어와 대화할 수 있는
근거다.

응답은 MESSAGE-PROTOCOL §3 의 응답 봉투(`{ok, code, message, window, data?, hint?}`)에 반향된
`id`를 더해 따른다.

## 3. 협상 — `system.hello`

`system.hello`는 dispatch 이전, 프론트 미경유로 **transport 레벨에서 즉답**된다. webview 가
행이어도 답한다 — "앱이 살아있나, 같은 판을 말하나"의 첫 진단 명령이다.

```
{ "ok": true, "protocol": 1, "minClientProtocol": 0, "appVersion": "0.1.0",
  "identity": "com.soksak.dev", "pid": 4242, "startedAt": 1700000000000,
  "capabilities": ["hello.v1"], "id": … }
```

| 필드 | 의미 |
|---|---|
| `protocol` | 앱이 말하는 소켓 프로토콜 판 |
| `minClientProtocol` | 앱이 아직 섬기는 가장 오래된 클라이언트 판(floor) |
| `appVersion` | 앱 패키지 버전(사람 진단용 — 호환 판정에 절대 쓰지 않는다) |
| `identity` | 앱 정체성(`com.soksak.{dev\|debug\|app}`) — 어느 환경이 답했는지 확인 |
| `pid` / `startedAt` | 프로세스 id 와 서버 기동 시각(ms epoch) — 재시작 감지 |
| `capabilities` | transport 레벨 행위만(`hello.v1`). 기능 발견은 `state.commands` 소관 — 이 목록은 기능 카탈로그가 되지 않는다 |

`system.hello`는 버전 게이트에서 면제된다: 스큐된 클라이언트가 두 판 숫자를 배울 유일한
통로가 hello 자신이다.

협상 이전 앱은 `system.hello`를 프론트로 흘려 `{ok:false, code:"UNKNOWN_COMMAND"}`로 답한다 —
클라이언트는 이를 "앱이 판 0을 말한다"로 읽는다.

## 4. 호환창

상수(`soksak-protocol`):

| 상수 | 값 | 의미 |
|---|---|---|
| `SOCKET_PROTOCOL_VERSION` | 1 | 이 빌드가 말하는 판 |
| `MIN_COMPATIBLE_CLIENT_PROTOCOL` | 0 | 앱이 섬기는 가장 오래된 클라이언트 |
| `MIN_COMPATIBLE_SERVER_PROTOCOL` | 0 | 클라이언트가 수용하는 가장 오래된 앱 |

판정은 순수하고 대칭이다(`evaluate_compat(own, floor, peer)`): floor 미만의 피어는
`PeerTooOld`, 자기 판을 넘는 피어는 `SelfTooOld`. **부재 = 0** 규칙 하나가 계약의 양면을
나른다: floor 가 0인 동안 레거시 피어는 창 안에 머물고, 훗날 floor 를 올리면 새 장치 없이
그들이 차단된다.

창 밖의 요청은 dispatch 에 도달하지 못한다. transport 에서 표준 실패 봉투로 멈춘다:

```
{ "ok": false, "code": "VERSION_SKEW",
  "message": "the client speaks socket protocol 999 but the app speaks up to 1 — update the app (…).",
  "data": { "appProtocol": 1, "minClientProtocol": 0, "clientProtocol": 999 }, "id": … }
```

`message`는 방향 명시 한 문장이다: 낡은 쪽, 두 판 숫자, 해결 명령을 담는다. `data`는 원시
숫자를 싣는다 — 에이전트가 스스로 판정할 수 있게. 스큐 거부는 여느 라우팅 실패처럼 활동
피드에 기록된다.

**floor 인상은 입법이다.** 어떤 floor 도 기능 변경의 부수효과로 오르지 않는다 — 출시된
피어를 버리는 일은 어느 버전을 버리는지 명시한 전용 커밋을 요구한다.

## 5. 판 인상 규칙

흔한 경우는 `SOCKET_PROTOCOL_VERSION`을 올리지 않는다:

- 요청·응답의 **추가적 선택 필드는 인상 없음** — 미지의 필드는 무시된다.
- **새 메서드는 인상 없음** — 미지의 메서드는 이미 타입 에러로 답한다.
- **`message`/`hint` 문구 변경은 인상 없음** — 산문은 계약이 아니다.

기존 필드의 타입·의미가 바뀌거나 필수가 될 때, 한 줄 JSON 프레이밍이나 응답 봉투 형태가
바뀔 때, 기존 메서드의 의미가 바뀌어 옛 피어가 응답을 오독하게 될 때 올린다.

## 6. 클라이언트 규율

- 모든 요청이 `protocol`을 선언한다. `sok`의 전 봉투는 순수 빌더 하나(`build_request`)에서
  태어난다 — 단발 명령, events 구독, MCP 위임이 전부 선언되고, 잊을 두 번째 지점이 없다.
- `sok hello`는 협상을 보내고 응답을 stdout 에 순수 JSON 으로, 판정 문장을 stderr 로 내며,
  스큐면 비영 종료한다 — 스크립트는 종료코드로 판정한다.
- 클라이언트는 `MIN_COMPATIBLE_SERVER_PROTOCOL`을 floor 로 같은 대칭 판정을 적용한다:
  hello 이전 앱은 판 0(floor 가 0인 동안 호환), 더 새 판을 말하는 앱은 클라이언트 자신을
  낡은 쪽으로 명시하며 거부한다.
