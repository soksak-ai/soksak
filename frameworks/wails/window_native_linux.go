//go:build linux && cgo

package wails

/*
#cgo pkg-config: gtk4
#include "window_native_linux.h"
*/
import "C"

import (
	"unsafe"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

var ErrRevealWithoutKeyUnsupported = i18n.Errorf("wails.window.revealWithoutKeyUnsupported", nil)

func orderWindowFrontWithoutKey(window unsafe.Pointer) error {
	if window == nil {
		return i18n.Errorf("wails.window.noNativeLifetimeFront", nil)
	}
	C.soksakShowWithoutPresent(window)
	return nil
}

func activateApplication() error { return ErrActivationUnsupported }

var ErrActivationUnsupported = i18n.Errorf("wails.window.activationUnsupported", nil)
var ErrTitleUnsupported = i18n.Errorf("wails.window.titleUnsupported", nil)
var ErrContentSizeUnsupported = i18n.Errorf("wails.window.contentSizeUnsupported", nil)
var ErrWebviewFrameUnsupported = i18n.Errorf("wails.window.webviewFrameUnsupported", nil)
var ErrFitUnsupported = i18n.Errorf("wails.window.fitUnsupported", nil)
var ErrWindowInputUnsupported = i18n.Errorf("wails.window.inputUnsupported", nil)

func nativeWindowTitle(unsafe.Pointer) (string, error) { return "", ErrTitleUnsupported }
func contentSize(window unsafe.Pointer) (float64, float64, error) {
	var width, height C.double
	if C.soksakWindowContentSize(window, &width, &height) == 0 {
		return 0, 0, i18n.Errorf("wails.window.noNativeLifetimeContent", nil)
	}
	return float64(width), float64(height), nil
}
func webviewFrame(unsafe.Pointer) (float64, float64, float64, float64, error) {
	return 0, 0, 0, 0, ErrWebviewFrameUnsupported
}
func fitWebviewToWindow(unsafe.Pointer) error      { return ErrFitUnsupported }
func windowPresence(unsafe.Pointer) WindowPresence { return WindowPresence{} }
func windowInputState(unsafe.Pointer) (WindowInputState, error) {
	return WindowInputState{}, ErrWindowInputUnsupported
}
func setWindowMarkedText(unsafe.Pointer, string) (WindowInputState, error) {
	return WindowInputState{}, ErrWindowInputUnsupported
}
func installWindowInputMonitor(*windowInputMonitor) {}
func removeWindowInputMonitor(*windowInputMonitor)  {}
