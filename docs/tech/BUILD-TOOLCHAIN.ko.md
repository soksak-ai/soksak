---
kind: translation
status: active
canonical: docs/tech/BUILD-TOOLCHAIN.md
---

# 빌드 툴체인

이 문서는 빌드 도구의 소유, 발견, 준비, 업그레이드 규칙을 정의합니다. 도구 버전은 해당
생태계의 소유 선언에 한 번만 기록합니다. 테스트, 명령, 워크플로, 컨테이너 정의는 그 선언에서
파생하며 version을 복사하지 않습니다.

## 불변식

- **BT1 — 하나의 소유자.** 각 version은 하나의 소유 manifest에 둡니다. 필요한 ecosystem field는
  projection이며 소유값과 같아야 합니다.
- **BT2 — 요구 platform 정책.** Apple Silicon 로컬 검증은 `darwin/arm64`를 요구합니다. 번역된
  child process의 `uname -m=x86_64` 결과로 이 정책을 바꿀 수 없습니다.
- **BT3 — 실제 실행축.** Node는 `process.platform/process.arch`, Go는
  `GOHOSTOS/GOHOSTARCH`를 보고합니다. Wails 는 module 이 소유한 Go 도구입니다. 제품, CLI, 테스트
  애플리케이션, 사이드카, 네이티브 라이브러리의 아키텍처는 바이너리 헤더 또는 실행 상태로 측정합니다.
- **BT4 — 모든 축의 일치.** 요구 플랫폼과 실제 축 중 하나라도 다르면
  `TOOLCHAIN_MISMATCH`, exit 78입니다. 물리 arm64에서 x64 Node 또는 Go를 허용하지 않습니다.
- **BT5 — 제품보다 먼저 전제 검증.** BT1–BT4가 GREEN 이 되기 전에 빌드, 제품 테스트,
  제품 RED 를 시작하지 않습니다. ambient 바이너리나 낡은 바이너리는 테스트 입력이 아닙니다.
- **BT6 — 분리된 공개 사실.** Evidence는 `required`, `nodeRuntime`, `goRuntime`,
  `wailsVersion`, 산출물·실행 아키텍처를 별도 필드로 보고합니다. 하나의 `runtime` field에
  여러 축을 합치지 않습니다.
- **BT7 — ambient 경로 금지.** 전역 Wails 나 Task 실행 파일, 대체 바이너리, 절대 소스 경로,
  자동 아키텍처 대체를 금지합니다. 선언을 선택하지 못하면 다른 설치를 찾지 않고
  거부합니다.
- **BT8 — 업그레이드 트랜잭션.** 업그레이드는 소유자, 모든 반영본, 잠금, CI 입력, 산출물
  매트릭스를 검증된 변경 하나에서 갱신합니다. 테스트 fixture 에는 현재 버전 리터럴을 쓰지 않습니다.
- **BT9 — 저장소 소유.** Core 는 Core, CLI, 프레임워크 구분을 검증합니다. 각 컴포넌트는
  자기 산출물을 검증합니다. 터미널 시스템 테스트 저장소가 설치된 다중 컴포넌트 fleet 의
  architecture와 공존을 검증합니다.

## Version 소유자

| Tool 또는 상태 | 소유자 | Projection 또는 consumer |
| --- | --- | --- |
| Go 언어 version | `go.mod`의 `go` directive | Go toolchain 선택 |
| Wails CLI | `go.mod`의 Wails requirement와 `tool github.com/wailsapp/wails/v3/cmd/wails3` | `go tool wails3` |
| Node runtime | `.node-version` | `frontend/package.json`의 `engines.node`, CI setup, 컨테이너 빌드 인자 |
| pnpm | `frontend/package.json`의 `packageManager` | frontend package 및 CI의 pnpm 선택 |
| Frontend dependency byte | `frontend/pnpm-lock.yaml` | 직렬화된 dependency 준비 |
| Task runner | `go.mod`가 선택한 Wails CLI | `go tool wails3 task` |

Node engine은 `.node-version`의 필수 ecosystem projection이며 두 번째 소유자가 아닙니다.
preflight 는 제품 테스트 실행 전에 둘의 차이를 거부합니다. Wails 가 Task runner 를 포함하므로
독립적인 `.task-version`, global Task 요구사항, Task version 비교는 없습니다.

## 발견과 실행

Repository는 설치된 tool의 경로를 기록하지 않습니다. 개발 환경 또는 CI가 `.node-version`의
Node와 `go.mod`의 Go를 선택합니다. Apple Silicon에서는 platform 정책이
`required=darwin/arm64`를 정하며 번역된 amd64 parent process가 이를 바꿀 수 없습니다. Preflight는
이 요구값을 Node, Go, Wails runtime과 각각 비교합니다. Native frontend package는 실제 Node
프로세스가 선택하며 요구 플랫폼과도 같아야 합니다. 물리 arm64 만으로 x64 프로세스나 패키지를
허용하지 않습니다.

Wails는 `PATH`에서 발견하지 않습니다. Go가 `go.mod`에 등록된 tool을 build하고 실행합니다.

```sh
make prepare REGISTRY=http://host:port/
make preflight
make verify REGISTRY=http://host:port/
go tool wails3 dev
```

`REGISTRY`는 make 명령줄에서만 받습니다. Frontend가 `@soksak/soksak-spec`에 의존하므로
`prepare`, `verify`, `build` 타깃은 값이 없으면 실행을 거부합니다. Make는 이 값을 pnpm의
scoped registry 플래그로 전달합니다. `scripts/ci`의 script는 pnpm option을 뒤따르는 인자로 받고,
Taskfile은 `PNPM_FLAGS`로 받습니다. `.npmrc`는 관여하지 않습니다.

