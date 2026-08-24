---
kind: translation
status: active
canonical: docs/tech/BUILD-TOOLCHAIN.md
---

# 빌드 툴체인

이 문서는 build tool의 소유권, 발견, 준비, 업그레이드 규칙을 정의합니다. Tool version은 해당
생태계의 소유 선언에 한 번만 기록합니다. Test, command, workflow, container 정의는 그 선언에서
파생하며 version을 복사하지 않습니다.

## 불변식

- **BT1 — 하나의 소유자.** 각 version은 하나의 소유 manifest에 둡니다. 필요한 ecosystem field는
  projection이며 소유값과 같아야 합니다.
- **BT2 — 요구 platform 정책.** Apple Silicon 로컬 검증은 `darwin/arm64`를 요구합니다. 번역된
  child process의 `uname -m=x86_64` 결과로 이 정책을 바꿀 수 없습니다.
- **BT3 — 실제 실행축.** Node는 `process.platform/process.arch`, Go는
  `GOHOSTOS/GOHOSTARCH`를 보고합니다. Wails는 module-owned Go tool입니다. Product, CLI, test
  application, sidecar, native library architecture는 binary header 또는 runtime status로 측정합니다.
- **BT4 — 모든 축의 일치.** 요구 platform과 실제 축 중 하나라도 다르면
  `TOOLCHAIN_MISMATCH`, exit 78입니다. 물리 arm64에서 x64 Node 또는 Go를 허용하지 않습니다.
- **BT5 — Product보다 먼저 전제 검증.** BT1–BT4가 GREEN이 되기 전에 build, product test,
  product RED를 시작하지 않습니다. Ambient 또는 stale binary는 test input이 아닙니다.
- **BT6 — 분리된 공개 사실.** Evidence는 `required`, `nodeRuntime`, `goRuntime`,
  `wailsVersion`, artifact/runtime architecture를 별도 필드로 보고합니다. 하나의 `runtime` field에
  여러 축을 합치지 않습니다.
- **BT7 — Ambient 경로 금지.** Global Wails 또는 Task executable, fallback binary, absolute
  source path, 자동 architecture 대체를 금지합니다. 선언을 선택하지 못하면 다른 설치를 찾지 않고
  거부합니다.
- **BT8 — 업그레이드 transaction.** Upgrade는 owner, 모든 projection, lock, CI input, artifact
  matrix를 하나의 검증된 변경에서 갱신합니다. Test fixture에는 현재 version literal을 쓰지 않습니다.
- **BT9 — Repository 소유권.** Core는 Core, CLI, framework boundary를 검증합니다. 각 component는
  자기 artifact를 검증합니다. Terminal system-test repository가 설치된 multi-component fleet의
  architecture와 공존을 검증합니다.

## Version 소유자

| Tool 또는 상태 | 소유자 | Projection 또는 consumer |
| --- | --- | --- |
| Go 언어 version | `go.mod`의 `go` directive | Go toolchain 선택 |
| Wails CLI | `go.mod`의 Wails requirement와 `tool github.com/wailsapp/wails/v3/cmd/wails3` | `go tool wails3` |
| Node runtime | `.node-version` | `frontend/package.json`의 `engines.node`, CI setup, container build argument |
| pnpm | `frontend/package.json`의 `packageManager` | frontend package 및 CI의 pnpm 선택 |
| Frontend dependency byte | `frontend/pnpm-lock.yaml` | 직렬화된 dependency 준비 |
| Task runner | `go.mod`가 선택한 Wails CLI | `go tool wails3 task` |

Node engine은 `.node-version`의 필수 ecosystem projection이며 두 번째 소유자가 아닙니다.
Preflight는 product test 실행 전에 둘의 차이를 거부합니다. Wails가 Task runner를 포함하므로
독립적인 `.task-version`, global Task 요구사항, Task version 비교는 없습니다.

## 발견과 실행

Repository는 설치된 tool의 경로를 기록하지 않습니다. 개발 환경 또는 CI가 `.node-version`의
Node와 `go.mod`의 Go를 선택합니다. Apple Silicon에서는 platform 정책이
`required=darwin/arm64`를 정하며 번역된 amd64 parent process가 이를 바꿀 수 없습니다. Preflight는
이 요구값을 Node, Go, Wails runtime과 각각 비교합니다. Native frontend package는 실제 Node
process가 선택하며 요구 platform과도 같아야 합니다. 물리 arm64만으로 x64 process 또는 package를
허용하지 않습니다.

Wails는 `PATH`에서 발견하지 않습니다. Go가 `go.mod`에 등록된 tool을 build하고 실행합니다.

```sh
scripts/ci/prepare-frontend-dependencies.sh
scripts/ci/check-build-toolchain.sh
go tool wails3 task verify
go tool wails3 dev
```

`WAILS3` override, global `wails3`, 별도로 설치한 Task binary, script에 기록한 version별 tool
경로는 금지합니다. Workstation absolute path는 관측된 executable을 나타내는 evidence record에는
들어갈 수 있지만 source, lockfile, workflow, release artifact에는 들어갈 수 없습니다.

## 준비 경계

Toolchain 검사와 dependency 준비는 별도 작업입니다.

1. `prepare-frontend-dependencies.sh`가 먼저 read-only frontend tool 검사를 실행합니다.
2. Preparation이 repository dependency-owner lock을 획득하고 정확한 frozen
   lockfile을 materialize합니다.
3. `check-build-toolchain.sh`가 materialize된 native package, Go host toolchain, 선택된
   module-owned Wails binary를 검증합니다.
4. 세 조건이 통과한 뒤에만 product gate를 시작합니다.

`TOOLCHAIN_MISMATCH`와 잘못된 선언은 exit 78입니다. `DEPENDENCY_STATE_INVALID`는 exit 79입니다.
둘 다 product RED가 아닙니다. Cache 삭제, 소유권 없는 package install, fallback binary, test
skip으로 이 분류를 바꿀 수 없습니다.

## 업그레이드 transaction

Tool 업그레이드는 소유 선언을 먼저 변경하고 필요한 projection을 같은 변경에서 갱신합니다.
Test는 선언을 읽으므로 version이 바뀌었다는 이유만으로 수정하지 않습니다.

- Node 업그레이드는 `.node-version`과 `engines.node` projection을 변경한 뒤 지원 architecture마다
  frontend lock을 다시 materialize하고 검증합니다.
- pnpm 업그레이드는 `packageManager`와 해당 pnpm version으로 만든 lockfile을 변경합니다.
- Wails 업그레이드는 `go.mod` module requirement를 변경합니다. `go mod tidy`가 module/tool closure를
  갱신하며 local task, CI, container는 계속 `go tool wails3`를 사용합니다.
- Go 업그레이드는 `go` directive를 변경하고 모든 host 및 cross-compilation gate를 다시 실행합니다.

Script, workflow, Dockerfile, test fixture, document에 독립적인 version literal이 남아 있으면
업그레이드는 완료되지 않았습니다.

## Gate

`internal/repositorygate/build_toolchain_owner_test.go`는 중복 소유자, ambient Wails 또는 Task
executable, 누락된 Go tool 등록, Node selector drift를 거부합니다.
`internal/repositorygate/frontend_toolchain_preflight_gate_test.go`는 read-only 검사와 preparation의
분리를 검증하고 pnpm을 선언 소유자인 frontend package에서 해석하는지 확인합니다. 또한 번역된
amd64 Go runtime을 거부하고 required, Node, Go, Wails architecture 축을 분리해 공개합니다.
