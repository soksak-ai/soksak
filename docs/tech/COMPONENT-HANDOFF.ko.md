---
kind: translation
status: active
canonical: tech/COMPONENT-HANDOFF.md
scope: workspace
---

# Component handoff

사이드카 업그레이드는 실행 중 프로세스를 교체합니다. 프로세스가 무엇을 들고 있느냐가 교체 비용을
결정합니다. 이 문서는 사이드카마다 하는 선언 하나, 교체 전에 코어가 수행하는 검사 하나, 그리고 각
결과에 대해 코어가 하는 일을 정의합니다.

wire 정의는 각 contract 저장소가 소유합니다. manifest 필드는 `soksak-spec` 이 소유합니다. 이 문서는
둘이 합의하는 축과 코어의 동작을 정의하고, 각 부분의 소유 저장소를 명시합니다.

## H1. 사이드카마다 선언하는 축 하나

사이드카는 교체에서 자기 상태가 얼마나 살아남는지 선언합니다. 이 값은 버전이 아니라 capability 이므로
수준을 추가해도 migration 이 생기지 않습니다.

| 수준 | 의미 |
| --- | --- |
| `none` | 교체가 프로세스의 보유 상태를 버립니다. |
| `state` | 프로세스가 상태를 직렬화하고, 후속 프로세스가 그 직렬화로 복원합니다. |
| `fds` | 프로세스가 열린 file descriptor 를 후속 프로세스에 전달하고, 후속 프로세스가 같은 kernel object 를 이어서 씁니다. |

`soksak-spec` 이 이 필드를 소유합니다. 사이드카 manifest 의 `handoff` 이며, 없으면 `none` 으로
읽습니다. 자기 빌드가 수행할 수 없는 수준을 선언하는 사이드카는 결함입니다. 코어는 선언된 수준으로
handoff 를 지시하고 완료되지 않으면 실패를 보고합니다.

`environment.json` 은 설치된 버전을 기록합니다. 수준은 기록하지 않으며, 수준은 설치된 artifact 의
manifest 에서 읽습니다.

## H2. 교체 전에 코어가 하는 검사

코어는 더 새로운 버전을 설치하려고 실행 중 유닛을 종료하지 않습니다. 교체 전에 선택된 artifact 의
선언 수준과, 실행 중 유닛이 보고하는 보유 자원 수를 읽습니다.

| 선언 | 보유 자원 없음 | 보유 자원 있음 |
| --- | --- | --- |
| `none` | 교체합니다. | 보고합니다. 교체는 명시적 요청을 기다립니다. |
| `state` | state 경로로 교체합니다. | state 경로로 교체합니다. |
| `fds` | fd 경로로 교체합니다. | fd 경로로 교체합니다. |

"보유 자원 없음" 은 유닛 자신이 보고하는 수이며, 그 플러그인이 선언한 contract 를 통해 읽습니다.
코어는 그 자원이 무엇인지 해석하지 않습니다.

`sidecar.mismatch` 는 실행 중 버전이 선택된 버전과 다른 유닛마다 한 항목을
`{ name, running, selected, handoff, attached }` 로 반환합니다. `attached` 는 유닛이 보고하는 수이며,
유닛이 그 수를 제공하지 않으면 `null` 입니다. 빈 배열이 통과 조건입니다.

`sidecar.restart` 는 유닛 이름 하나를 받고, `sidecar.mismatch` 에 없는 이름을 거부하며, 선언된 수준으로
교체를 수행합니다. 사용한 수준과 옮긴 수를 반환합니다.

## H3. state 경로

선행 프로세스가 요청을 받아 상태를 직렬화하고, 후속 프로세스가 그 직렬화로 복원합니다. 직렬화는
handoff 시점에 생성하며 주기적 snapshot 을 읽지 않습니다. 주기적 snapshot 은 그 간격만큼 낡았고 live
sequence 를 갖지 않습니다.

선행 프로세스는 후속 프로세스가 복원 완료를 보고할 때까지 계속 실행합니다. 실패를 보고하는 후속
프로세스는 선행 프로세스를 그대로 두고, 선택된 버전은 사용되지 않습니다.

터미널 미러의 이 wire 는 `soksak-contract-terminal` 이 소유합니다. 그 명세 §5 가 `rehydrate` 를 live
직렬화로 정의하고 §7 이 degraded 경로를 정의합니다. handoff 요청은 미러가 들고 있는 모든 session 에
대해 교체 시점에 한 번 취하는 같은 직렬화입니다.

