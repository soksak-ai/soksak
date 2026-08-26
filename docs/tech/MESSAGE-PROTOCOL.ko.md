---
kind: translation
status: active
canonical: ./MESSAGE-PROTOCOL.md
---

# 메시지 프로토콜

어떤 전송이 담든, 모든 명령 교환의 형태입니다. 전송선 자체는 CONTROL-PROTOCOL.ko.md 이고, 이 문서는
그 위를 지나는 것입니다.

에이전트와 원격 클라이언트는 여기서 일급 호출자이며 나중에 덧붙인 것이 아닙니다. 형태를 고정한 이유가
그것입니다. 추측해야 하는 호출자는 명령마다 다른 구조를 읽고 명령마다 파서를 하나씩 쓰게 됩니다.

## M1. 요청

```
{ command: string, params: Record<name, value> }
```

`params` 는 명령이 선언한 `ParamSpec`(`{type, description, required?, enum?, default?}`)에 대해
중앙에서 검증합니다. 선언되지 않은 키는 거부하고, required 는 강제하며, default 는 채웁니다. 핸들러는
자기 인자를 스스로 검증하지 않으므로, 두 핸들러가 "없음" 의 의미를 다르게 볼 수 없습니다.

## M2. 응답 — 성공과 실패가 같은 형태

```
{ ok: boolean, code: string, message: string, window: string, data?: object, hint?: [{cmd, why}] }
```

성공과 실패가 형태를 공유하며 `data` 와 `hint` 만 선택입니다.

- `ok` 는 명시적입니다. 오류가 비었다는 것으로 추론하면 null 결과와 조용한 실패가 같은 payload 가
  됩니다.
- `code` 는 산문이 아니라 이름입니다. 호출자가 분기하는 값입니다.
- `message` 는 사람을 위한 것입니다. 무엇이 없고 누가 다음에 무엇을 해야 하는지 적습니다
  (`refusalMessages.test.ts` 의 문체 규칙 참조).
- `window` 는 답한 창의 이름입니다. 이것이 없으면 다중 창 프로세스의 응답을 귀속할 수 없습니다.
- `hint` 는 후속 명령을 제안합니다. 지시가 아니라 제안이며, 판단은 받는 쪽 — 사람이든 에이전트든 —
  이 합니다.

## M3. 진행 — 스트리밍 명령에만

```
{ kind: "command.progress", command, seq, ts, delta }
```

오래 걸리는 명령은 결과만이 아니라 지금 무엇을 하는지 보고합니다. `delta` 에는 내용만 담습니다 —
URL, 노드 제목 — 그리고 감싸는 말은 넣지 않습니다. 피드가 `<command>: <delta>` 로 렌더링하므로 명령
이름이 이미 문맥을 제공합니다.

단발 명령은 delta 를 내보내지 않습니다. 출처는 사이드카 이벤트, 터미널 출력, 에이전트 스트리밍입니다.

## M4. 상관

한 turn 에서 파생된 모든 것은 그 turn 의 id 를 `parentId` 로 포함합니다. spawn 환경
(`SOKSAK_PARENT`)이 `sok` → 소켓 → registry 를 거쳐 그것을 전달하므로, 자식 프로세스가 실행한 명령이
그것을 유발한 turn 으로 묶입니다.

parent id 가 없으면 소비자는 창, 명령 이름, 시간 창으로 묶습니다. 그것은 휴리스틱이며 휴리스틱이라고
문서화되어 있습니다.

## M5. 메시지는 명령이 소유한다

메시지는 답하는 명령이 작성합니다. 전송이나 소비자가 작성하지 않습니다. 자기가 만들지 않은 결과에
자기 문장을 쓰는 소비자는, 명령 동작이 바뀌고 아무도 그 소비자를 갱신하지 않는 첫 순간에 틀립니다.
