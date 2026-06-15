# webview 프로세스 누수 — 수정 결정 기록

멀티 윈도우/브라우저(hole-punch) 작업 중 발견한 WKWebView/WebContent 프로세스 누수와,
그에 대한 두 갈래 수정 방식의 결정 기록.

## 버그 (상류)

`tauri-runtime-wry` 2.11.2 / `src/lib.rs:4013-4017` (`fn with_webview`, macOS 분기):

webview·manager·ns_window 를 각각 `Retained::into_raw(...)` 로 raw 포인터화해 클로저에 넘기지만,
그 구조체에 `Drop` 이 없어 `from_raw` 회수가 영원히 일어나지 않는다 → `with_webview` 호출마다
셋 각각 +1 retain 누수 → WKWebView 가 해제되지 않아 그 안의 WebContent(XPC) 프로세스가 영원히 잔존.

- 레포: <https://github.com/tauri-apps/tauri> — 크레이트 경로 `crates/tauri-runtime-wry/`
- `wry`(<https://github.com/tauri-apps/wry>) 아님. wry 는 tauri-runtime-wry 가 *쓰는* 하위 라이브러리이고,
  누수는 tauri 쪽 브리지 코드에 있다. 따라서 상류 수정/PR 대상은 `tauri-apps/tauri`.

## 검증 (우리 오용이 아님)

- `SOKSAK_SKIP_NATIVE` 로 native hook 을 끈 채 실측 → with_webview 를 호출하지 않으면 누수 없음.
  누수의 트리거는 우리의 with_webview *호출*이지만, 누수의 원인은 상류의 회수 누락이다.
- PID delta 추적으로 탭/창 닫기 시 프로세스 종료 확인(잔존 0). 절대 개수(ps grep)는 다른 WebKit 앱·
  back-forward 캐시까지 세어 오염되므로 PID delta 만 신뢰.

## Approach A — 앱측 상쇄 (보전됨)

- 위치: `src-tauri/src/browser.rs` `with_webview_balanced`
- 동작: 클로저 실행 후 **webview 포인터(`pw.inner()`)만** `from_raw`+`drop` 으로 상쇄.
  manager/ns_window 는 건드리지 않는다 — 브라우저 child 의 ns_window = 부모 창이라 상쇄하면
  부모 창이 과해제돼 렌더가 깨진다(실측·되돌림).
- 효과: 프로세스 누수(사용자가 본 문제) 해결. manager/ns_window 미세 메모리 누수는 잔존(프로세스 아님).
- 장점: 자기완결 ~30줄, fork 불요. 단점: 부분 수정, 타우리 버전업 시 상류가 고치면 이중해제 위험 → 제거 필요.
- **보전 위치**: 브랜치 `leak-fix-app-side`, 태그 `app-side-leak-fix`, 커밋 `dff2af0`.

## Approach B — 상류 패치 (선택, 진행 방향)

- `tauri-apps/tauri` fork → `crates/tauri-runtime-wry/src/lib.rs` 에서 `into_raw`(소유권 이전) 대신
  `Retained::as_ptr`(빌림) + 로컬 drop 으로 셋 다 정확히 상쇄.
- 루트 `Cargo.toml` `[patch.crates-io] tauri-runtime-wry = { git = "<fork>", branch = "<fix>" }` 로 물림.
- 앱측 `with_webview_balanced` 제거 → plain `with_webview` 4곳 복귀(수정의 단일 진실 = 패치된 크레이트).
- 그 fork 브랜치가 곧 상류 PR(`tauri-apps/tauri` 대상). 우리가 [patch] 로 자체 검증한 뒤 신중히 제출.
- 단점: fork 유지 + 타우리 업글마다 리베이스. **ns_window 상쇄 렌더 회귀 실측 필수**(가정 금지 — A 에서 깨진 전례).

## 폴백

Approach B 에 문제가 생기면 `leak-fix-app-side`(`app-side-leak-fix` / `dff2af0`)에서 A 를 복원한다.
