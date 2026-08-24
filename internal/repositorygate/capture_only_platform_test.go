package repositorygate

import (
	"os"
	"strings"
	"testing"
)

func TestCaptureOnlyPresentationHasNativeLinuxAndWindowsOwners(t *testing.T) {
	linux, err := os.ReadFile("frameworks/wails/window_native_linux.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"func presentCaptureOnlyWindow", "C.soksakPresentCaptureOnlyWindow",
	} {
		if !strings.Contains(string(linux), required) {
			t.Errorf("Linux capture-only presentation omits %s", required)
		}
	}

	windows, err := os.ReadFile("frameworks/wails/window_native_windows.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"func presentCaptureOnlyWindow", "w32.WS_EX_LAYERED", "w32.WS_EX_TRANSPARENT",
		"w32.WS_EX_NOACTIVATE", "w32.SetLayeredWindowAttributes", "w32.SWP_NOACTIVATE",
		"w32.SWP_SHOWWINDOW",
	} {
		if !strings.Contains(string(windows), required) {
			t.Errorf("Windows capture-only presentation omits %s", required)
		}
	}

	if _, err := os.Stat("frameworks/wails/window_capture_attendance_other.go"); err == nil {
		t.Fatal("unsupported platforms still receive a no-op capture-only fallback")
	} else if !os.IsNotExist(err) {
		t.Fatal(err)
	}
}
