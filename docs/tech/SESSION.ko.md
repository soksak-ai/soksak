---
kind: translation
status: active
canonical: tech/SESSION.md
scope: workspace
---

# Session

session 은 사람 또는 프로그램이 시작한 작업이며, 그것을 표시하는 것들보다 오래 삽니다. 이 문서는
session 이 무엇인지, 그 상태가 무엇인지, 그 상태를 누가 저장하는지, 그리고 창이 닫히거나 프로세스가
종료되거나 애플리케이션이 재시작될 때 session 에 무슨 일이 일어나는지를 정의합니다.

재시작을 가로질러 작업을 유지하는 다른 모든 규칙은 이 문서에 종속됩니다. 프로세스 handoff 는
session 의 상태를 유지하기 위해 존재하며, 그 자체가 목적이 아닙니다.

## S1. 정의

**session** 은 세 속성을 갖는 작업 단위입니다. 셋 모두 필수입니다.

1. **표시가 아닌 소유자를 갖는다.** 어떤 view 도 표시하지 않을 때 작업이 계속됩니다.
2. **나중의 attachment 가 필요로 하는 상태를 갖는다.** 그 상태 없이 재부착한 것은 같은 작업이
   아닙니다.
3. **한 컴포넌트가 소유한다.** 그 컴포넌트가 상태가 무엇인지와 어떻게 저장할지를 정의합니다.

view, pane, split node, window 는 session 이 아닙니다. session 이 표시되는 자리입니다. 하나의
session 은 일생 동안 그런 자리 0 개, 1 개, 또는 여러 개에 표시됩니다.

request-response 호출은 session 이 아닙니다. 나중의 attachment 가 필요로 하는 상태가 없습니다.

cache 는 session 이 아닙니다. 잃으면 시간이 들 뿐 작업이 없어지지 않습니다.

### S1-1. 포함되는 것과 제외되는 것

| 작업 | Session | 근거 |
| --- | --- | --- |
| pty 아래에서 실행 중인 shell | 예 | view 없이 프로세스가 계속됩니다. 재부착에 작업 디렉터리와 그 shell 이 낸 출력이 필요합니다 |
| browser view 의 페이지와 history | 예 | 재부착에 navigation history 와 scroll 위치가 필요합니다. 어떤 view 도 표시하지 않는 동안 소유자가 페이지 로딩을 유지합니다 |
| 터미널 화면 | 예 | 미러가 그리드를 들고 있습니다. 보관 구간을 넘어선 출력은 그것을 다시 만들지 못합니다 |
| file tree 의 펼쳐진 폴더 | 아니오 | 파일시스템에서 재구성됩니다. 잃어도 작업이 없어지지 않습니다 |
| control protocol 로 보낸 명령 하나 | 아니오 | 나중의 attachment 가 필요로 하는 상태가 없습니다 |

### S1-2. 소유자는 사이드카다

session 의 소유자는 사이드카이며, 코어가 아닙니다. 코어는 session 의 상태가 무엇을 담는지 알지
못하고 올바르게 저장할 수 없습니다.

코어는 **index** 를 소유합니다. 어떤 session 이 존재하는지, 각각을 어느 컴포넌트가 소유하는지,
각각이 마지막으로 어디에 표시됐는지입니다. 상태는 소유하지 않습니다.

### S1-3. 한 view 에는 여러 session 이 부착된다

터미널 view 는 소유자가 다른 두 session 을 표시합니다. PTY 데몬은 shell 을 소유합니다. 프로세스,
작업 디렉터리, 그 shell 이 낸 출력입니다. 터미널 미러는 화면을 소유합니다. 그 출력이 그린 그리드와,
전체 화면 프로그램이 그린 alternate screen 입니다.

둘은 짝을 이루며 합쳐지지 않습니다. 각자 자기 상태를 저장하고, 각자 복원하고, 각자의 결과를
반환합니다. 사람은 터미널 하나를 봅니다. 모델은 session 둘을 들고 있고, attachment 기록 (S2-4) 은
같은 view 에 대해 session 마다 한 행을 갖습니다.

