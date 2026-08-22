# 창 캡처

`window.snapshot`, `window.pixels`, `window.record`는 하나의 플랫폼 캡처 backend와 하나의
공통 pixel pipeline을 사용합니다. 캡처는 창에 focus를 주지 않습니다. backend가 없는
플랫폼은 명시적으로 실패하며 빈 이미지를 성공으로 처리하지 않습니다.

## Backend

- macOS는 ScreenCaptureKit으로 이 프로세스의 창을 캡처합니다.
- Linux는 GTK main thread에서 GTK4 render node를 snapshot합니다.
- Windows는 `PrintWindow`와 `PW_RENDERFULLCONTENT`로 HWND를 off-screen 32-bit DIB에
  렌더합니다. desktop을 읽거나 창을 앞으로 가져오거나 화면 pixel로 fallback하지 않습니다.

Windows adapter는 HWND, DC, bitmap, DPI, resource lifetime만 소유합니다. BGRA 변환, alpha,
stride 검증, CSS point에서 pixel로의 crop, 경계 clamp, PNG encoding은 플랫폼 비종속
코드가 소유합니다.
같은 HWND 경계가 document content extent도 보고합니다. Windows는 `GetClientRect`로 client
rect를 읽고 `GetDpiForWindow`로 device pixel을 DIP로 변환합니다. Window frame은 non-client
chrome이 포함된 다른 사각형이므로 content size fallback으로 사용하지 않습니다.
`ui.verify`는 content rect를 읽지 못하면 frame과 비교한 척하지 않고 unanswered로 판정합니다.

## 검증

로컬 테스트는 native frame을 주입하여 decode한 PNG pixel, padding stride, DPI crop, 빈 crop,
잘못된 frame, 실패, resource release를 검증합니다. `GOOS=windows`의 `go list`는 Windows
backend를 선택하고 unsupported stub을 제외해야 합니다. M1 Docker는 Windows amd64 package
test, 앱, CLI, system-test binary를 cross-build합니다. HWND와 WebView2 동작의 최종 판정은
GitHub `windows-2025` system suite가 수행합니다.
