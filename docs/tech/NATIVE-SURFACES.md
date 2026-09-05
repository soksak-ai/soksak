---
kind: canonical
status: active
canonical: self
---

# Native surfaces — declared, applied, and the difference between them

A native surface is content the window shows that is not in the document: a web
view, and later anything else that needs its own process or its own renderer.
The document states where one goes and what it should show. The native layer puts
it there and reports back. **Judgement is the difference between the two, and
the difference is zero.**

This document is the contract for that seam. `tech/NATIVE-LAYER.md` states why cgo
is present and where it may live; this states what the layer above it promises.

## Scope

The core owns the declaration, the inventory, and the judgement. It owns no
surface kind. "Browser" is a plugin's word (C1) and appears here only as the one
kind that exists today.

---

# D. Declaration — the document states what exists

## D1. A surface exists because a node declares it

Seven attributes on one element, and the next inventory commit creates the
surface. Remove the node and the same commit destroys it.

```
data-native-surface       the provider kind ("webview" or "terminal")
data-native-surface-id    the id the surface is reported under
data-native-generation    raise it to have the surface rebuilt
data-native-source        JSON the kind reads; for a browser, {"url": …}
data-native-visible       "true" | "false"
data-native-alpha         0..1
data-native-layer         paint order among surfaces
```

The vocabulary has no framework name in it. `data-wails-native-surface` would
put one host's name in a declaration the core writes and every other host would
have to read (P1).

A view that declares a surface also declares it in the manifest —
`contributes.views[].nativeSurface: true`. The attribute makes the surface
exist; the manifest is what anything outside the plugin can ask. Measured
2026-08-16: no plugin in this workspace declared it, including the one with a
browser in it, so the host's own `ownsNativeSurfaceFromManifests` answered false
for the single view that had a surface and no check reported a fault. The
plugin's own gate now fails the build when the source writes the attribute and
the manifest omits the declaration, and when the manifest declares one and no
source writes the attribute.

## D1b. Nothing in the document orders a surface

`data-native-layer` orders surfaces among themselves. It does not place one relative to the document:
a surface is composited above the page, so no `z-index` puts a modal over it. Every provider uses
the contract default `0`; a provider must declare a non-zero layer explicitly when it needs ordering.

Core resolves three different facts. `contentVisible` is the active workspace, space and tab chain;
it controls the DOM slot and never changes because an overlay or layout motion begins.
`surfaceVisible` additionally excludes an overlay. Layout motion remains a live compositor
transaction; hiding every surface during motion produced a blank target that had no pixels to capture.
Core publishes it as `data-surface-visible` on the host tab ancestor; this field is an observable
verdict, not a direct writer of the native declaration. Overlay parking has one ordered owner: Core
keeps the declaration applied, captures the surface, publishes the `ParkedPicture`, and changes the
declaration to hidden only after publication completes. A failed capture keeps the live declaration
applied and is reported by `state.health.parking.failures`; it cannot turn failure into a blank pane.
The picture remains in the same slot until the live surface returns. Neither side rewrites the
other's declaration.

Intrinsic means provider availability inside the Plugin, not another copy of Core presentation.
A mounted browser therefore keeps it true. A terminal Workbench may set it false for one of its own
maximized-away panes, but changing workspace, tab or overlay presentation does not. Terminal Kit
publishes `intrinsicVisible`, `hostVisible`, their `effectiveVisible` conjunction and `dim` as four
separate facts; Vision writes only the first into the native declaration. The installed v7 closure
with Browser 0.0.8, Terminal Kit 0.0.77 and Vision 0.0.16 measured both the inactive terminal and
active browser declarations intrinsic-true while Core presentation selected only the browser.
`surface.inventory` reported ghosts, unowned, unapplied and orphans all empty.

These facts are separate because they have separate owners. Combining them hid every DOM terminal
under a modal and during sidebar motion. Combining the live surface and its pixel substitute left a
blank pane. The tab slot exposes `contentVisible`, `surfaceVisible` and `visibilityReason` through
`ui.tree`; `state.health` exposes both the input-blocking overlay count and the native-occlusion count.

Only an overlay whose declared geometry covers native panes requests native parking; bounded menus
do not. When parking is requested, native surfaces are absent from the composed PNG only after a
successful surface picture is available.

