---
kind: translation
status: historical
canonical: docs/tech/GATES.CHANGELOG.md
---

# Gate 소유권 변경 기록

현재 계약은 [GATES.md](GATES.md)입니다.

## 설치 제품 검사를 Core 밖으로 이동

과거 Core는 형제 plugin source를 build하고 arrangement, drawn surface, motion, quiet runtime,
터미널 fleet 시스템 테스트를 소유했습니다. 이 구조는 체크아웃 배치를 제품 검증 계약으로 만들고
Core가 plugin 동작을 다시 정의하게 했습니다.

Commit `fde267ac5860b4e9ed7dc4e2abd16bdcc576610f`은 설치 제품 검증을
`min-median-max/soksak-terminal-tests`로 옮기며 fixture를 제거했습니다. 하지만 Taskfile 항목 네
개가 삭제된 테스트 이름을 계속 호출했습니다. Go 는 `-run` 과 일치하는 테스트가 없어도 패키지를 성공으로
종료하므로 이 task들은 거짓 GREEN이 됐습니다.

남은 task 를 제거했습니다. Core 는 소유자 테스트와 수명주기 복원 검사를 유지하고 외부 suite 가 Core 를
통해 immutable release를 설치해 fleet composition을 검증합니다. Frame-by-frame rail과 section motion은
외부 suite가 구현할 때까지 명시적으로 미완료입니다.

## 증거

- `TestEveryNamedGoTestTargetExists`는 Taskfile이나 CI가 없는 Go test를 이름을 지정해 호출하면 실패합니다.
- `task verify:restore`는 lifecycle gate가 있는 `internal/application`을 대상으로 합니다.
- `scripts/ci/macos-link.sh`는 실제 존재하는 저장소의 릴리즈 워크플로 테스트를 대상으로 합니다.

## 응답하지 않은 compositor commit

제거된 drawn-layout gate는 full suite에서 간헐적으로 실패하고 단독 실행에서는 통과했습니다. 한
측정은 `declared 22, committed 21, still dirty`를 보고했고 이후 실패는 pending presentation timeout만
노출했습니다. 현재 계약은 installed suite가 delivery, compositor commit, presentation receipt를 구분하는
scenario와 native trace를 소유할 때까지 이를 명시적으로 미완료로 둡니다.

## Installed native fleet 완료

2026-08-23 외부 suite는 빈 environment에서 immutable terminal release를 설치하고 run
`32644742653`에서 Windows x86_64, macOS, Linux x86_64, Linux arm64 의 명령, resize, 대량 출력,
warm restore, archived restore, UI invariant, app-owned capture를 모두 통과했습니다.

같은 Core build는 signed registry sequence 10에서 `soksak-plugin-browser-wails3@0.0.5`를 fresh
install했습니다. `https://example.com` navigation은 정확한 title `Example Domain`에 도달했고 plugin
적합성 위반은 0, plugin 호스트 오버레이 reason 은 `none`, `ui.verify` 는 검사 6개 모두 통과,
`state.health` degraded axis는 0, surface composition은 clean이었습니다. App-owned PNG에서도 native
페이지가 빈 화면이나 오류 오버레이 없이 보였습니다.
