---
kind: translation
status: historical
canonical: docs/tech/GATES.CHANGELOG.md
---

# Gate 소유권 변경 기록

현재 계약은 [GATES.md](GATES.md)입니다.

## Installed-product gate를 Core 밖으로 이동

과거 Core는 형제 plugin source를 build하고 arrangement, drawn surface, motion, quiet runtime,
terminal fleet system test를 소유했습니다. 이 구조는 checkout 배치를 product 검증 계약으로 만들고
Core가 plugin 동작을 다시 정의하게 했습니다.

Commit `fde267ac5860b4e9ed7dc4e2abd16bdcc576610f`는 installed-product 검증을
`min-median-max/soksak-terminal-tests`로 옮기며 fixture를 제거했습니다. 하지만 Taskfile 항목 네
개가 삭제된 test 이름을 계속 호출했습니다. Go는 `-run`과 일치하는 test가 없어도 package를 성공으로
종료하므로 이 task들은 거짓 GREEN이 됐습니다.

남은 task를 제거했습니다. Core는 owner test와 lifecycle restore gate를 유지하고 외부 suite가 Core를
통해 immutable release를 설치해 fleet composition을 검증합니다. Frame-by-frame rail과 section motion은
외부 suite가 구현할 때까지 명시적으로 미완료입니다.

## 증거

- `TestEveryNamedGoTestTargetExists`는 Taskfile이나 CI가 없는 Go test를 이름으로 호출하면 실패합니다.
- `task verify:restore`는 lifecycle gate가 있는 `internal/application`을 대상으로 합니다.
- `scripts/ci/macos-link.sh`는 실제 존재하는 repository release-workflow test를 대상으로 합니다.

## 응답하지 않은 compositor commit

제거된 drawn-layout gate는 full suite에서 간헐적으로 실패하고 단독 실행에서는 통과했습니다. 한
측정은 `declared 22, committed 21, still dirty`를 보고했고 이후 실패는 pending presentation timeout만
노출했습니다. 현재 계약은 installed suite가 delivery, compositor commit, presentation receipt를 구분하는
scenario와 native trace를 소유할 때까지 이를 명시적으로 미완료로 둡니다.

## Installed native fleet 완료

2026-08-23 외부 suite는 빈 environment에서 immutable terminal release를 설치하고 run
`32644742653`에서 Windows x86_64, macOS, Linux x86_64, Linux arm64의 command, resize, high output,
warm restore, archived restore, UI invariant, app-owned capture를 모두 통과했습니다.

같은 Core build는 signed registry sequence 10에서 `soksak-plugin-browser-wails3@0.0.5`를 fresh
install했습니다. `https://example.com` navigation은 정확한 title `Example Domain`에 도달했고 plugin
conformance violation은 0, plugin host overlay reason은 `none`, `ui.verify`는 6개 check 모두 통과,
`state.health` degraded axis는 0, surface composition은 clean이었습니다. App-owned PNG에서도 native
page가 빈 화면이나 error overlay 없이 보였습니다.