WebKit can complete the first capture-only document snapshot after a document change with pixels from
before that change. `window_capture_present` completes and discards exactly one document snapshot
before it returns. The following `window_snapshot_region` request returns the requested pixels. This
preparation runs for every capture-only read and never runs for interactive compositor capture. It
does not inspect pixels, retry, poll, or activate the application. Capture metadata includes
`presentationOrdered`.

Interactive delivery separates geometry from presentation ownership. A snapshot that changes only
frames may return without making the bridge receipt own the next document frame. A change to surface
id, generation, kind, source, visibility, alpha or layer waits for the real compositor receipt. The
signature excludes frame coordinates and includes every presentation field. This is necessary but
not sufficient for an atomic tab switch: the DOM presentation commit must also be staged against that
receipt. `tab.switchScan.nativeMismatchFrames` remains the verdict for that final ordering.

Interactive does not mean deferred geometry. Every divider preview commits the complete declared
rectangle to each native kind before that preview is judged: terminal host frame, browser host frame
and browser `WKWebView` viewport. `layout.trace.native` joins every drawn DOM frame to the latest
completed compositor Apply and compares both `applied` and provider `settled` rectangles when the
provider exposes the latter. A moved clipping host with a stale page viewport therefore fails the
same frame with `wrongFrames > 0`; mouse-up cannot turn those earlier frames into a pass.

Each divider preview marks its layout state write as immediate geometry. The matching React layout
commit consumes that marker and records the new rectangles without creating FLIP animation. The
marker is associated with the state write, not callback duration: React may commit after the native input
callback returns, and a background window may pause animation. The landing preview and the single
`pane.resize` command execute in one synchronous DOM transaction before the resize-motion end event.
`ui.tree`, `surface.composition`, and `ui.motion` verify the result: pane, slot, and native surface
rectangles agree, declared/applied drift is zero, and a divider preview creates zero FLIP animations.

Divider resize uses an explicit geometry transaction. Core calculates target rectangles from the
next split layout and the fixed offsets currently reported inside each pane. The native compositor
applies that full inventory first. Core applies the matching store and DOM update immediately after
the receipt. While one application runs, the transaction retains only the latest pending pointer
value. It starts each native application in a task posted by the preceding document frame, which
leaves a complete frame interval for the receipt and DOM update. The task has a finite 50ms failure
limit for a document that produces no animation frame; it does not poll.

Surface coordinates use the same 0.01 CSS-pixel precision as the public layout trace. This removes
floating-point serialization residue from the actual command values instead of increasing the trace
tolerance. A non-key 16-step, 800ms divider run with concurrent 36-frame recording produced 108
compared frames, 97 compositor samples, `wrongFrames=0`, `worstAppliedOff=0`, and
`worstSettledOff=0` at tolerance 0. The recorded intermediate frames showed the terminal, browser
viewport, and pane lines at the same split position.

An inactive document applies command-driven layout changes without FLIP. WebKit does not advance
WAAPI in a non-key window, so an animation created there can retain the previous rectangle after
state and native geometry contain the new rectangle. `layoutRectMotion` checks `document.hasFocus()`
when it creates FLIP. A false result records `layout-rect-skipped(inactive-document)` and keeps the
committed rectangle as the next baseline. This uses the current window state and does not use polling.

## D1b.1. Nothing is drawn above a native child; the slot pays the frame

A native child is laid out in the body slot and drawn above the document. The
frame and the focus mark are drawn by the document, in the lanes at the pane's
left and right edge; so the slot pays those lanes out of its own budget
(UI-GEOMETRY B5), as the bands above and below it pay the top and bottom. A child
inside the slot then covers no line the document draws, and no Core chrome is
drawn in a native plane.

Measured 2026-08-30 with a linked browser, before the slot paid: the child
reached the pane's edge and the left, right and bottom probes inside it were the
page's white. The answer then was a second frame, a `CAShapeLayer` plane above
every child, re-raised after every surface commit and fed by every render.
Measured 2026-09-05 after a rail travel: that plane held a pane's frame 41 points
inside the pane for the rest of the session, while the document declared every
stroke at the right place — two drawings of one line disagree, and the one above
wins. The plane is gone; the frame is one line, in one medium.

The relation overlay draws its projected seam in the corridor between the rail
and the pane (split-pane R5): two cards never touch, so no child is under it.

