//go:build windows

package wails

import (
	"unsafe"

	"github.com/soksak-ai/soksak-core/core/i18n"
	"github.com/wailsapp/wails/v3/pkg/w32"
)

func orderWindowFrontWithoutKey(window unsafe.Pointer) error {
	if window == nil {
		return i18n.Errorf("wails.window.noNativeLifetimeFront", nil)
	}
	handle := w32.HWND(uintptr(window))
	flags := uint(w32.SWP_NOMOVE | w32.SWP_NOSIZE | w32.SWP_NOACTIVATE | w32.SWP_SHOWWINDOW)
	if !w32.SetWindowPos(handle, w32.HWND_TOP, 0, 0, 0, 0, flags) || !w32.IsWindowVisible(handle) {
		return i18n.Errorf("wails.window.revealWithoutKeyFailed", nil)
	}
	return nil
}

var ErrActivationUnsupported = i18n.Errorf("wails.window.activationUnsupported", nil)

func activateApplication() error { return ErrActivationUnsupported }

var ErrTitleUnsupported = i18n.Errorf("wails.window.titleUnsupported", nil)
var ErrContentSizeUnsupported = i18n.Errorf("wails.window.contentSizeUnsupported", nil)
var ErrWebviewFrameUnsupported = i18n.Errorf("wails.window.webviewFrameUnsupported", nil)
var ErrWindowInputUnsupported = i18n.Errorf("wails.window.inputUnsupported", nil)

func nativeWindowTitle(unsafe.Pointer) (string, error) { return "", ErrTitleUnsupported }
func contentSize(unsafe.Pointer) (float64, float64, error) {
	return 0, 0, ErrContentSizeUnsupported
}
func webviewFrame(unsafe.Pointer) (float64, float64, float64, float64, error) {
	return 0, 0, 0, 0, ErrWebviewFrameUnsupported
}
func windowPresence(unsafe.Pointer) WindowPresence { return WindowPresence{} }
func windowInputState(unsafe.Pointer) (WindowInputState, error) {
	return WindowInputState{}, ErrWindowInputUnsupported
}
func setWindowMarkedText(unsafe.Pointer, string) (WindowInputState, error) {
	return WindowInputState{}, ErrWindowInputUnsupported
}
func installWindowInputMonitor(*windowInputMonitor) {}
func removeWindowInputMonitor(*windowInputMonitor)  {}
