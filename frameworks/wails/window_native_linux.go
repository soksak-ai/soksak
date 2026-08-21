//go:build linux && cgo

package wails

/*
#cgo pkg-config: gtk4
#include <gtk/gtk.h>

static void soksakShowWithoutPresent(GtkWindow *window) {
    gtk_widget_set_visible(GTK_WIDGET(window), TRUE);
}
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
	C.soksakShowWithoutPresent((*C.GtkWindow)(window))
	return nil
}

func activateApplication() error { return ErrActivationUnsupported }

var ErrActivationUnsupported = i18n.Errorf("wails.window.activationUnsupported", nil)
var ErrTitleUnsupported = i18n.Errorf("wails.window.titleUnsupported", nil)
var ErrContentSizeUnsupported = i18n.Errorf("wails.window.contentSizeUnsupported", nil)
var ErrWebviewFrameUnsupported = i18n.Errorf("wails.window.webviewFrameUnsupported", nil)
var ErrFitUnsupported = i18n.Errorf("wails.window.fitUnsupported", nil)
var ErrWindowInputUnsupported = i18n.Errorf("wails.window.inputUnsupported", nil)

func nativeWindowTitle(unsafe.Pointer) (string, error)     { return "", ErrTitleUnsupported }
func contentSize(unsafe.Pointer) (float64, float64, error) { return 0, 0, ErrContentSizeUnsupported }
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
