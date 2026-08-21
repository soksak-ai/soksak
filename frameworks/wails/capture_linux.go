//go:build linux && cgo && !gtk3 && !android && !server

package wails

/*
#cgo pkg-config: gtk4
#include "capture_linux.h"
*/
import "C"

import (
	"errors"
	"unsafe"

	"github.com/soksak/soksak-core/core/i18n"
	"github.com/wailsapp/wails/v3/pkg/application"
)

func CaptureWindow(window unsafe.Pointer, rect Rect) ([]byte, error) {
	if window == nil {
		return nil, i18n.Errorf("wails.capture.nilWindow", nil)
	}
	return application.InvokeSyncWithResultAndError(func() ([]byte, error) {
		result := C.soksakCaptureLinuxWindow(
			window, C.double(rect.X), C.double(rect.Y),
			C.double(rect.Width), C.double(rect.Height),
		)
		defer C.soksakCaptureLinuxFree(result)
		if result.error != nil {
			return nil, errors.New(C.GoString(result.error))
		}
		if result.png == nil || result.png_len == 0 {
			return nil, i18n.Errorf("wails.capture.noImage", nil)
		}
		return C.GoBytes(unsafe.Pointer(result.png), C.int(result.png_len)), nil
	})
}

func CaptureDocument(window unsafe.Pointer, rect Rect) ([]byte, error) {
	return CaptureWindow(window, rect)
}
