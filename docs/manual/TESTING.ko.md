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
| `verify:application` | 현재 `soksak`과 `sok`을 build한 뒤 capture-only restore, capture-focus, native-close gate 실행 |
| `verify:headless` | `go test ./core/...` |
| `verify:windows` | `CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build ./...` |
| `verify:frontend` | `pnpm typecheck`, `pnpm test` |
| installed fleet | `min-median-max/soksak-terminal-tests`가 소유하며 Core로 immutable release를 설치 |

Owner test는 각 repository에서 실행합니다. Core는 형제 source를 실행하거나 checkout 위치를 추론하지
않습니다. Cross-repository product 검증은 installer와 `environment.json`을 통해 release artifact를
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
