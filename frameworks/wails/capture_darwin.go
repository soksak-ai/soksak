//go:build darwin

package wails

/*
#cgo CFLAGS: -x objective-c -Wno-deprecated-declarations
#cgo LDFLAGS: -framework AppKit -framework CoreGraphics -framework ScreenCaptureKit -framework WebKit
#include <stdlib.h>
#include "capture_darwin.h"
*/
import "C"

import (
	"errors"
	"strings"
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
// capturedRefusal is the native layer's refusal, and a refusal that arrived without words is named
// as that rather than passed on empty.
//
// Measured 2026-08-18: a recording answered `frame 0 could not be captured: ` and the colon was the
// whole reason. A caller cannot act on that and cannot report it either — an empty message is
// indistinguishable from a message nobody read.
func capturedRefusal(words string) error {
	if strings.TrimSpace(words) == "" {
		return i18n.Errorf("wails.capture.wordlessRefusal", nil)
	}
	return errors.New(words)
}

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
		return nil, capturedRefusal(C.GoString(result.error))
	}
	if result.png == nil || result.png_len == 0 {
		// An empty answer is a failure with a missing message, never a
		// successful empty image.
		return nil, i18n.Errorf("wails.capture.noImage", nil)
	}
	return C.GoBytes(unsafe.Pointer(result.png), C.int(result.png_len)), nil
}

// CaptureDocument returns PNG bytes of the document alone, asked of the web view that draws it.
//
// The window capture reads this process's shareable content, and on this platform that is granted
// per application identity: measured 2026-08-17, the same binary and window captured in 0.3s under
// the installation's identifier and waited out the deadline under any other, which is every gate.
// This path takes the web view's own pixels and needs no grant.
//
// What it cannot show is a native child. A page is composited above this document by another
// process and is not in this image, so a caller that falls back to it has a picture of the document
// and must state that it is one.
func CaptureDocument(window unsafe.Pointer, rect Rect) ([]byte, error) {
	if window == nil {
		return nil, i18n.Errorf("wails.capture.nilWindow", nil)
	}
	result := C.soksakCaptureDocument(
		window,
		C.double(rect.X), C.double(rect.Y),
		C.double(rect.Width), C.double(rect.Height),
		C.int(captureTimeoutMillis),
	)
	defer C.soksakCaptureFree(result)

	if result.error != nil {
		return nil, capturedRefusal(C.GoString(result.error))
	}
	if result.png == nil || result.png_len == 0 {
		return nil, i18n.Errorf("wails.capture.noImage", nil)
	}
	return C.GoBytes(unsafe.Pointer(result.png), C.int(result.png_len)), nil
}