## D1c. A surface reports the pointer, and the core moves the focus

A page receives its own clicks and the document above it never sees them, so a click inside a
browser left the focused pane where it was — measured 2026-08-17, while a click on that pane's tab
moved it.

`content-view-activated` is the name for it, in `core/contentview/events.go` and
`lib/contentViewEvents.ts`, and it carried the comment "the user clicked this view — the only fact
pane binding must follow" while nothing emitted it and nothing subscribed. The concept was settled;
the wiring was not.

Three parts, each holding only what it alone records.

The plugin that owns the native views sees the click and reports **a point and the window handle it
landed in**. It determines nothing about which surface that is: an earlier attempt walked the native
view tree here and landed short by the title bar's height, because `hitTest:` takes its point in the
receiver's superview coordinates and the walk had converted once already.

The compositor answers **which surface is under the point** — `SurfaceAt` — because it holds every
applied rectangle in the contract they are declared in (A2). The applied one, not the declared: the
point came from the screen. Topmost by layer, and a surface that is invisible or fully transparent is
not there to be clicked. It is a rectangle test over numbers the service already has, so it needs no
window to be checked.

The core determines **what focus means** — which pane, which tab, what the lighting follows — on
`content-view-activated`. A plugin owning a surface writes one report and gets the rest, and two
plugins cannot answer differently.

Not offered to plugins as a subscription. A plugin moving focus itself would be a second rule about
one thing.

## D1a. The label: the shape is the core's, the kind is the plugin's

A surface label is `<kind>.<window>.<viewId>` — the delimiter and the field alphabets are
NAMING.md N3's, and `frontend/src/lib/surfaceLabels.ts` is the one assembler.

The **window in the middle** is what makes the value unique across the
application. A view id is already unique inside a window, so a label rebuilt
without the window part makes two windows produce one value, and the second
window addresses the first window's surface. The shape is therefore the core's,
in `frontend/src/lib/surfaceLabels.ts`, and a plugin gets a label from
`app.webview.label(kind, viewId)` rather than assembling one.

The **kind** is the plugin's word, and the same word the declaration puts in
`data-native-surface`. Measured 2026-08-16: the core held `brw-` and handed a
browser its own identifier through `app.webview.label(viewId)`. The one plugin
that draws a browser could not have been replaced without an edit to the core,
and a second kind of surface had nowhere to obtain a label. `history_gate_test.go`
now fails the build on a surface kind written down anywhere in `core/`,
`frameworks/` or `frontend/src`.

Reading goes the other way, and stays kind-blind. `viewIdFromSurfaceLabel`
skips everything before the window part without reading it, so a plugin this
core has never been told about still resolves to a view. Going from a view to
its label, the core **reads the declaration** — `surfaceLabelOfView` takes
`data-native-surface-id` off the element rather than rebuilding it. A rebuild
needs the kind, and it agrees with itself about a label the plugin never used,
which is a lookup that finds nothing and reports no fault.

## D2. There is no open call, and no close call

The declaration is the lifetime. `webview_close` and `webview_recover` are
declared unserved with the reason: a command that closed one surface is a second
writer, and the next full commit reconciles against the declaration and puts it
straight back. The caller would watch it return with nothing to read.

## D3. One delivery includes a complete inventory

Not a diff. A stale sequence, a partial inventory and a second writer are all
refused before anything mutates, and one receipt comes back from the same
commit that applied it.

## D4. The sequence only rises

A backend refuses a number it has already passed. An observer that replaces an
earlier one resumes from where that one stopped; starting again from one has
every later commit rejected, and the screen freezes at the last inventory that
landed with the refusals visible only in the receipt.

## D5. A foreign call never owns the readable compositor lock

`Commit`, `Deliver` and `Drain` are writer transactions and are serialized with each other. The
mutex protecting receipts, compositions, hit testing and history is released before resolving a
window or calling a backend. Those calls may synchronously enter AppKit, while an AppKit pointer
callback calls `SurfaceAt` and reads that same state.

Measured 2026-08-28 with three terminal panes: a commit held the compositor state mutex and waited
in terminal `Apply` for `dispatch_sync(main)`; a native mouse-down on the main thread entered
`SurfaceAt` and waited for the mutex. Both sides waited forever, terminal place/display calls piled
up, and macOS reported the application as not responding. CPU stayed near idle; adding retries or a
timeout would only hide the lock cycle.