화면은 shell 이 다시 만들어 낼 수 있는 파생물이 아닙니다. 데몬은 출력의 뒷부분을 정해진 크기만큼만
보관하며, 그 구간을 넘어서면 화면 윗부분을 그린 출력은 없습니다. 미러가 들고 있는 그리드가 그것의
유일하게 남은 형태입니다.

## S2. 식별

### S2-1. 소유자가 id 를 발급한다

session id 는 소유자가 session 을 생성할 때 발급합니다. 형식은 소유자가 정합니다. session 에 대한
모든 연산은 id 를 받습니다.

호출자는 좌표 — 어느 pane, 어느 window — 를 전달합니다. 그래야 호출자가 id 를 직접 추적하지 않고도
소유자가 "이 pane 은 이미 session 을 들고 있다" 에 답할 수 있습니다. 그 답은 id 를 동반한 예, 또는
아니오입니다. 좌표가 해결하는 질문은 이 하나뿐이며, 그 밖의 무엇도 좌표로 지시되지 않습니다.
소유자는 그 좌표를 비교할 뿐 아무것도 해석하지 않습니다. pane id 를 해석하는 소유자는 pane 이
무엇인지 정의하게 되며, 그 정의는 코어의 것입니다.

### S2-2. 좌표는 조회이지 식별이 아니다

좌표는 "여기 session 이 있는가" 에 답합니다. id 는 "어느 session 인가" 에 답합니다. 서로 다른
질문이며, 하나를 다른 하나로 쓴 컴포넌트는 좌표가 바뀔 때 session 을 잃습니다.

2026-08-16 측정: `windowLabel + "|" + paneId` 만으로 조회되던 터미널 session 은 restore 가 새 pane
id 를 발급한 뒤 재부착되지 못했습니다. shell 은 계속 실행 중이었고 scrollback 도 그대로 들고
있었습니다. daemon 자신의 id 는 영향받지 않았고, 아무도 그것을 기록하지 않았습니다.

코어는 좌표 옆에 id 를 기록합니다. 좌표로 조회해 아무것도 찾지 못하면 기록된 id 로 내려가며, 좌표가
바뀐 session 도 여전히 지시 가능합니다.

### S2-3. 수명

session id 는 session 의 일생 동안 유지됩니다. 소유자의 id 형식은 identity home 안에서, 소유자 자신의
재시작을 가로질러서도 반복되지 않습니다. 그래서 종료된 session 이 남긴 참조는 다른 session 이 아니라
아무것도 아닌 것으로 해석됩니다.

시작마다 0 에서 출발하는 카운터는 이것을 만족하지 않습니다. 두 번째 시작이 첫 번째 시작이 쓴 id 를
다시 나눠 주고, 첫 번째 시작이 남긴 기록이 두 번째 시작 자신의 것으로 읽힙니다. 소유자는 0 에서 세는
대신 id 공간을 시드합니다.

### S2-4. attachment 는 식별이 아니다

session 은 view 에 부착됩니다. attachment 는 별도 기록입니다. `{ sessionId, viewId }` 입니다.
session 이 다른 곳에 표시되면 attachment 가 바뀌고, session id 는 바뀌지 않습니다.

소유자가 들고 있으면서 attachment 가 없는 session 은 종료된 것이 아니라 **detached** 입니다.
detached 는 정상 상태입니다.

## S3. 무엇이 session state 인가

**session state** 는 나중의 attachment 가 필요로 하며 유도할 수 없는 것입니다. 그것을 들고 있는
프로세스보다 오래 삽니다.

**process state** 는 프로세스가 살아 있는 동안에만 의미를 갖는 것입니다. 그 프로세스보다 오래 살지
않으며 저장하지 않습니다.