## H4. fd 경로

선행 프로세스가 Unix domain socket control message 로 열린 descriptor 를 후속 프로세스에 전달하고,
kernel reference count 가 선행 프로세스 종료 후에도 각 object 를 살려 둡니다. descriptor 와 함께
선행 프로세스는 descriptor 에서 유도할 수 없는 상태를 전달합니다. session 식별자, 각 descriptor 에
적용된 크기, 각 session 이 도달한 ring 좌표입니다.

target descriptor 번호는 모든 source 및 acknowledgement descriptor 보다 위에 배치합니다. 그래야
transfer 자체가 쓰는 descriptor 와 target 이 충돌하지 않습니다. 후속 프로세스의 ring 은 전달받은
좌표에서 이어집니다. ring 이 0 에서 다시 시작하면 오류 없이 출력이 멈춥니다.

교환은 acknowledge 됩니다. 선행 프로세스는 모든 descriptor 를 들고 서비스를 계속하다가 후속 프로세스가
adoption 을 acknowledge 한 뒤에만 소켓을 닫고 종료합니다. 실패를 acknowledge 하거나 deadline 안에
acknowledge 하지 않는 후속 프로세스는 선행 프로세스를 계속 서비스하게 두고, 선택된 버전은 사용되지
않습니다.

두 동작은 wire 가 명시해야만 올바릅니다. 후속 프로세스가 adopt 한 descriptor 는 그 프로세스가 만든
것이 아니므로, 생성 프로세스를 요구하는 동작은 가정하지 말고 명시해야 합니다. wire 는 후속 프로세스가
adopt 한 descriptor 에 크기를 적용하는 방법을 정합니다. 그리고 후속 프로세스는 자기 artifact 의 버전을
보고해야 하며, 시작될 때 물려받은 environment 의 버전을 보고하면 안 됩니다. 선행 프로세스의 버전을
보고하는 후속 프로세스는 다시 불일치로 읽혀 끝없이 자기 교체를 지시받습니다.

이 wire 는 `soksak-contract-pty` 가 소유합니다. `HandoffNone`, `HandoffSafeFDs`, `pty.status` 의
`handoff` 필드는 이미 있습니다. `pty.handoff` 는 명령 이름만 선언돼 있고 요청과 응답은 아직
명세되지 않았습니다.

## H5. 저장소별 소유

| 부분 | 소유 |
| --- | --- |
| `handoff` manifest 필드와 validator | `soksak-spec` |
| fd 교환 wire, acknowledgement, deadline | `soksak-contract-pty` |
| state 교환 wire 와 acknowledgement | `soksak-contract-terminal` |
| 선언 읽기, 유닛에 수 요청, 교체 지시, 결과 보고 | `soksak-core` |
| 교환 수행 | 각 사이드카 저장소 |

코어는 선언 하나와 수 하나를 읽습니다. 유닛이 어떤 descriptor 를 들고 있는지, 직렬화에 무엇이 담기는지,
그 플러그인이 어떤 명령을 쓰는지 알지 못합니다.

## H6. Gate

| 주장 | Gate |
| --- | --- |
| 알 수 없는 수준을 선언한 manifest 는 거부된다 | `soksak-spec` manifest validator 테스트 |
| 모든 실행 버전이 선택 버전과 같으면 `sidecar.mismatch` 는 빈 배열을 반환한다 | fixture environment 에 대한 코어 테스트 |
| `sidecar.restart` 는 `sidecar.mismatch` 에 없는 이름을 거부한다 | 코어 테스트 |
| 자원을 보유한 `none` 유닛은 명시적 요청 없이 교체되지 않는다 | 코어 테스트 |
| 후속 프로세스가 실패한 선행 프로세스는 계속 서비스한다 | 수준별 contract 저장소 테스트 |
| `fds` 교체에서 session 이 살아남는다 | `soksak-contract-pty` conformance 테스트 |
| `state` 교체에서 화면이 살아남는다 | `soksak-contract-terminal` conformance 테스트 |

각 항목의 실행 순서와 현재 상태는 [`COMPONENT-HANDOFF-TASK.md`](COMPONENT-HANDOFF-TASK.md) 에
있습니다.
