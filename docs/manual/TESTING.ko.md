---
kind: translation
status: active
canonical: docs/manual/TESTING.md
---

# 테스트

이 저장소에서 통과해야 하는 것과 test의 역할을 설명합니다.

## T1. 하나의 명령

`go tool wails3 task verify`는 Core가 소유한 모든 gate를 실행합니다. 통과하지 않은 commit은 반영하지 않습니다.

| Gate | Command |
| --- | --- |
| `verify:go` | `go build ./...`, `go vet ./...`, `go test ./...` |
| `verify:application` | 현재 `soksak` 과 `sok` 을 빌드한 뒤 capture-only restore, capture-focus, native-close 검사 실행 |
| `verify:headless` | `go test ./core/...` |
| `verify:windows` | `CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build ./...` |
| `verify:frontend` | `pnpm typecheck`, `pnpm test` |
| installed fleet | `tests/soksak-terminal-tests`가 소유하며 Core로 immutable release를 설치 |

Owner test는 각 repository에서 실행합니다. Core는 형제 source를 실행하거나 checkout 위치를 추론하지
않습니다. 저장소를 넘는 제품 검증은 설치기와 `environment.json` 을 지나 릴리즈 산출물을
사용합니다.

## T2. Gate는 누적됩니다

추가한 gate는 유지되며 이후 모든 commit이 이를 통과해야 합니다. Block할 수 없는 gate는 backlog입니다.

## T3. 실패한 gate의 기준을 낮추지 않습니다

Test가 RED면 implementation, fixture, document를 고칩니다. 기준 자체가 틀렸다면 문제를 명시하고
근거와 함께 수정합니다.

## T4. RED 다음 GREEN

결함 수정은 결함을 재현하는 RED에서 시작하고 같은 기준의 GREEN으로 끝납니다.

## T5. Test는 검사 대상 옆에 둡니다

Go는 `x.go`와 `x_test.go`, TypeScript는 `x.ts`와 `x.test.ts`를 사용합니다. File은 크기가 아니라
책임으로 나눕니다.

## T6. Capture는 증거이지 판정이 아닙니다

UI defect는 capture로 관찰하고 수치로 판정합니다. 필요한 수치를 제공하는 command가 없다면 그
command를 만드는 것이 작업의 일부입니다.

## T7. Capture-only와 native input은 서로 다른 gate입니다

Local visual 및 parity gate는 compositor에 남아 있는 alpha-zero non-key window를 사용하며 사용자의
전면 프로세스를 보존해야 합니다. 이 검사의 `ui.input.*` 명령은 노출된 브라우저 이벤트
경로를 증명하지만 운영체제 입력이라고 주장하지 않습니다.

WebKit은 native keyboard 전달에 active key window를 요구합니다. 따라서 terminal system
repository의 `make system-native-input TARGET=<darwin-target>`은 사람이 없는 native runner에서
격리된 interactive application으로만 실행합니다. `window.input.pointer.click`과
`window.input.key.press`를 사용해 terminal-to-PTY 전달과 native route를 기록합니다. 두 matrix가
모두 필요하며 한쪽의 이름을 바꿔 다른 쪽을 대신하면 안 됩니다.

모든 애플리케이션 검사는 폴링 대신 `soksak.host.ready` 를 기다리고 프로세스, 창, socket, home,
runtime 및 open/recorded sidecar ownership을 기록합니다. GREEN cleanup은 application 정상 종료와
테스트가 소유한 사이드카가 0개 남았다는 뜻입니다.

## T8. 전환 움직임에는 수치 명령이 있습니다

View 둘은 `tab.switchScan {"from":"<tab>","to":"<tab>"}`, 전체 layout 둘은
`space.switchScan {"from":"<space>","to":"<space>"}`를 사용합니다. 명령은 `applyAtFrame`에서
활성화하고 직접 확인할 녹화 디렉터리를 반환하며 pixel 전환 하나와 blank, overlap, native receipt
mismatch 프레임 0을 기계적으로 요구합니다. Capture는 창에 포커스를 주지 않습니다.
