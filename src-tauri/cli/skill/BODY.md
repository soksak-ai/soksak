---
description: >-
  Drive the soksak / vsterm desktop workspace from the command line (the `sok`
  binary) so you can open projects, arrange sheets and
  split panels, launch terminals and browsers, run the actual build, and — the
  whole point — SEE the result with a real screenshot before claiming anything
  works. Use this skill whenever you are working inside the soksak/vsterm
  app, or whenever a task involves
  `sok`, `plugin.catalog`, `state.tree`, `window.snapshot`,
  `panel.split`, `sheet.create`, `term.exec`, or any `sok <namespace>.<command>`
  call. Reach for it eagerly any time you build something (a web page, a
  desktop UI, a CLI, a script) and need to verify it visually rather than
  guessing from logs — open it in a soksak view, capture the window, and look
  at the pixels. Especially valuable when helping a non-developer, who cannot
  inspect the running app themselves and is trusting you to confirm it
  actually renders and behaves correctly.
---

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
sok sheet.create '{"program":"browser"}'
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

Specialized visual checks worth knowing: `sheet.switchScan` (does switching to
a sheet land in one clean frame or does it smear/jank?) and `window.themeScan`
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

**"Something flickers when I switch sheets."**
`sheet.list` for the ids → `sheet.switchScan '{"from":"c1","to":"c3"}'` →
report `clean`/`switchFrames`; capture frames with `window.record` if you need
to show the user.

See `references/commands.md` for the grouped command reference, and run
`sok docs` for the exhaustive live schema of anything not covered there.
