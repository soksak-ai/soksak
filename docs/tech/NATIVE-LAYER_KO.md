---
kind: canonical
status: active
canonical: NATIVE-LAYER.md
---

# Native layer

The English canonical is [`NATIVE-LAYER.md`](NATIVE-LAYER.md). Where the two differ, English wins.

Rules for the code that touches the platform directly, and the boundary that keeps the rest away from it.

## Why cgo is here

The framework compiles with cgo on macOS·Linux — the window and webview there are written that way.
A build on those platforms is a cgo build whether or not we add a line of it. "No cgo" is not an available
goal there.

Windows is different. The framework binds WebView2 through COM in pure Go, so that target cross-compiles from any
host with no toolchain.

That is the whole shape of the concern. Cross-compilation is the reason to avoid cgo, and the only place avoiding it changes anything is
Windows alone.

## N1. The cgo surface is small and fixed

Everything that can be pure Go is pure Go — inventory validation·sequencing·batch planning·receipt hold no
hold no platform call. cgo takes exactly one layer: "apply this batch on the main thread
and report the frames that resulted."

The set of files that import `"C"` is fixed. A new file needs a stated reason.

## N2. Native source goes in its own file

Objective-C, C, and C++ go in `.m`, `.h`, and `.c` files. The cgo preamble holds `#cgo` directives and our
header `#include`, and nothing else.

Inside a comment there is no syntax highlighting, no separate compilation unit, and no way to check that code on its own language's terms.
The framework itself is written this way.

## N3. Windows holds cgo at 0

Gate: `task verify` runs `CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build ./...`.
Anything that pulls cgo into a Windows path turns red immediately. It makes the cross-compilation concern not a preference but
a measured fact.

## purego is not used

It was considered and rejected for three reasons. The rejection holds only while those reasons hold.

1. The framework creates the window. Touching it through a separate FFI path drives one Objective-C runtime in two ways
   ends up touched — two implementations of the same rule.
2. cgo has the compiler check C signatures. purego checks nothing, so a typo in a signature
   is a runtime crash.
3. The blocks and delegates this application needs would have to be hand-built as structures and runtime class registrations.

A known cost that N2 can pay down beats an unknown one.

## Capture

Window capture reads this process's own shareable content through ScreenCaptureKit. That path is required, and
every part of the reason must stay true.

- No screen recording permission is needed — only its own window is in the capture;
- No focus is needed, and an occluded window is captured too;
- It takes the compositor's result, so the main webview and every native child arrive in one image with no holes.
  A per-webview snapshot cannot do that.

`CGWindowListCreateImage` is obsolete on macOS 15 and blocks during rendering. It is not used.

Output size comes from **one** filter snapshot: `contentRect` × `pointPixelScale`. A window frame read earlier
frame with pixels captured later resamples the later instant at the old size, and during a resize
it produces a frame that was never on screen.

A platform with no backend fails with its name. Returning empty bytes would make "this platform cannot
capture" and "the window was blank" one answer, and nothing downstream can separate the two.

## The native surface

The application declares surfaces in the DOM and never positions them. One delivery holds a complete inventory,
a stale sequence, a partial inventory, and a second writer are refused before the mutation, and one receipt actually
reports what was actually applied.

The coordinate contract is a CSS point with a top-left origin, and the declaration and the receipt share it — so a compositing verdict
is a subtraction rather than a conversion.

The declaration vocabulary has no framework name. The core writes this attribute, so a framework name in it
would make the core spell a framework it otherwise never names.