The compositor therefore has a separate backend-writer lock. While a backend applies, readers
return the last completed snapshot. A successful result becomes the next completed snapshot under
the short state lock. A backend must not recursively start another writer transaction. Owner tests
use an immediate lock probe at every backend boundary, and a platform system gate opens and clicks
multiple surfaces to prove the application main loop still answers.

---

# A. Application — the native layer answers

## A1. Both halves come from one commit

`Latest(window)` answers one paired composition: per surface, what the document declared, what the
native layer reported back, and the difference between them. Reading the declaration from the
document instead would compare a later frame against an earlier application, and the difference
would be blamed on the native layer.

The subtraction is the compositor's, as of 2026-08-16 — it is what holds both halves in one
instant. The core kept its own until that date, so one number had two definitions and the value a
person read depended on which path answered.

## A2. The coordinate contract is CSS top-left

Both halves. The platform's own origin is converted once, inside the driver, so
a reader never subtracts two numbers that are not comparable. `surface.composition`
names the frame it answers in.

## A2a. A declaration is recollected while the element moves

Three things change where a surface is owned: an attribute written on the
declaring node, its box changing size, and the node **travelling**. The first two
have events. The third has none — an engine animating a pane's position writes no
style and changes no size — so a surface whose rectangle is only recollected on
mutations and resizes stands still while its pane leaves.

Measured 2026-08-17 in a window with a terminal top left, a browser under it and a
browser on the right: the pane travelled 165 → 584 over 190ms and the page stayed
at 165 for the whole of it, then appeared at the far end in one frame — 420 points
from its pane, for 166ms, on every move that changed which pane held the focus.
Every composition reading through that reported zero drift, because both halves
came from the same stale commit (A1).

So the observer measures the declared elements once a frame and commits when one
of them differs. A still window commits nothing: the reading is a handful of
rectangles per frame, and only a difference schedules a snapshot. After the
change the same six moves hold the page within one or two readings of its pane —
which is the floor, the rectangle being measured after the layout commit and
applied across a process boundary.

## A3. A surface with one half is not a difference

Declared and never applied goes to `unapplied`. On screen and never declared
goes to `undeclared` — the surface a ledger-only check cannot see, because the
ledger is what it walks. Folding either into the difference would answer a
number for something that has none; folding it into zero would call a pane with
no surface correct.

---

# V. Verdict — what makes it RED

## V-1. Tab and space switches use the recorder frame clock

`tab.switchScan` and `space.switchScan` start a finite `window.record` burst. The recorder callback
runs only after one frame file is saved; `applyAtFrame` activates the target from that callback.
The activation has a unique `causeTraceId`, and the scan waits for the terminal event of that
exact layout transaction and the event-driven presentation barrier. It does not wait for elapsed
milliseconds or poll layout state. Recording begins only after the requested starting view is fully
presented; otherwise its delayed recovery is misclassified as part of the measured switch.

Each saved frame samples both sides through the public visibility model. A DOM view is presented
when its tab slot has `contentVisible=true`. A native view also requires either a visible surface in
the latest compositor receipt or a `ParkedPicture`. `surfaceVisible` and the applied live-surface
receipt must agree while content is visible. The result reports `blankFrames`, `overlapFrames`, and
`nativeMismatchFrames`. Pixel analysis comes from Core `capture_analyze`; changed frames below 40%
of the measured transition peak are noise above the absolute floor, not extra switch frames.

A snap or same-geometry switch requires exactly one pixel transition frame. A declared glide may
span several captured frames; its GREEN is instead every recorded motion journey finishing, no
cancelled or incomplete journey, and zero blank, overlap and native-mismatch frames. WKWebView may
expose a completed animation state before dispatching its finish callback in a non-key window. The
finite scan reconciles that final state once: `finished` is complete; a removed `idle` animation is
complete only after its declared duration (adjusted by playback rate) and when its landed rectangle
matches the target within half a pixel. An earlier or displaced removal is cancelled. This is one
final state read, not polling or an added delay. The command restores the original tab or space
through another exact layout transaction.

## V0. `sok layout.alignment` is what a person sees