| | Session state | Process state |
| --- | --- | --- |
| Shell — PTY 데몬 | 작업 디렉터리, shell 을 시작한 environment, 보관된 출력 뒷부분, 종료 상태 | pty file descriptor, 자식 프로세스 id, subscriber 로의 연결 |
| 화면 — 터미널 미러 | 그리드, alternate screen, 커서 위치와 모양, 프로그램이 설정한 mode | parser 가 절반만 읽은 escape sequence, 데몬으로의 socket |
| Browser view | 주소, navigation history, scroll 위치, 페이지가 복원 가능하다고 선언한 form 값 | renderer 프로세스, 네트워크 연결, compositor surface |

소유자는 자기가 들고 있는 것만 분류합니다. 데몬은 출력을 파싱하지 않으므로 그리드를 소유하지 않고,
미러는 shell 을 실행하지 않으므로 작업 디렉터리를 소유하지 않습니다.

소유자가 자기 사실을 session state 인지 process state 인지 분류합니다. 코어는 하지 않습니다.

다른 사실에서 다시 계산할 수 있는 사실은 session state 가 아닙니다. 저장하면 하나의 진실에 두 출처가
생깁니다.

### S3-1. 종료 후에 남는 것

session 이 종료되면 그 상태는 제거됩니다. 남는 것은 다른 컴포넌트가 자기 이유로 소유하고 기록한
것입니다. workspace 의 layout, 애플리케이션이 유지하는 명령 history, session 이 쓴 파일입니다.

session 자신의 상태는 session 보다 오래 살지 않습니다. 종료된 session 은 복구 대상이 아닙니다.

## S4. 저장

### S4-1. 소유자가 저장한다

소유자 사이드카가 자기 session 들의 상태를 저장합니다. 형식과 identity home 안의 위치를 소유자가
정합니다. 코어는 그 저장소를 읽지도, 쓰지도, 검증하지도 않습니다.

코어는 그것을 올바르게 저장할 수 없습니다. 상태의 형태는 소유자의 것이고, 그것을 저장하는 코어는 그
형태를 알아야 하며, 그 결합이 이 규칙이 막는 대상입니다.

### S4-2. 언제 쓰는가

소유자는 최소한 다음 시점에 씁니다.

- **생성.** 동등한 session 을 만드는 데 필요한 사실입니다. 무엇을, 어디서, 어떤 environment 로
  시작했는지입니다.
- **종료.** 최종 상태입니다.

더 자주 쓸 수 없는 소유자는 이 둘만 씁니다. 더 자주 쓰는 소유자는 통제되지 않은 종료가 보존하는
범위를 넓힙니다. 그런 종료 뒤 복구되는 상태는 마지막 쓰기 시점의 상태이며, 그 이후는 없습니다.

생성 사실만으로 session 을 다시 만드는 것은 **degraded** 복구입니다. degraded 로 보고하며, 완전한
restore 로 제시하지 않습니다.

### S4-3. 어떻게 쓰는가

쓰기는 원자적입니다. 같은 디렉터리의 임시 파일에 쓰고 대상 위로 rename 합니다. 읽는 쪽은 부분 기록을
보지 않습니다.

rename 은 프로세스 종료를 감당하며, 그것이 S6 이 복구하는 대상입니다. 전원 손실은 감당하지 않습니다.
그것은 rename 전에 임시 파일과 그 디렉터리를 sync 해야 하고, 전원 손실에도 살아남는다고 주장하는
소유자는 그렇게 합니다.

기록은 자신이 어느 session id 를 위한 것인지 명시합니다. 경로와 id 가 맞지 않는 기록을 발견한 읽는
쪽은 그 기록을 고치지 않고 거부합니다.

파싱할 수 없는 기록의 비용은 그 기록 하나입니다. 다른 session 의 기록은 영향받지 않습니다.

### S4-4. 격리

한 session 의 기록은 그 session 의 소유자만 쓰고, 그 session 만 명시합니다.

