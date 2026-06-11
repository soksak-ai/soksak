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