`surface.composition` compares the declaration against the application, and both
come from one commit — so they agree with each other while the commit is stale,
and a page drawn 420 points from its pane reads as zero drift (A2a). The reading
that answers where a page **is** compares the declaring element **now** against
the surface **now**:

```
dom        the declaring element's box in this instant
declared   the box the last commit sent, written back on the element
applied    the box the native layer holds
lag        dom vs declared      — how far the declaration has fallen behind
drift      declared vs applied  — what the native layer did with what it got
off        dom vs applied       — the whole distance a person sees
regions[]  the rails, read in the same pass
panes[]    the panes, read in the same pass
over       how far a page is drawn into a region's band
```

Regions and panes come from the same pass because a seam is a difference between
two rectangles: reading them a frame apart makes a moving window
indistinguishable from a broken one — measured 2026-08-17, an 83 point overlap
that was two honest readings of a travelling pane.

**GREEN is `off` and `over` inside one or two readings of a change, and zero
while nothing moves.**

## D4a. A page steps aside, and its picture stays

Everything the document draws over a page is drawn under it: a card, a rail
crossing a pane, a region taking its width. There is no z-index that orders a
surface below the document, so the only way to show any of them is to take the
page off the screen — and a pane that goes blank is what a person reads as a view
that failed. Both halves were reported on 2026-08-17, in those words: the plugin
manager opened and the browser blanked, and a travelling rail passed under a page
that covered it by 155 to 160 points for 85 to 119ms.

So a parked surface leaves its picture. `ContentViewHost.picture(label)` answers
what the surface is showing as a data URL — the kind's own backend takes it and
the compositor forwards the message without reading it, so nothing in the core
names a browser or an engine — and the document draws it in the same box until the
surface is back.

Three rules the measurement wrote:

- **Taken before the surface goes.** A surface that is already hidden has nothing
  to photograph.
- **Held until the page is back**, read from the last commit's answer rather than
  from the request. Dropped when the show was asked for, the pane held neither for
  a reading.
- **Held only while the same active content is occluded.** Inactive tab, space and workspace chains
  release the picture; keeping it covers the new active owner. Layout motion keeps the live surface
  in the compositor transaction instead of replacing it with a picture.

What it claims to be is what it does: it does not scroll, it takes no click, and
it is one instant old, which is why the surface is put back the moment it can be.

Measured after, in a window in front, over all six ways focus can move in the
named window: a page covers a region for 0ms, the native layer holds the
document's rectangle exactly, the declaration is never behind, and no pane is ever
without its frame.

## D4b. Capture-only snapshots compose the same owners

The platform's capture-only window snapshot is intentionally document-only; native child surfaces
are not pixels of that document. Returning it as a complete window screenshot made a healthy
terminal look blank while its engine state and compositor geometry were both correct.

`surface.snapshot {id}` exposes one declared and applied surface owner's exact PNG. `window.snapshot`
uses the same owner interface for every applied visible surface only when the framework receipt has
`documentOnly=true`. Core clips each picture to the requested CSS-pixel region, maps it to the PNG's
pixel scale, preserves applied alpha and layer order, and draws it over the document image. A visible
surface that returns no PNG is a named failure; an incomplete image is not evidence. Interactive
captures already contain compositor pixels and are never composed a second time.

The v7 capture-only measurement returned `nativeComposed=true`, `surfaces=2`, `drawn=2`,
`documentOnly=false` while window input remained non-key before and after. Direct inspection showed
both native terminals, their distinct alpha, glyphs, cursor, and the engine-owned selection range.
The finite `window.record` loop uses the same operation for every frame, with the caller's explicit
interval, frame count, per-frame deadline and byte budget. A v7 three-frame run wrote three
589,723-byte PNGs with the same SHA-256 because the screen did not change; each frame contained both
native terminals and the selection, and window input remained non-key before and after.

## D4c. Native divider injection preserves the requested duration

`ui.input.drag` forwards `steps` and `durationMs` to `window_input_pointer_drag` for a native pane
divider. The framework delivers one down, the requested move count over the requested finite
duration, and one up. The command does not focus the window or move the system pointer. A recorded
drag can therefore measure intermediate DOM and native-surface geometry instead of only the final
ratio.

## V0a. `sok layout.trace` is what every frame held

