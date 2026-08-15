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
	"errors"
	"unsafe"
)

// orderWindowFrontWithoutKey brings a window forward and leaves the keyboard
// where it is. The caller is on the main thread.
func orderWindowFrontWithoutKey(window unsafe.Pointer) error {
	if window == nil {
		// A nil window here is a window with no native lifetime, and ordering
		// nothing forward would report a reveal that never happened.
		return errors.New("a window with no native lifetime cannot be ordered to the front")
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
		return errors.New("this macOS has no supported application activation request")
	}
	return nil
}

// nativeWindowTitle copies a window's title. The caller is on the main thread.
//
// The frontend writes its boot progress here, and that channel survives a dead
// binding path — so a window that answers nothing else still says how far it
// got. The framework only sets titles, so this is the read half.
func nativeWindowTitle(window unsafe.Pointer) (string, error) {
	if window == nil {
		return "", errors.New("a window with no native lifetime has no title")
	}
	copied := C.soksakCopyWindowTitle(window)
	if copied == nil {
		// Distinct from an empty title: one window has never been given a name
		// and the other was given "".
		return "", errors.New("the window has no title")
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
		return 0, 0, errors.New("a window with no native lifetime has no content area")
	}
	var width, height C.double
	C.soksakWindowContentSize(window, &width, &height)
	return float64(width), float64(height), nil
}

// webviewFrame answers where the document's view sits inside the window, in
// device-independent points. The caller is on the main thread.
//
// A negative size means no such view was found, which is a different answer
// from a view of no size.
func webviewFrame(window unsafe.Pointer) (x, y, width, height float64, err error) {
	if window == nil {
		return 0, 0, 0, 0, errors.New("a window with no native lifetime holds no view")
	}
	var cx, cy, cw, ch C.double
	C.soksakWebviewFrame(window, &cx, &cy, &cw, &ch)
	if float64(cw) < 0 {
		return 0, 0, 0, 0, errors.New("this window holds no web view")
	}
	return float64(cx), float64(cy), float64(cw), float64(ch), nil
}

// fitWebviewToWindow makes the document's view exactly as large as the area it
// can be seen in. The caller is on the main thread.
func fitWebviewToWindow(window unsafe.Pointer) error {
	if window == nil {
		return errors.New("a window with no native lifetime holds no view to fit")
	}
	C.soksakFitWebviewToWindow(window)
	return nil
}
