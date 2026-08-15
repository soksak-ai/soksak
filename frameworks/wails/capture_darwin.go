//go:build darwin

package wails

/*
#cgo CFLAGS: -x objective-c -Wno-deprecated-declarations
#cgo LDFLAGS: -framework AppKit -framework CoreGraphics -framework ScreenCaptureKit
#include <stdlib.h>
#include "capture_darwin.h"
*/
import "C"

import (
	"errors"
	"unsafe"

	"github.com/soksak/soksak-core/core/i18n"
)

// CaptureWindow returns PNG bytes of the window, cropped to rect.
//
// The capture never focuses the window and never fails because something covers
// it: ScreenCaptureKit reads this process's own shareable content, so no
// screen-recording grant is needed.
//
// What comes back is this process's own layers. A native child draws in another
// process and is not in this image — measured 2026-08-16, a browser pane came
// back flat while the surface itself reported title "Example Domain" and
// progress 1. CompositeSurfaces finishes the image by asking each surface for
// its own pixels; this function is the window layer alone.
func CaptureWindow(window unsafe.Pointer, rect Rect) ([]byte, error) {
	if window == nil {
		return nil, i18n.Errorf("wails.capture.nilWindow", nil)
	}

	result := C.soksakCaptureWindow(
		window,
		C.double(rect.X), C.double(rect.Y),
		C.double(rect.Width), C.double(rect.Height),
		C.int(captureTimeoutMillis),
	)
	defer C.soksakCaptureFree(result)

	if result.error != nil {
		return nil, errors.New(C.GoString(result.error))
	}
	if result.png == nil || result.png_len == 0 {
		// An empty answer is a failure with a missing message, never a
		// successful empty image.
		return nil, i18n.Errorf("wails.capture.noImage", nil)
	}
	return C.GoBytes(unsafe.Pointer(result.png), C.int(result.png_len)), nil
}
