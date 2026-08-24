# soksak-core

플러그인 기반 Wails desktop core 저장소이며 버전은 `0.0.3`입니다. `go.mod`가 Go module과
Wails CLI를 소유하고 `.node-version`과 `frontend/package.json`이 frontend toolchain을 소유합니다.

## 현재 계약

- Workspace는 하나의 재귀적인 `leaf | split` tree입니다. Leaf는 실제 PTY terminal 또는
  browser surface이며 nesting 제한을 두지 않습니다.
- 모든 leaf는 terminal과 browser를 오른쪽/아래로 나누는 동작과 close를 노출합니다. Close는
  sibling subtree를 부모 자리로 올리며 마지막 leaf는 닫을 수 없습니다.
- Divider는 pointer capture로 drag합니다. Divider에서 시작한 pointer stream만 포함하므로
  terminal/browser의 일반 text selection과 copy는 유지됩니다.
- `soksak-kit-plugin-terminal`이 terminal view 등록, PTY 및 복원 lifecycle, resize, status, wait,
  표준 command surface를 소유합니다. `soksak-plugin-terminal-xterm`은 Xterm renderer adapter,
  screen buffer, theme, 입력과 IME 동작 및 선택적 command만 제공합니다.
- `wails-service-native-compositor`는 Wails v3 공식 `application.Service` lifecycle을 통해
  등록되고 공개 DOM 선언을 관측하며 generation/sequence inventory와 적용 receipt를
  직렬화합니다.
- Core는 plugin을 연결하고 DOM/layout만 선언합니다. PTY, Xterm, AppKit, WKWebView 구현을
  포함하지 않습니다.

## 재현 가능한 명령

```sh
scripts/ci/prepare-frontend-dependencies.sh
scripts/ci/check-build-toolchain.sh
go tool wails3 task verify
go tool wails3 dev
```

Version 소유권, 업그레이드 transaction, precondition 분류는
[`docs/tech/BUILD-TOOLCHAIN.ko.md`](docs/tech/BUILD-TOOLCHAIN.ko.md)에 정의합니다.

## 검증 소유권

- Core는 layout, command, 설치, runtime loading과 platform adapter 경계를 검증합니다.
- `wails-service-native-compositor`는 snapshot, observer, stale rejection, receipt를 검증합니다.
- 각 plugin과 sidecar 저장소가 자신의 manifest, 구현, conformance와 release를 검증합니다.
- 설치 acceptance 저장소가 immutable release 조합을 black-box system test로 검증합니다.

생성된 screenshot과 중간 evidence는 application source 저장소에 commit하지 않습니다.
