---
name: soksak-dev
description: >-
  Drive the soksak / vsterm desktop workspace from the command line (the `sok`
  binary) so you can open projects, arrange spaces and
  split panels, launch terminals and browsers, run the actual build, and — the
  whole point — SEE the result with a real screenshot before claiming anything
  works. Use this skill whenever you are working inside the soksak/vsterm
  app, or whenever a task involves
  `sok`, `plugin.catalog`, `state.tree`, `window.snapshot`,
  `panel.split`, `space.create`, `term.exec`, or any `sok <namespace>.<command>`
  call. Reach for it eagerly any time you build something (a web page, a
  desktop UI, a CLI, a script) and need to verify it visually rather than
  guessing from logs — open it in a soksak view, capture the window, and look
  at the pixels. Especially valuable when helping a non-developer, who cannot
  inspect the running app themselves and is trusting you to confirm it
  actually renders and behaves correctly.
  This is the dev environment (home ~/.soksak-dev) — use it when working against that environment's app.
---

## This environment (pinned at generation)

- Environment: **dev** — socket `/Users/max/.soksak-dev/com.soksak.dev.sock`
- Invoke: `sok-dev` if it is on PATH; otherwise the pinned CLI: `/Users/max/ai/cli/vsterm-tauri/src-tauri/target/debug/sok-dev`
- Every `sok …` example below means this binary. Do not substitute another environment's binary — each environment has its own app, socket, and plugin set.

## Working style (authored)

## Why this skill exists

The hardest part of building software with AI, for someone who can't read code,
is that they can't tell whether the thing actually works. Logs say "compiled
successfully" and they have to take it on faith. This skill removes the faith.

soksak (the vsterm desktop app) exposes its entire UI as commands through one
binary. You can open a project, split the screen, run the build in a terminal,
open the result in a browser — and then **capture the window to a PNG and open
that PNG with your own eyes.** So instead of telling the user "it should work
now," you look at the running app, confirm the button is actually there and the
page actually rendered, and *then* report. That closing of the loop — act, then
observe the pixels — is the reason to use this skill on essentially every build
step.

## The core loop: set up → do the work → SEE it

Do not treat "take a screenshot" as an optional final flourish. It is a step in
the loop, run as often as you'd glance at your screen while working.

### 1. Set up the workspace

```bash
# Open a project — from the control plane it routes to a dedicated window
sok project.open '{"root":"/Users/me/work/my-app"}'
# ...or open it in its own window explicitly:
sok window.open '{"root":"/Users/me/work/my-app"}'

# One call for a whole dev screen (terminal left, browser right):
sok layout.apply dev

# Or split by hand
sok panel.split '{"side":"right","program":"browser"}'
sok panel.split '{"side":"bottom","program":"terminal"}'

# Rebalance the split if one side is too small (ratios sum to 1)
sok panel.resize '{"split":"s1","sizes":[0.6,0.4]}'

# Open a file in an editor, or a new terminal/agent view
sok editor.open '{"path":"/Users/me/work/my-app/src/main.rs"}'
sok view.open '{"program":"terminal"}'
```

If the project has an always-on process (dev server, database), register it as
a daemon so it survives window close/reopen once the user allows autostart:

```bash
sok daemon.add '{"name":"dev","cmd":"npm run dev"}'
sok daemon.start dev && sok daemon.logs dev
```

### 2. Do the work in a terminal

```bash
sok term.exec '{"cmd":"npm run dev"}'     # sends command + Enter, returns at once
sok term.read '{"lines":50}'              # read the output back a moment later
sok term.send '{"text":""}'         # send raw keys (^C here) for TUIs
```

Target a specific pane with `"pane":"<id>"`; omit to use the current one.

### 3. Open the result where you can see it

For a web app, put it in a browser view and drive/read the page:

```bash
sok space.create '{"program":"browser"}'
sok plugin.soksak-plugin-browser-native.navigate '{"url":"http://localhost:5173"}'
sok plugin.soksak-plugin-browser-native.dom.text '{"selector":"h1"}'   # read
sok plugin.soksak-plugin-browser-native.dom.click '{"selector":"button.submit"}'
sok plugin.soksak-plugin-browser-native.eval '{"js":"return document.title"}'
```

### 4. Capture the window and LOOK at it — this is the point

```bash
# Save a PNG, then open it and actually inspect the pixels:
sok window.snapshot '{"path":"/tmp/sok/step1.png"}'
```

