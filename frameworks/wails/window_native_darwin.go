//go:build darwin

package wails

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework AppKit
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