기록은 session id 에서 유도한 경로에 저장합니다. 두 session 이 한 경로에 쓰는 일은 없습니다. session
A 의 기록을 쓰는 소유자는 session B 의 경로를 열지 않습니다.

쓰기는 소유자 안에서 session id 단위로 직렬화됩니다. 한 session 에 대한 두 쓰기가 교차하지 않습니다.

기록은 session 사이에 공유되지 않습니다. 두 session 이 모두 필요로 하는 값은 그것을 소유한 쪽이
저장하고 그 소유자를 통해 읽으며, 양쪽 기록에 복사하지 않습니다.

## S5. 상태

session 은 정확히 하나의 상태에 있습니다.

| 상태 | 의미 |
| --- | --- |
| `live` | 소유자가 들고 있고 view 하나가 표시한다 |
| `detached` | 소유자가 들고 있고 어떤 view 도 표시하지 않는다 |
| `orphaned` | 어떤 소유자도 들고 있지 않고, 복구 불가로 보고한 소유자도 없다 |
| `lost` | 소유자가 자기 저장소를 읽고 그에 대한 기록을 찾지 못했다 |

종료는 session 을 끝냅니다. 종료된 session 은 더 이상 존재하지 않으므로 이 상태들 중 어디에도 있지
않으며, `session.list` 는 그에 대해 아무것도 반환하지 않습니다.

`live` 와 `detached` 는 attachment 로 갈리며 건강 상태로 갈리지 않습니다. detached session 은 자기
작업을 하고 있습니다.

`orphaned` 는 어떤 소유자도 session 을 들고 있지 않을 때 코어가 보고하는 값이며, 소유자 프로세스가
실행 중이지 않은 기간 전체를 포함합니다. 코어는 소유자의 저장소를 읽지 않으므로 (S4-1) 복구 가능한
session 과 불가능한 session 을 스스로 구분할 수 없습니다.

`lost` 는 소유자가 시작 시 자기 저장소를 읽은 뒤 반환하는 판정입니다. 코어는 그것을 유도하지
않습니다. 소유자가 그 판정을 반환할 때까지 session 은 `orphaned` 로 남으며, 소유자가 얼마나 오래
내려가 있든 마찬가지입니다.

`lost` 는 결함입니다. 그 수는 측정값이지 받아들이는 결과가 아니며, gate 는 0 을 단언합니다.

`orphaned` 와 `lost` 에는 attachment 가 적용되지 않습니다. 어떤 소유자도 들고 있지 않으므로 view 가
부착할 대상이 없습니다.

## S6. 복구

### S6-1. 소유자 프로세스가 재시작할 때

소유자는 시작 시 자기 기록을 읽고, 각 session 을 복원하고, 각각의 결과를 보고합니다.

| 결과 | 의미 | 이후 상태 |
| --- | --- | --- |
| `full` | 마지막 쓰기 시점의 상태가 복원됐다 | `detached` |
| `degraded` | 생성 사실만 있었고 동등한 session 을 만들었다 | `detached` |
| `failed` | 기록이 있으나 사용할 수 없었다 | `orphaned` |
| `lost` | 그 session 에 대한 기록이 없다 | `lost` |

자기 저장소 읽기를 마친 소유자는 코어가 그 소유자에 대해 index 에 들고 있는 모든 session 에 대해 이
넷 중 하나를 반환합니다. `full` 과 `degraded` 는 restore 의 충실도이고, `failed` 와 `lost` 는
restore 가 없는 두 방식입니다.

`full` 은 저장된 상태에 대한 것이지 프로세스에 대한 것이 아닙니다. 복원된 session 은 어느 결과에서든
항상 새 프로세스를 갖습니다.

`failed` 기록은 제거하지 않습니다. 제거하면 무엇을 잃었는지에 대한 유일한 증거가 사라지고, 읽는 쪽을
고친 뒤의 재시도는 성공할 수 있습니다. 그래서 그 session 은 `lost` 가 되지 않고 `orphaned` 로
남습니다.

