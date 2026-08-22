# Window capture

`window.snapshot`, `window.pixels`, and `window.record` use one platform capture backend and one
shared pixel pipeline. Capture never focuses a window. A platform without a backend fails by name;
an empty image is never a successful result.

## Backends

- macOS captures this process's window with ScreenCaptureKit.
- Linux snapshots the GTK4 render node on the GTK main thread.
- Windows renders the HWND into an off-screen 32-bit DIB with `PrintWindow` and
  `PW_RENDERFULLCONTENT`. It does not read the desktop, bring the window forward, or fall back to
  screen pixels.

The Windows adapter only owns HWND, DC, bitmap, DPI, and resource lifetime. BGRA conversion, alpha,
stride validation, CSS-point-to-pixel crop, clamping, and PNG encoding are platform-neutral code.

## Verification

Local tests inject native frames and verify exact decoded PNG pixels, padded strides, DPI crops,
empty crops, malformed frames, failures, and resource release. `go list` under `GOOS=windows` must
select the Windows backend and exclude the unsupported stub. M1 Docker cross-builds the Windows
amd64 package test, application, CLI, and system-test binaries. The GitHub `windows-2025` system
suite is the final runtime verdict for HWND and WebView2 behavior.