Then **Read `/tmp/sok/step1.png`** so you see the rendered app yourself. Confirm
the layout is right, the page rendered, the text is legible, nothing is blank or
broken. Only after seeing it do you report to the user. Crop to a region with
`rect` (CSS px, same coordinate space as `ui.measure`) when you only care about
one area:

```bash
sok window.snapshot '{"rect":{"x":100,"y":80,"w":600,"h":400},"base64":true}'
```

For motion (animations, transitions, a flash of unstyled content), capture a
sequence and flip through the frames:

```bash
sok window.record '{"dir":"/tmp/sok/rec","frames":60,"intervalMs":33}'
```

Specialized visual checks worth knowing: `space.switchScan` (does switching to
a space land in one clean frame or does it smear/jank?) and `window.themeScan`
(does a dark/light toggle apply atomically or tear?). Reach for these when the
user reports flicker you need to reproduce and measure.

## Precise UI interaction (when a CSS selector isn't enough)

The app's own chrome (tabs, dividers, modals, plugin views) exposes addressable
nodes. Discover them, then measure or drive them:

```bash
sok ui.tree                                          # list exposed node addresses
sok ui.tree '{"rects":true}'                         # + viewport rects for coordinate work
sok ui.measure '{"address":"win/main/.../node/send"}' # rect + computed style
sok ui.input.click '{"address":"win/main/chrome/modal/consent/agree"}'
sok ui.input.fill  '{"address":".../node/url-input","value":"/path/clip.mp4"}'
sok ui.input.drag  '{"from":".../divider/s0/0","dx":120}'   # drag a split divider
```

Addresses come from `ui.tree` only — unexposed elements return `NOT_EXPOSED`,
which is a signal to stop guessing, not to retry with a different string.
An occluded window stops rendering (rAF pauses) — bring it forward with
`sok window.focus` before interaction tests.

## Verify-before-you-claim (the habit that matters most)

The failure mode this skill prevents is confidently reporting success you never
observed. Build the habit:

1. After any change that affects the UI, capture the window and **Read the PNG.**
2. Describe what you actually see, not what you expect to see.
3. If it's blank, misaligned, or errored, you caught it *before* the user did —
   fix it and capture again.
4. Only say "it works" about things you have looked at.

For a non-developer especially, a screenshot you've verified is worth more than
any amount of green terminal text. Show them, don't tell them.

## Quick recipes

**"Open my project and show me it running."**
`project.open` (or `window.open`) → `layout.apply dev` (or `panel.split` by
hand) → `term.exec` the dev command → `term.read` to confirm it booted →
browser `navigate` to the local URL → `window.snapshot` to a file → Read the
PNG → report what you see.

**"Is the button actually on the page?"**
browser `dom.query '{"selector":"button"}'` to confirm it exists in the DOM →
`window.snapshot` and Read it to confirm it's visibly rendered (DOM presence ≠
visible). Both, because either alone can lie.

**"Split the screen: code on the left, preview on the right."**
`state.tree` to get the current panel id → `panel.split '{"side":"right",
"program":"browser"}'` → `panel.resize` to taste → snapshot to confirm the
layout landed.

**"Something flickers when I switch spaces."**
`space.list` for the ids → `space.switchScan '{"from":"c1","to":"c3"}'` →
report `clean`/`switchFrames`; capture frames with `window.record` if you need
to show the user.

See `references/commands.md` for the grouped command reference, and run
`sok docs` for the exhaustive live schema of anything not covered there.

# Controlling soksak with `sok`

> AUTO-GENERATED by `sok skill install` — edits are overwritten. Source of truth is `sok commands`.