One reading through the plane costs a round trip — 15 to 25ms on this machine — and a frame is
16.7ms, so a page that is behind its pane for one or two frames lands in one sample or two by
chance. The same motion was written down as 0ms in one run and 52ms in the next, and a person
watching the screen was right where the reading was silent.

`layout.trace.start {ms}` records inside the window, once per animation frame, before the paint:
every region, every pane, every surface's `dom` / `declared` / `applied`. The native half is the
answer to the last commit — which already includes the applied rectangles — so no round trip is made
for it. Each frame states:

```
drawn          which clock recorded it: the window's frame clock, or the timer that keeps the
               recording alive when the window is not drawing. Only the first can carry a verdict
               about motion.
appliedAgeMs   how old the native half is — the pipeline's latency, not the reading's
commitMs       what the commit that carried it cost
sinceLastMs    the gap from the reading before it
tickMs         what the recording cost the frame it was taken in (1ms, measured)
```

A window whose public frame clock has stopped records nothing, so `layout.trace.start` waits for the
first reading and refuses with that reason rather than answering an empty trace. Capture-only Darwin
windows remain compositor-resident, alpha-zero and non-key, which keeps the document frame clock
available without taking the foreground application. No private WebKit occlusion switch or
`window.occlusion` command participates in this contract.

Measured 2026-08-17 in the named three-pane window: the declaration follows the element exactly
(`lag` 0 in every case), the native layer holds what it was given (age-corrected difference 0), the
commit costs 1 to 2ms on a quiet machine and 45 to 71ms on a loaded one, and the window's own frame
clock runs every 18 to 32ms rather than every 17. The page trails its pane by one commit, so what a
person sees is set by those two numbers.

## V1. `sok surface.composition` is the judgement

```
worst                  the largest difference over every surface and component
unapplied[]            declared, never applied
undeclared[]           applied, never declared
misparented[]          applied in a window other than the one that declared it
nativeParentPresent    is there a container to attach to
failure/failedSequence the most recent attempt that did not land
```

**GREEN is `worst` 0, every list empty, and no failure.** Exact, with no
tolerance: both halves are the same float64 travelling one commit, so zero is
reachable. A tolerance chosen without a measurement hides the first hundredth of
a point of the next coordinate bug.

The answer is **per window**. `sok surface.composition window=<name>` is one
window's inventory and no other's. Measured 2026-08-16 with a window-blind
reading: the orchestrator and a workspace window each answered the same single
surface, at the same rectangle, with zero drift — while only one of them had a
browser in it.

`misparented` is separate because a window is not a distance, so it never folds
into `worst`. It is read back off the native object rather than restated from
the declaration: the backend reports which window the view ended up in and the
compositor compares that with the window it handed over. Every other number in
this answer describes a rectangle inside *some* window, so all of them read
correct while the rectangle is inside a window nobody is looking at. A backend
that reports no window is reported misparented rather than believed — silence is
what a backend that never learned to read the window back produces.

`nativeParentPresent` is separate because no container and no declarations are
both `worst` 0, and one of them is a broken window. `failure` is separate
because the compositor keeps answering with the last inventory that landed, so a
layer refusing every new one reports zero forever.

### Browser release idempotence — 2026-08-30

Browser 0.0.12 selects SDK 0.0.18 through the login-shell tool contract. Two independent
`make attest` outputs from source commit `d5a87a6` contained the same six files and were byte-for-byte
equal. Attesting the first completed output again returned `unchanged` for both the release and its
build receipt. Publishing that output to the local release store returned `published` and then
`unchanged`, with store digest `2f9a12b7601d89be9326c0c9f784c707982b4ba2502af832fa8ce70700dde6a0`.

An isolated capture-only installation resolved artifact
`2cefbcbbdf96ebbb7e0830ccc5c5f9c023859d86bf49d2722a052eb2fcafe79f`, loaded Example Domain to
`progress=1`, and reported one registered native surface with zero coordinate drift. Its capture
contained the browser chrome and the composed native page.

### Browser tab transition observation — 2026-08-30