코어는 `lost` session 의 index 항목을 유지합니다. 제거하면 정확성이 아니라 삭제로 수가 0 이 되며, 그
항목이 gate 가 세는 session 을 명시하는 것입니다.

### S6-2. restore 가 돌려주는 것

프로세스는 process state 이며 (S3) 어떤 저장소도 프로세스를 돌려주지 않습니다. restore 후에 도는
shell 은 생성 사실로 시작한 새 shell 입니다.

그래서 restore 는 화면을 돌려주고, 그 화면을 그린 프로그램은 돌려주지 않습니다. 전체 화면 프로그램의
alternate screen 은 그것이 남긴 그리드 그대로 돌아옵니다. 그 프로그램은 돌고 있지 않으며, 다음 키는
새 shell 로 갑니다.

이것은 모든 session 에 적용되며 소유자별 예외는 없습니다. 컴퓨터 전원 차단과 프로세스 종료는 여기서
같은 경우입니다. 둘 다 프로세스를 끝내고, 둘 다 저장된 기록을 건드리지 않습니다.

### S6-3. session 이 부착된 상태에서 소유자가 재시작할 때

소유자가 재시작할 때 `live` 인 session 에는 통지합니다. 코어는 부착된 대상에게 통지를 전달하고, 그에
대한 대응은 그 컴포넌트의 것입니다.

통지는 session id 와 restore 의 결과를 명시합니다. degraded restore 위에서 그 사실을 모른 채 이어간
소비자는 session 이 갖지 않은 상태를 보고하게 됩니다.

통지는 session 하나당 하나입니다. 짝에 부착된 view 는 각각에 대해 하나씩 받으며, 두 결과는 다를 수
있습니다. 미러가 그리드를 온전히 복원하는 동안 그 아래 shell 은 새것입니다.

### S6-4. 애플리케이션이 재시작할 때

애플리케이션 재시작은 session 을 만들지도 없애지도 않습니다. 코어는 자기 index 를 읽고, 실행 중인 모든
소유자에게, index 가 그 소유자에 대해 기록한 각 session 의 결과를 질의합니다. 그 소유자가 들고 있지
않은 session 도 포함합니다. 질의에 답하게 하려고 소유자를 시작하지는 않습니다. 소유자가 실행 중이지 않은 session 은 `orphaned` 로 남고, 코어는 그것을 소유자를
기다리는 중으로 보고합니다.

`orphaned` session 은 부착 대상이 아닙니다. 소유자가 복원하면 `detached` 가 되고 그때 부착 가능해
집니다. 코어는 모든 `detached` session 을 제공합니다.

session 은 마지막으로 어느 window, workspace, pane 에 표시됐는지와 무관하게 제공됩니다. 자기 session
이 있던 창을 닫은 사람도 그 session 을 다시 찾습니다.

## S7. 계층

애플리케이션의 구조는 애플리케이션 → 창 → 워크스페이스 → 스페이스 → 패널 → 뷰 입니다. session 은
뷰에 부착되며 그 위 어느 계층도 소유하지 않습니다.

어느 계층을 닫든 그 안에 표시된 session 은 분리됩니다. 종료되지 않습니다. 소유자가 실행 중이면
`detached` 이고 소유자가 실행 중이지 않으면 `orphaned` 이며, 둘 다 종료가 아닙니다.

session 종료는 그 session 에 대한 명시적 행위입니다.

## S8. 소비자

session 의 소비자는 사람 또는 프로그램입니다. session 도, 그 저장도, 그 복구도 둘을 구분하지 않습니다.

프로그램은 view 가 쓰는 것과 같은 `session.attach` 로 부착하고, 그 view 의 플러그인이 선언한 것과 같은
contract 로 session 의 내용을 읽습니다. 프로그램을 위한 두 번째 경로는 없습니다.

## S9. 코어가 노출하는 것

코어는 위 상태 모델이 정의하는 것을 노출하고 그 이상은 노출하지 않습니다. 명령이 존재하는 이유는 S5 의
상태를 관측하거나 바꿀 수 있기 때문이지, 어떤 화면이 그것을 원해서가 아닙니다.

