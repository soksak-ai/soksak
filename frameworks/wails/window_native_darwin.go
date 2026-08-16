//go:build darwin

package wails

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework AppKit
#include <stdlib.h>
#include "window_native_darwin.h"
*/
import "C"

import (
	"unsafe"

	"github.com/soksak/soksak-core/core/i18n"
)

// orderWindowFrontWithoutKey brings a window forward and leaves the keyboard
// where it is. The caller is on the main thread.
func orderWindowFrontWithoutKey(window unsafe.Pointer) error {
	if window == nil {
		// A nil window here is a window with no native lifetime, and ordering
		// nothing forward would report a reveal that never happened.
		return i18n.Errorf("wails.window.noNativeLifetimeFront", nil)
	}
	C.soksakOrderFrontRegardless(window)
	return nil
}

// activateApplication brings this application forward. The caller is on the
// main thread.
func activateApplication() error {
	if !bool(C.soksakActivateApplication()) {
		// Named rather than silently ignored: the caller asked for the
		// application to come forward, and a quiet success here would be
		// followed by a window that is in front and receives no keys.
		return i18n.Errorf("wails.app.noActivationRequest", nil)
	}
	return nil
}

// nativeWindowTitle copies a window's title. The caller is on the main thread.
//
// The frontend writes its boot progress here, and that channel survives a dead
// binding path — so a window that answers nothing else still reports how far it
// got. The framework only sets titles, so this is the read half.
func nativeWindowTitle(window unsafe.Pointer) (string, error) {
	if window == nil {
		return "", i18n.Errorf("wails.window.noNativeLifetimeTitle", nil)
	}
	copied := C.soksakCopyWindowTitle(window)
	if copied == nil {
		// Distinct from an empty title: one window has never been given a name
		// and the other was given "".
		return "", i18n.Errorf("wails.window.noTitle", nil)
	}
	defer C.free(unsafe.Pointer(copied))
	return C.GoString(copied), nil
}

// contentSize answers the area a document occupies, in device-independent
// points. The caller is on the main thread.
//
// Fractional: a window on a scaled display has a fractional content size, and
// truncating it here would answer a size no document ever had.
func contentSize(window unsafe.Pointer) (float64, float64, error) {
	if window == nil {
		return 0, 0, i18n.Errorf("wails.window.noNativeLifetimeContent", nil)
	}
	var width, height C.double
	C.soksakWindowContentSize(window, &width, &height)
	return float64(width), float64(height), nil
}

// webviewFrame answers where the document's view is inside the window, in
// device-independent points. The caller is on the main thread.
//
// A negative size means no such view was found, which is a different answer
// from a view of no size.
func webviewFrame(window unsafe.Pointer) (x, y, width, height float64, err error) {
	if window == nil {
		return 0, 0, 0, 0, i18n.Errorf("wails.window.noNativeLifetimeView", nil)
	}
	var cx, cy, cw, ch C.double
	C.soksakWebviewFrame(window, &cx, &cy, &cw, &ch)
	if float64(cw) < 0 {
		return 0, 0, 0, 0, i18n.Errorf("wails.window.noWebView", nil)
	}
	return float64(cx), float64(cy), float64(cw), float64(ch), nil
}

// fitWebviewToWindow makes the document's view exactly as large as the area it
// can be seen in. The caller is on the main thread.
func fitWebviewToWindow(window unsafe.Pointer) error {
	if window == nil {
		return i18n.Errorf("wails.window.noNativeLifetimeViewToFit", nil)
	}
	C.soksakFitWebviewToWindow(window)
	return nil
}

// windowPresence reads whether this window is putting light on the screen. The
// caller is on the main thread.
func windowPresence(window unsafe.Pointer) WindowPresence {
	if window == nil {
		return WindowPresence{}
	}
	read := C.soksakWindowPresence(window)
	return WindowPresence{
		Known:        true,
		Visible:      bool(read.visible),
		Key:          bool(read.key),
		Main:         bool(read.principal),
		Miniaturized: bool(read.miniaturized),
		Occluded:     bool(read.occluded),
		Alpha:        float64(read.alpha),
	}
}