`REGISTRY` 는 빌드 입력이지 컴포넌트 전송이 아닙니다. 그것이 제공하는 것은 프론트엔드가 컴파일하며
의존하는 npm 패키지입니다 — Spec validator, 터미널 킷, 터미널 플러그인 계약. Plugin 이나 Sidecar 를
설치하는 것은 [`ENVIRONMENT-AND-INSTALLATION.md`](ENVIRONMENT-AND-INSTALLATION.md) 의 릴리즈
closure 이고, 그 전송은 HTTPS 릴리즈 디렉터리와 주소로 지정된 로컬 store 둘입니다. 둘은 별개입니다.
컴포넌트는 `REGISTRY` 로 해석되지 않고, 빌드 입력은 record 로 설치되지 않습니다.

2026-09-04 측정: 한 저장소가 Spec validator 를 GitHub 릴리즈 asset URL 로 고정했고, 그 릴리즈가
삭제되자 설치가 해석되지 않았습니다. 빌드 입력을 정확하게 만드는 것은 버전과 lockfile integrity 이고,
릴리즈는 위치이며 위치는 사라질 수 있습니다.

`WAILS3` override, global `wails3`, 별도로 설치한 Task binary, script에 기록한 version별 tool
경로는 금지합니다. Workstation absolute path는 관측된 executable을 나타내는 evidence record에는
들어갈 수 있지만 소스, lockfile, 워크플로, 릴리즈 산출물에는 들어갈 수 없습니다.

## 준비 구분

Toolchain 검사와 dependency 준비는 별도 작업입니다.

1. `prepare-frontend-dependencies.sh`가 먼저 read-only frontend tool 검사를 실행합니다.
2. prepare 가 저장소의 의존 소유자 잠금을 얻고 정확한 고정 lockfile 을 설치합니다.
3. `check-build-toolchain.sh`가 설치된 네이티브 패키지, Go 호스트 toolchain, 선택된
   module 이 소유한 Wails 바이너리를 검증합니다.
4. 세 조건이 통과한 뒤에만 제품 검사를 시작합니다.

`TOOLCHAIN_MISMATCH`와 잘못된 선언은 exit 78입니다. `DEPENDENCY_STATE_INVALID`는 exit 79입니다.
둘 다 제품 RED 가 아닙니다. 캐시 삭제, 소유가 없는 패키지 설치, 대체 바이너리, 테스트
skip으로 이 분류를 바꿀 수 없습니다.

## 업그레이드 transaction

Tool 업그레이드는 소유 선언을 먼저 변경하고 필요한 projection을 같은 변경에서 갱신합니다.
Test는 선언을 읽으므로 version이 바뀌었다는 이유만으로 수정하지 않습니다.

- Node 업그레이드는 `.node-version`과 `engines.node` projection을 변경한 뒤 지원 architecture마다
  frontend lock을 다시 materialize하고 검증합니다.
- pnpm 업그레이드는 `packageManager`와 해당 pnpm version으로 만든 lockfile을 변경합니다.
- Frontend package 또는 Go module dependency 업그레이드는 각 owner requirement를 변경합니다.
  `make lock REGISTRY=<absolute-url>`이 pnpm `--lockfile-only` projection과 `go mod tidy`를 모두
  소유하며 local task, CI, container는 frozen frontend lock과 `go tool wails3`를 사용합니다.
- Go 업그레이드는 `go` directive를 변경하고 모든 host 및 cross-compilation gate를 다시 실행합니다.

스크립트, 워크플로, Dockerfile, 테스트 fixture, 문서에 별도의 버전 리터럴이 남아 있으면
업그레이드는 완료되지 않았습니다.

## Darwin project build

공개 릴리스는 계속 `soksak` project입니다. 별도로 구분할 build는 안정적인 project 이름 하나를 Make
command line으로 받습니다.

```sh
make build TARGET=aarch64-apple-darwin PROJECT=soksakv3 REGISTRY=http://127.0.0.1:4873/
```

산출물은 `bin/projects/soksakv3/darwin-arm64/soksakv3.app`과 `sokv3`입니다. 모든 연결은 `PROJECT` 한 값에서
정해집니다. Project identifier는 `com.<project>.core`입니다. Darwin은 이를 `CFBundleIdentifier`에
기록하고 Core와 project CLI는 같은 값을 home과 socket에 사용합니다. `.app`, Mach-O, Core process label,
Sidecar process label은 project 이름입니다. 따라서 WebKit helper 이름에도 project 이름이 들어갑니다.
Build receipt는 `project`와 `projectIdentifier`를 기록하며 같은 commit과 project를 다시 빌드하면
byte가 같은 산출물을 재사용해야 합니다.

`PROJECT`는 Make command-line 값으로만 받고 Darwin thin build에서만 사용합니다. `soksak`으로 시작하며
소문자 ASCII, 숫자, hyphen만 허용합니다. CLI 이름은 이 접두사의 `sak`을 제거합니다. `soksak`은
`sok`, `soksakv3`는 `sokv3`를 만듭니다. Project 등록표, 별도 label 인자, 별도 bundle-ID 인자는 없습니다.

## Gate

`internal/repositorygate/build_toolchain_owner_test.go`는 중복 소유자, ambient Wails 또는 Task
실행 파일, 빠진 Go 도구 등록, Node 선택자 어긋남을 거부합니다.
`internal/repositorygate/frontend_toolchain_preflight_gate_test.go`는 read-only 검사와 preparation의
분리를 검증하고 pnpm을 선언 소유자인 frontend package에서 해석하는지 확인합니다. 또한 번역된
amd64 Go runtime을 거부하고 required, Node, Go, Wails architecture 축을 분리해 공개합니다.
