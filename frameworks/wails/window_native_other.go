//go:build !darwin && !linux && !windows

package wails

import (
	"unsafe"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

// ErrRevealWithoutKeyUnsupported is returned where no focus-free reveal exists.
//
// This framework's only reveal takes the keyboard, and there is no portable way
// to bring a window forward without it. Returning success would make a restored
// window steal the focus from whatever the user is doing and report that it did
// not — so the platform is named instead.
var ErrRevealWithoutKeyUnsupported = i18n.Errorf("wails.window.revealWithoutKeyUnsupported", nil)

// ErrActivationUnsupported is returned where no application activation request
// exists. A window brought forward while the application stays in the
// background receives no keys, and reporting success would leave the caller
// waiting for input that never arrives.
var ErrActivationUnsupported = i18n.Errorf("wails.window.activationUnsupported", nil)

func orderWindowFrontWithoutKey(unsafe.Pointer) error { return ErrRevealWithoutKeyUnsupported }

func activateApplication() error { return ErrActivationUnsupported }

// ErrTitleUnsupported is returned where the title cannot be read back.
//
// The boot stamp the frontend writes there is the observation channel that
// survives a dead binding path, so an empty string would look like a window
// that booted silently rather than one nobody can see into.
var ErrTitleUnsupported = i18n.Errorf("wails.window.titleUnsupported", nil)

func nativeWindowTitle(unsafe.Pointer) (string, error) { return "", ErrTitleUnsupported }

// ErrContentSizeUnsupported is returned where the content rect cannot be read
// back. Answering the frame instead would be a different rectangle wearing this
// one's name.
var ErrContentSizeUnsupported = i18n.Errorf("wails.window.contentSizeUnsupported", nil)

func contentSize(unsafe.Pointer) (float64, float64, error) { return 0, 0, ErrContentSizeUnsupported }

// ErrWebviewFrameUnsupported is returned where the document's view cannot be
// located. Answering the window's own rect would attribute the document's size
// to the window, which is the question this exists to separate.
var ErrWebviewFrameUnsupported = i18n.Errorf("wails.window.webviewFrameUnsupported", nil)

func webviewFrame(unsafe.Pointer) (x, y, width, height float64, err error) {
	return 0, 0, 0, 0, ErrWebviewFrameUnsupported
}

// windowPresence has no portable answer. Known stays false rather than every
// field answering "not visible", which would report every window on this
// platform as hidden.
func windowPresence(unsafe.Pointer) WindowPresence { return WindowPresence{} }

var ErrWindowInputUnsupported = i18n.Errorf("wails.window.inputUnsupported", nil)

func windowInputState(unsafe.Pointer) (WindowInputState, error) {
	return WindowInputState{}, ErrWindowInputUnsupported
}

func setWindowMarkedText(unsafe.Pointer, string) (WindowInputState, error) {
	return WindowInputState{}, ErrWindowInputUnsupported
}

func nativeCloseStatus(unsafe.Pointer) (NativeCloseStatus, error) {
	return NativeCloseStatus{}, ErrWindowInputUnsupported
}

func clickNativeClose(unsafe.Pointer, uint64) (bool, error) {
	return false, ErrWindowInputUnsupported
}
func makeWindowTransparent(unsafe.Pointer) {}

func installWindowInputMonitor(*windowInputMonitor) {}

func removeWindowInputMonitor(*windowInputMonitor) {}