An isolated browser 0.0.11 run with two native tabs used `tab.switchScan` for the same pane. The
machine result was `clean=true`, `flickerFrames=0`, `blankFrames=[]`, `overlapFrames=[]`, and
`nativeMismatchFrames=[]` across 30 frames. The focus-free capture showed both tab headers and the
active Example Domain page.
The run also exposed that pane-only navigation cannot distinguish tabs in one pane; browser 0.0.10
added an explicit `tab` target, and browser 0.0.11 extends that target to every browser command.
Runtime `navigate(tab=...)` and `status(tab=...)` returned the matching webview IDs for both tabs;
the 0.0.11 candidate has 51 tests GREEN and is locally published immutably.

Browser 0.0.12 was rebuilt from its clean owner checkout through `make attest` with SDK 0.0.18.
The generated `main.js` check, typecheck, 51 tests, two-candidate byte comparison, package receipt,
and native attestation all passed. Publishing that independently generated release to the existing
immutable local version returned `unchanged`, digest
`2f9a12b7601d89be9326c0c9f784c707982b4ba2502af832fa8ce70700dde6a0`. Browser frontend output is
therefore a declared release artifact, not a mutable source-directory or remembered `dist` input.

### Border geometry observation — 2026-08-30

In isolated browser release 0.0.9 on an arm64 Core build, the selected workspace reported the
browser surface at `(x=5,y=120,w=989,h=468)`. Its pane
frame and focus boundary both reported `(x=5,y=87,w=989,h=525)`; the frame had a
1px structural border and the focus boundary had a 1px outline. The rectangles
were identical, so this run is GREEN for the browser border geometry. It does
not certify terminal parity until a terminal using the corrected kit release is
installed and measured by the same selectors.

### Mixed browser and terminal lighting — 2026-08-30

An isolated two-pane layout held three browser tabs and two terminal tabs. Before the fix, the same
idle amount retained 183 of the browser page's original 238 but only 127 of the terminal's original
255. Fading a native view blended it with an already-dimmed document, so `alpha=0.5` did not mean
50% retained light.

The native webview service now places a pointer-transparent black veil at the window compositor
level for each native host. The capture-only compositor mirrors that operation: it paints the page
opaquely, then paints one black veil with `1 - alpha`. The resulting measurements were browser
`238→119` and terminal `255→127`, both 50% within integer pixel rounding. Twenty pane-focus
round trips left the browser at 119, proving the veil did not stack.

The focused pane frame and focus-boundary rectangles were equal in both halves: left
`(5,87,489.5,525)` and right `(504.5,87,489.5,525)`. Four 30-frame browser↔terminal scans, both
directions in both panes, each completed in one switch frame with zero flicker, blank, overlap,
native mismatch, cancelled motion, or incomplete motion frames.

### Native display lifetime under Plugin replacement — 2026-08-30

An isolated installed product held three live terminal surfaces and then enabled Browser 0.0.12.
The Core process terminated with `SIGSEGV` while a channel frame callback ran
`soksakChannelDisplay` and the compositor concurrently ran `soksakTerminalSurfaceRemove` for the
same borrowed native view. The failure was a native lifetime race, not a terminal engine, Browser,
or PTY failure.

Terminal-surface service `ec576f9` establishes two ownership rules. The backend unbinds a channel
view before the native driver transfers and releases it. A frame callback retains both the bound
view and its IOSurface while holding the channel mutex, releases the mutex, displays on the main
thread, and then releases both short leases. The named RED proved the native release previously ran
before unbind; GREEN proves unbind precedes release and the display lease is acquired under the
channel lock but displayed after unlocking. The complete service owner gate is GREEN.

The corrected Core restored the same three terminal tabs with Browser already enabled, opened an
Example Domain browser tab, and remained on the same Core PID through a Browser disable→enable
replacement. `surface.inventory` then reported four state views and four applied surfaces with no
ghosts, unowned, unapplied, or orphaned entries. Three terminal↔terminal and three
browser↔terminal 24/30-frame scans each completed in one switch frame with zero flicker, blank,
overlap, native mismatch, cancelled motion, or incomplete motion frames. A non-key composed capture
showed the browser plus all four tab headers and kept `windowFocused=false` before and after.

The same installed state passed the shared composition and border gates. `surface.inventory`
reported four declarations and four accepted surfaces with zero ghosts, unowned, unapplied, or
orphaned entries. `surface.composition` reported zero drift and zero misparented surfaces for all
three terminal surfaces and the browser surface. `layout.verify` measured the pane and its focus
boundary at the same `(5,87,989,525)` rectangle with `worst=0`; terminal and browser Plugin bodies
both measured `(5,120,989,468)`. The browser webview alone begins at `y=151` with height 437 because
the declared 31px browser chrome occupies `y=120..151`; this is Plugin content layout, not a
compositor inset. `ui.validate` checked 34 border rules over 14 elements with zero violations, and
the composed capture showed the complete focused outline on all four outer edges.

