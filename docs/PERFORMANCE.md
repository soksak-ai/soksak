# Performance Constitution — Interaction Performance Principles

Seven principles that protect soksak's interaction performance. Every frontend
change is reviewed against this document. A violation is a defect — "it works"
is not a pass.

Background: a 2026-06 audit found ten structural causes (R1–R10) that drove
WebContent CPU to ~100% from light interactions alone (divider/tab/sidebar
drags, scrolling). Every cause was a violation of a principle below. The
measurement harness lives in `scripts/perf/`.

Korean translation: [`PERFORMANCE.ko.md`](./PERFORMANCE.ko.md). The English
file is canonical; on conflict, English wins.

## Principles

### 1. Minimal subscriptions

A component subscribes, via selector, only to the data it actually renders.

- Forbidden: bare hooks with no selector (`useSessions()` / `useSettings()`) —
  every store write re-renders that component and all of its children.
- Whole-store subscriptions (`useSessions.subscribe(cb)`) are the same — the
  callback runs on every write, so expensive callbacks must be coalesced per
  frame (principles 4 and 5).
- Use a `useShallow` pick when multiple fields are needed. Actions are stable
  references fixed at definition time, so per-action selectors are safe.

### 2. Render boundary = data boundary

`React.memo` boundaries match data-ownership units (GroupArea=content,
FileViewer=view, ProjectPane=project …). Props crossing a boundary guarantee
referential stability (useCallback / stable selectors / refs). Custom
comparators are forbidden — they breed staleness bugs. A memo that does not
hold with the default shallow compare has a wrong design.

### 3. Separate transient from durable state

Mid-gesture values (drags) are transient state. Commit to the store (durable
state) once at gesture end — or, when visual tracking is required, at most
once per frame. Writing to the store on every mousemove is forbidden.

### 4. High-frequency events run once per frame

Continuous-input handlers (mousemove, dragover, scroll-linked work) are
coalesced to once per frame with `rafThrottle` (src/lib). At gesture end,
`flush()` commits the final value — before removing listeners, or the last
frame is lost and the UI snaps back.

### 5. Expensive side effects run once, after input settles

IPC (invoke), PTY resize (SIGWINCH), and native-webview move/resize run once
after input settles (trailing debounce). Storms cost not only active-phase CPU
but **delayed spikes** (e.g. hundreds of SIGWINCHes → a TUI redraw cascade for
seconds). Forced layout reads (getBoundingClientRect etc.) never run
synchronously per render — move them to rAF timing.

#### 5a. Visual continuity during gestures (freeze-frame)

Deferring a native surface's bounds commit (settle-then-once above) must not
expose a visual gap: during the gesture the slot moves live while the native
surface below holds its stale bounds, so the pane appears torn or blank.
The rule: a user gesture never shows discontinuous content.

- The core emits the gesture fact (`layout.resize-gesture` plugin event, start
  and end) and provides capture (`app.webview.captureRegion`). It does not
  know what providers do with them.
- A native-surface provider covers its slot with a stand-in for the duration:
  capture the slot at gesture start, show it top-left anchored without
  scaling inside an opaque container (slot growth must not reveal the stale
  native beneath), commit bounds exactly once at gesture end, remove the
  stand-in after the native has repainted. On capture failure, fall back to
  the pre-existing behavior rather than blanking content.
- Engine-sidecar surfaces (outside the core layer system, composited above
  the DOM) are orchestrated by their provider plugin, not by the relay: the
  stand-in must be mounted before the surface hides (hide-first would blank
  the pane until the capture arrives) and the surface must be shown again
  before the stand-in is removed. The sidecar host-fact relay
  (`resize-gesture`) exists for engines that have no DOM-side provider.
- This does not conflict with the [HARD] rule below: the stand-in is a
  deliberate, temporary visual bridge over a deferred resize whose end state
  is a true repaint — not a cover-up of a rendering artifact.

### 6. Preserve the platform paint path

CSS that breaks WebKit's composited (async) scrolling or composited layers is
forbidden. Canonical example: global `::-webkit-scrollbar` customization
(forces the legacy scrollbar path). Prefer standard `scrollbar-width` /
`scrollbar-color`. Suspected patterns must be verified with an A/B harness
measurement before adoption.

### 7. No completion without measurement

A change that touches performance ships with before/after numbers from
`scripts/perf/run.sh`. Scenarios (S1–S7) and the gate procedure are in
`scripts/perf/README.md`. Read both the active phase and the tail — tail
regressions signal side-effect storms.

## Plugin performance contract

Plugin event handlers (`onDidChangeActiveView` etc.) run **synchronously on
the main thread**. Do not do heavy work (parsing, network post-processing,
bulk DOM) inside the handler — defer it. The host coalesces state diffs per
frame, so events describe the final state; do not depend on per-tick
intermediate values.

## Terminal renderer — WKWebView composite stretch (invariant)

Symptom: during a macOS window-edge drag (live resize), terminal glyphs
stretch (blurry scaling). DOM (tabs, sidebar) stays crisp; only the terminal
distorts.

Root cause: during live resize AppKit stops redraws (`inLiveResize`) and
scales the GPU-composited layer (the WebGL/Canvas renderer's `<canvas>`) to
the new window size as a CALayer (`layerContentsRedrawPolicy` stretches layer
contents unless explicitly redrawn). DOM stays sharp because WebKit
re-rasterizes tiles every frame. Chromium avoids this with a synchronous paint
in the resize callback; WKWebView has no such path, and Safari shows the same
symptom. In short, **WKWebView + GPU canvas cannot structurally avoid resize
stretch** — the canvas is a WebKit-internal composited layer whose
contentsGravity we cannot touch.

Rules:

- The default terminal renderer is WebGL (`xtermRenderer: "webgl"`) —
  throughput first (the user default). Composite stretch during window resize
  comes with it (cause above). This default chooses throughput over resize
  fidelity.
- Switch to DOM when resize fidelity matters — WebKit re-rasterizes DOM every
  frame, so it does not stretch. Settings "terminal renderer" or
  `sok settings.set '{"key":"xtermRenderer","value":"dom"}'`. Live terminals
  switch in place (WebGL addon load/dispose).
- [HARD] Workarounds that hide the stretch by covering the body are forbidden
  — concealment is not a fix. Renderer choice (DOM) is the only root remedy.
  (The gesture stand-in of 5a is not this: it bridges a deferred resize and
  ends in a true repaint.)

Evidence (2026-06 investigation, URLs verified):

- NSView.LayerContentsRedrawPolicy — `never`/`onSetNeedsDisplay` stretch layer
  contents on resize without an explicit redraw (`duringViewResize` redraws
  every frame):
  <https://developer.apple.com/documentation/appkit/nsview/layercontentsredrawpolicy-swift.enum>
- Cocoa Live Window Resizing — `inLiveResize`; content preservation is an
  opt-in optimization:
  <https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/CocoaPerformance/Articles/CocoaLiveResize.html>
- MTKView/SKView live-resize content stretch (CALayer contentsGravity + halted
  redraw): <https://developer.apple.com/forums/thread/94765>
- servo/webrender #1640 — on macOS "a frame must be drawn before returning
  from the resize callback" (without synchronous paint, content lags/scales):
  <https://github.com/servo/webrender/issues/1640>

Code anchor: renderer selection lives in the terminal plugin
(soksak-plugin-terminal, `src/terminal.ts` `xtermRenderer`).
