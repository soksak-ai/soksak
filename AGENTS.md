<!-- soksak-control:start -->
## Controlling soksak with `sok`

soksak is a terminal app with a 3-level layout: projects (t*) → contents (c*, tabs of
split grids) → panels (g*, split groups) holding views (v*: terminal / file editor /
browser; terminals contain panes p*). Every feature is exposed as a `sok` CLI command.

## Address model (targeting)

- `sok state.tree` returns every id plus each panel's on-screen rect (%) — the address book.
- Inside a soksak terminal, `$SOKSAK_PANE` marks your pane. Omit target ids and commands
  default to your own location. `sok state.context` shows where you are.
- Pass explicit ids to act anywhere: `sok panel.split '{"group":"g3","side":"right"}'`.

## Workflow — always verify

1. `sok state.tree` to discover targets.
2. Run the command. Mutations return resulting ids/state, e.g. panel.split →
   `{"ok":true,"groupId":"g4","viewId":"v5","paneId":"p6"}`.
3. Verify from the response; cross-check with `sok state.tree` or `sok term.read`.
4. Errors are structured: `{"ok":false,"code":"TARGET_NOT_FOUND|LAST_ITEM|INVALID_PARAMS|TIMEOUT","message":...}`.

## Command domains (full schemas: `sok commands`, one command: `sok help <cmd>`)

- state: tree, context, commands
- project: list, create, close, activate, rename, sidebar.toggle
- content: list, create, close, activate, rename (tabs of split grids; `+` menu equivalent)
- panel: list, split, merge, move, close, focus, resize (split-window management)
- view: list, open, close, activate, move (tabs inside a panel: terminal/claude/codex/browser)
- pane: list, split, close, focus (splits inside one terminal view)
- term: read, send, exec, cwd (terminal I/O — your eyes and hands)
- browser: open, navigate, back, forward, reload, eval (returns JSON result)
- browser.dom: text, html, query, click, fill, submit, waitFor (DOM control, all return results)
- bookmark: list, add, remove / editor: open, save, close / settings: get, set / theme.set

## Recipes

- Split right and run claude: `sok panel.split '{"side":"right","program":"claude"}'`
- Run a command and read output: `sok term.exec '{"cmd":"git status"}'` then
  `sok term.read '{"lines":40}'`
- Drive a TUI: `sok term.send '{"text":"\u001b[B"}'` (arrow down), `'{"text":"\r"}'` (enter),
  `'{"text":"\u0003"}'` (ctrl-c)
- Browser automation: `sok browser.open '{"url":"https://example.com"}'` →
  `sok browser.dom.fill '{"selector":"input[name=q]","text":"hello"}'` →
  `sok browser.dom.click '{"selector":"button[type=submit]"}'` →
  `sok browser.dom.waitFor '{"selector":".results"}'` → `sok browser.dom.text`

## Cautions

- close commands are destructive: panel.close removes every tab in the panel; the last
  project/content/view/pane is protected (LAST_ITEM error).
- term.send writes raw bytes to the PTY; term.exec appends Enter.
- browser.eval runs arbitrary JS in the page; `return` a JSON-serializable value.
<!-- soksak-control:end -->

## 정본 문서와 주석

- 코드 주석과 정본 문서는 현재 유효한 규칙, 책임, 인터페이스, 검증 방법을 기술한다.
- 대화 경위, 작업 지시, 발견 순서, 수정 과정, 작업 성과를 정본에 기록하지 않는다.
- 과거 동작이 현재의 호환성이나 안전성 판단에 직접 필요하지 않으면 설명에서 제거한다.
- 필요한 변경 이력은 `CHANGELOG`, 마이그레이션 기록, 감사 증적처럼 목적이 명시된 비정본 기록에만 사실과 근거를 함께 남긴다.
- 인수인계와 상태 보고는 정본의 근거가 될 수 없으며, 최종 규칙은 반드시 소유 저장소의 계약·테스트·정본 문서에 다시 표현한다.