| 사실 | 명령 |
| --- | --- |
| 어떤 session 이 존재하는지, 그 상태, 소유자, 마지막 attachment, 마지막 restore 결과 | `session.list` |
| session 을 view 에 부착 | `session.attach` |
| session 을 view 에서 분리 | `session.detach` |
| session 종료 | `session.close` |

상태는 넷이고 그것을 읽는 방법은 하나입니다. `session.list` 는 `orphaned` 를 포함해 모든 상태의 모든
session 을 반환하고, 거르는 것은 호출자입니다. session 하나의 상태를 위한 두 번째 명령은 같은 사실을
두 번째 경로로 읽는 것입니다.

`session.close` 는 소유자가 실행 중일 것을 요구합니다. 종료는 소유자의 기록을 제거하고, 코어는 그
저장소에 쓰지 않습니다. 소유자가 실행 중이지 않은 session 을 향한 종료는 거부되고 소유자가 실행 중이
아님을 보고합니다.

목록에 실린 session 의 restore 결과는 그 session 의 마지막 restore 결과입니다. restore 된 적 없는
session 에는 그것이 없으며, 필드는 `full` 로 기본값을 주는 대신 비웁니다.

코어는 각 사실을 그 소유자의 플러그인이 선언한 contract 를 통해 소유자에게서 읽습니다. 소유자의
저장소를 읽지 않습니다.

## S10. Gate

| 주장 | Gate |
| --- | --- |
| 코어는 좌표에서 유도한 id 를 기록하지 않는다 | index 를 쓰는 쪽에 대한 코어 테스트 |
| 소유자의 id 는 자기 재시작을 가로질러 반복되지 않는다 | 소유자별 저장소 테스트 |
| session 은 자기 창이 닫혀도 살아남는다 | 코어 테스트: 창을 닫고 `session.list` 가 `detached` 를 보고 |
| session 은 소유자 프로세스가 종료돼도 살아남는다 | fake 소유자를 쓰는 코어 테스트: kill 후 `session.list` 가 `orphaned` 를 보고 |
| session 은 애플리케이션 재시작에도 살아남는다 | fixture index 에 대한 코어 테스트 |
| 소유자가 실행 중이지 않은 session 은 `orphaned` 를 보고하며 `lost` 를 보고하지 않는다 | 소유자 프로세스 없는 코어 테스트 |
| 소유자가 실행 중이지 않은 session 을 향한 종료는 거부된다 | 코어 테스트 |
| 부분 기록은 읽히지 않는다 | 소유자별 저장소 테스트 |
| 한 session 의 기록은 다른 session 이 쓰지 않는다 | 소유자별 저장소 테스트 |
| degraded restore 는 degraded 로 보고된다 | 소유자별 contract conformance 테스트 |
| lost session 은 세어진다 | 코어 테스트: 그 수는 숫자이며 0 이다 |

각 항목의 실행 순서는 [`SESSION-TASK.md`](SESSION-TASK.md) 에 있습니다.

## S11. 하위 문서

| 문서 | 관계 |
| --- | --- |
| [`COMPONENT-HANDOFF.md`](COMPONENT-HANDOFF.md) | 프로세스가 들고 있는 session 을 잃지 않고 프로세스를 교체하는 방법. 하위: handoff 는 S6 에 복무합니다 |
| [`RESTORE.md`](RESTORE.md) | 재시작을 가로지르는 창과 워크스페이스 layout. layout 은 attachment 를 명시할 뿐 session state 를 들고 있지 않습니다 |
| [`TERMINAL-RESTORE-CONTRACT.md`](TERMINAL-RESTORE-CONTRACT.md) | 터미널 소유자의 restore 절차. 한 소유자의 S6 구현입니다 |
| [`SIDECARS.md`](SIDECARS.md) | 소유자가 실행되는 프로세스 |