Measured 2026-08-16 on macOS at 999×535 and again at 1200×800: one browser
surface, `worst` 0 through a split, a gutter resize, maximize and restore.

### V1.1. One inventory covers every surface kind

`surface.inventory` compares three public facts for the current window: view state, DOM native-
surface declarations, and the compositor's latest accepted inventory. Browser and terminal
surfaces use the same command and the same rules. `surface.composition` remains the coordinate and
application verdict; `surface.inventory` is the ownership and existence verdict.

The framework adapter implements `list` and `alive` by reading the compositor receipt. A DOM
declaration is a request, not proof that the native layer accepted it. A framework-specific webview
list is incomplete because it cannot enumerate other surface kinds. The former
`webview.surfaces` command is removed rather than retained as an alias.

Window membership is parsed from the public `<kind>.<window>.<view>` label fields. Substring search
and kind allowlists are forbidden: the first depends on punctuation and the second makes a new
surface kind invisible to the inventory.

The last label field identifies a surface within a window; it is not a view-ownership inference.
One terminal view may declare several pane surfaces. Ownership is read from the declaration's
public `data-tab-id` ancestor. The inventory reports each missing relation separately:

```
ghosts[]    accepted by the compositor, absent from DOM declarations
unowned[]   declared and accepted, but no current state view owns the declaration
unapplied[] declared in DOM, absent from the accepted compositor inventory
orphans[]   the label names no live parent window
```

## V2. A verb is not a declaration

Back, forward, reload and stop leave the declared source exactly as it was, so
they cannot be expressed by declaring. They travel as messages: the compositor
checks the surface is in the applied inventory and forwards without reading, and
the backend for that kind reads the verb. A compositor that knew the verbs would
need editing for every kind added.

`navigate` writes the new address back into the record. Leaving it on the
declared one makes the next commit see a changed source and rebuild the surface
back to where it started.

## V3. What the page states about itself is not what was asked of it

A redirect, a load that failed and a load still running are all invisible in the
declared address, and on a screen that has not painted the three look the same.
`pageState` reads the surface; the reports push the same facts as they happen,
split into the content view events the page already listens for
(`core/contentview`).

The whole state travels in one report. Reading a second property afterwards
answers about a later moment, and a back button enabled one frame early is that
difference made visible.

## V4. Every refusal includes a name

An unknown verb, a missing url, a step of zero, a surface this backend does not
hold, a message after shutdown. Silence leaves a caller reporting a page as
moved while the screen disagrees.

---

# K. Known, and not fixed

Written down rather than left to be rediscovered (L2).

- **A capture is a composite, and the answer states it.** A window capture holds
  this process's own layers; a native surface draws in another process, so its
  rectangle arrives flat (measured 2026-08-16: a browser pane was a solid block
  while `status` on the same surface answered title "Example Domain", progress 1,
  loading false). The capture finishes the image by asking each surface for its
  own pixels, and the answer names `surfaces`, `drawn` and a reason for each one
  `skipped`.

  **A composite is not evidence that anything is on screen.** It draws a
  surface's pixels at the rectangle the inventory recorded, whether or not a
  person can see that rectangle. Measured 2026-08-16, before the inventory was
  per window: a capture of the orchestrator drew a workspace window's browser
  into it, at coordinates a 1300×900 document had computed, inside a 999×617
  window. The picture was of a page that was in neither place. For "is this on
  screen", read `presence` from `sok window.monitors` — `visible`, `key`,
  `main`, `miniaturized`, `occluded`, `alpha` — and `misparented` from
  `sok surface.composition`.
- **Windows and Linux have no driver.** They fail by name. An empty
  implementation that answered nil would report a navigation as done and leave a
  blank pane, which reads as a broken plugin rather than a platform this build
  does not cover.
- **`inPage` is always false on a navigation report.** The property this host
  observes cannot separate a move inside a document from a new one. Claiming
  true would tell a consumer the document did not change when it may have.