Orientation only. `sok commands` (catalog) and `sok help <cmd>` (one command's schema) are the
live single source of truth — this file is a map, not the full catalog.

soksak is a terminal app with a 3-level layout: projects (t*) -> spaces (c*, tabs of split
grids) -> panels (g*, split groups) holding views (v*: terminal / file editor / browser;
terminals contain panes p*). Every feature is a `sok` command.

Two window kinds: workspace windows (label `w-*`) host projects and load plugins/programs;
the control-plane window (label `main`, the orchestrator) loads none by design. If
`program.list` / `plugin.list` return empty with a control-plane note, you queried `main` —
target a workspace window (`--window w-…`) instead of installing anything. Opening a project
while on `main` routes to a new workspace window automatically (returns `routedWindow`).

## Address model (targeting)

- `sok state.tree` returns every id plus each panel's on-screen rect (%) — the address book.
- Inside a soksak terminal, `$SOKSAK_PANE` marks your pane. Omit target ids and commands
  default to your own location. `sok state.context` shows where you are.
- Pass explicit ids to act anywhere: `sok panel.split '{"panel":"g3","side":"right"}'`.

## Workflow — always verify

1. `sok commands` (or `sok commands '{"domain":"panel"}'`) to discover; `sok help <cmd>` for one schema.
2. `sok state.tree` to discover live targets.
3. Run the command. Mutations return resulting ids/state, e.g. panel.split ->
   `{"ok":true,"panelId":"g4","viewId":"v5","paneId":"p6"}`.
4. Verify from the response; cross-check with `sok state.tree` or `sok term.read`.
5. Errors are structured: `{"ok":false,"code":"TARGET_NOT_FOUND|LAST_ITEM|INVALID_PARAMS|TIMEOUT","message":...}`.

## Domain map (table of contents — full schemas via `sok commands` / `sok help <cmd>`)

- activity (1): recent
- ai (4): session.detect, session.find, session.inspect, ...
- bookmark (3): add, list, remove
- clipboard (2): read, write
- command (1): docs
- daemon (9): add, autostart, list, ...
- data (12): backup, count, encrypt.convert, ...
- debug (1): sleep
- dev (1): remoteConfirmMock
- editor (2): close, open
- explorer (2): git, list
- git (4): diff, init, log, ...
- layout (2): apply, suggest
- media (3): proxy.info, proxy.playlist, proxy.stream
- net (3): http.request, udp.request, udp.send
- notify (1): show
- panel (8): close, equalize, focus, ...
- plugin (375): dynamic — `sok commands` / `sok plugin.list`
- program (1): list
- project (11): activate, close, color, ...
- remote (1): confirm
- schedule (5): cancel, list, poke, ...
- secret (8): autolock, backend, has, ...
- settings (2): get, set
- sidebar (4): left.move, left.resize, left.tree, ...
- space (6): activate, close, create, ...
- state (3): commands, context, tree
- status (1): query
- term (4): cwd, exec, read, ...
- theme (4): apply, install, list, ...
- turn (2): idleDetection, signal
- ui (10): expect, hit, input.click, ...
- view (10): activate, close, label.get, ...
- webview (1): emitNative
- window (17): close, focus, info, ...

## Recipes

- Split right and run claude: `sok panel.split '{"side":"right","program":"claude"}'`
- Run a command and read output: `sok term.exec '{"cmd":"git status"}'` then `sok term.read '{"lines":40}'`
- Drive a TUI: `sok term.send` with JSON text like `[B` (arrow down), `\r` (enter), `` (ctrl-c)
- Browser automation: `sok browser.open` -> `sok browser.dom.fill` -> `sok browser.dom.click` -> `sok browser.dom.waitFor` -> `sok browser.dom.text`

## Orchestration (multi-window, monitors, live feed)

- Windows are first-class: `sok window.open '{"root":"/abs/path"}'` opens a project in its own
  window (P6 single-open: an already-open root focuses its window and returns `existingWindow`).
  `sok window.open '{"mode":"orchestrator"}'` opens the observation window (idempotent).
- Placement: `sok window.monitors` (facts: monitor rects/scale + every window's frame) ->
  `sok layout.suggest '{"strategy":"spread","roles":{"orch-1":"orchestrator"}}'` (pure strategy)
  -> `sok window.place '{"label":...,"x":...,"y":...,"w":...,"h":...}'` (execute, physical px).
- Watch everything that runs: `sok activity.recent '{"limit":50}'` (cursor with `since`), or
  follow live: `sok events --kinds command,terminal --since 0` (JSONL push stream; every `sok`
  call you make is itself recorded as `command.executed`).
- WINDOW TARGETING TRAP: commands route to the focused window by default. After opening the
  orchestrator window it usually holds focus, so terminal/panel commands would land there and
  fail (TARGET_NOT_FOUND). Always pass `"window":"main"` (or the project window's label) in the
  request envelope — or set it per call: `sok state.tree` first, then target explicitly.

## Cautions

- close commands are destructive: panel.close removes every tab in the panel; the last project/space/view/pane is protected (LAST_ITEM error).
- term.send writes raw bytes to the PTY; term.exec appends Enter.
- browser.eval runs arbitrary JS in the page; `return` a JSON-serializable value.
