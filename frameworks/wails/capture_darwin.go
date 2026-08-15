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
// it: ScreenCaptureKit reads this process's own shareable content, so the
// compositor result arrives whole — main webview and native children in one
// image — without a screen-recording grant.
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
