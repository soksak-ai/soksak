# Window capture

`window.snapshot`, `window.pixels`, `window.record`, and `window.burst` use one platform capture backend and one
shared pixel pipeline. Capture never focuses a window. A platform without a backend fails by name;
an empty image is never a successful result.

## Backends

- macOS captures this process's window with ScreenCaptureKit. A fully occluded window is ordered
  front without focus, each visible renderer acknowledges a real frame, and the window returns to
  background ordering after the read.
- Linux snapshots the GTK4 render node on the GTK main thread.
- Windows renders the HWND into an off-screen 32-bit DIB with `PrintWindow` and
  `PW_RENDERFULLCONTENT`. It does not read the desktop, bring the window forward, or fall back to
  screen pixels.

The Windows adapter only owns HWND, DC, bitmap, DPI, and resource lifetime. BGRA conversion, alpha,
stride validation, CSS-point-to-pixel crop, clamping, and PNG encoding are platform-neutral code.
The same HWND boundary reports the document content extent: Windows reads the client rect with
`GetClientRect` and converts device pixels to DIPs with `GetDpiForWindow`. A window frame is not a
content-size fallback because non-client chrome makes it a different rectangle. `ui.verify` treats
an unavailable content rect as unanswered rather than silently comparing against that frame.

## Bursts

`window.record` takes one capture per frame, and one capture costs about 120ms on macOS: the
shareable-content query, the screenshot, and the PNG encoding. A change that is over within one
display frame (16ms) is between two of its frames. Measured 2026-09-05: the blank pane between a
surface and its picture was in no recording and visible to every eye.

`window.burst` is the platform stream. On macOS a ScreenCaptureKit stream of this process's window
runs for `durationMs` and every complete frame the compositor produced is copied off the delivery
queue, encoded on a concurrent queue, and written as `dir/f0000.png ...`. The report holds one
time per frame in milliseconds from the start of the stream, so the duration of a state is the
difference between the frames that bracket it. A frame whose content did not change is not
delivered; a burst of a still window is a short list. The region axis is the same as a single
capture (`rect`, `node`, `tab`), and the window is ordered front without focus for the span the
same way. The raw bytes waiting for an encoder are bounded by `maxBytes`; the burst ends early by
name when they would pass it. A platform without a stream backend refuses by name.

## Inactive tab targets

An inactive `tab` target is activated only for the read. Core waits for the target tab's public DOM
presentation commit, then uses the same event-driven layout and native presentation barrier as
`ui.layout.wait-settled`. Pixel capture starts only after both stages settle. Core restores the
previous active tab and space after the read and on settlement or capture failure. This path uses no
sleep or polling and has no renderer-specific branch.

## Verification

Local tests inject native frames and verify exact decoded PNG pixels, padded strides, DPI crops,
empty crops, malformed frames, failures, and resource release. `go list` under `GOOS=windows` must
select the Windows backend and exclude the unsupported stub. M1 Docker cross-builds the Windows
amd64 package test, application, CLI, and system-test binaries. The GitHub `windows-2025` system
suite is the final runtime verdict for HWND and WebView2 behavior.
