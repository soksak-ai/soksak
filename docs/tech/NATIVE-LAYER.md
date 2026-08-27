---
kind: canonical
status: active
canonical: self
---

# Native layer


Rules for the code that touches the platform directly, and for the boundary that
keeps the rest of the application away from it.

## Why cgo is here at all

The framework compiles with cgo on macOS and Linux — its own window and webview
are written that way. A build on those platforms is a cgo build whether or not we
add a line of it, so "no cgo" is not an available goal there.

Windows is different: the framework arrives at WebView2 through COM in pure Go, so
that target cross-compiles from any host with no toolchain.

That is the whole shape of the concern. Cross-compilation is the reason to avoid
cgo, and Windows is the only place avoiding it changes anything.

## N1. The cgo surface is small and fixed

Everything that can be pure Go is pure Go: inventory validation, sequencing,
batch planning, and receipts hold no platform call. cgo includes one layer —
"apply this batch on the main thread and report the frames that resulted."

The set of files that import `"C"` is fixed. A new one needs a stated reason.

## N2. Native source is defined in its own files

Objective-C, C, and C++ go in `.m`, `.h`, and `.c` files. The cgo preamble holds
only `#cgo` directives and an `#include` of our own header.

Inside a comment there is no syntax highlighting, no separate compilation unit,
and no way to test the native code on its own terms. The framework itself is
written this way.

## N3. Windows stays cgo-free

Gate: `CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build ./...` runs in `task
verify`. Anything that pulls cgo into a Windows path turns it red immediately.
This is what keeps the cross-compilation concern a measured fact rather than a
preference.

## N4. Document view sizing stays with its platform owner

Wails owns document view sizing on Windows and Linux. Windows updates the WebView2 controller from
`WM_SIZE`; Linux updates its webview through GTK allocation. Core does not add a second sizing
contract for either platform.

macOS has one measured framework hierarchy defect: its document view can exceed the visible content
area by one point. Core repairs that hierarchy only in the Darwin implementation after each window
gets a native lifetime. The repair is not part of `WindowHost` and cannot block another platform's
boot.

## purego is not used

It was considered and rejected for three reasons, and the rejection holds only
while they do.

1. The framework creates the window. Reaching it through a separate FFI path
   means touching one Objective-C runtime two ways — the same rule implemented
   twice.
2. cgo has the compiler check C signatures. purego checks nothing, so a typo in
   a signature is a runtime crash.
3. The blocks and delegates this application needs would have to be hand-built
   as structures and runtime class registrations.

A known cost that N2 can pay down beats an unknown one.

## Capture

Window capture uses a platform compositor path. Every backend must preserve these properties:

- it needs no screen-recording permission, because it only sees our own windows;
- it needs no focus, and an occluded window still captures;
- it captures the compositor's result, so the main webview and every native
  child arrive in one image with no holes. A per-webview snapshot cannot do that.

macOS reads this process's own shareable content through ScreenCaptureKit.
If WebKit has produced no frame because the window is fully occluded, capture orders that window
front without making it key or main, waits for visible renderers to acknowledge one real frame,
then captures and restores the previous background ordering. It never activates the application,
uses private WebKit scheduling SPI, or polls.
`CGWindowListCreateImage` is obsolete on macOS 15 and blocks during rendering. It is not used.
Linux snapshots the GTK4 render node on the GTK main thread and encodes the resulting texture. It
does not read the X11 root window, so an occluded window remains capturable without focus changes.
Windows uses the HWND backend defined in [CAPTURE.md](CAPTURE.md). The shared pixel pipeline and
its local cross-build gates are documented there.

Output dimensions come from **one** filter snapshot: `contentRect` multiplied by
`pointPixelScale`. Mixing a window frame read earlier with pixels captured later
resamples a later moment to an earlier size, which during a live resize produces
a frame that was never on screen.

Platforms without a backend fail by name. Returning empty bytes would make "this platform cannot
capture" and "the window was blank" one answer, and nothing downstream could tell them apart.

## Native surfaces

The application declares surfaces in the DOM and never positions them. One
delivery includes a complete inventory; a stale sequence, a partial inventory, or
a second writer is refused before anything mutates; and one receipt reports what
was actually applied.

The coordinate contract is CSS points with a top-left origin, shared by the
declaration and the receipt so a compositing verdict is a subtraction rather than
a conversion.

The declaration vocabulary includes no framework name. The core writes these
attributes, so a framework name in them would make the core spell a framework it
otherwise never names.
