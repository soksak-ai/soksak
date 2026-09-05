//go:build darwin

package wails

/*
#cgo CFLAGS: -x objective-c -Wno-deprecated-declarations
#cgo LDFLAGS: -framework AppKit -framework CoreGraphics -framework CoreMedia -framework CoreVideo -framework QuartzCore
#include <stdlib.h>
#include "capture_burst_darwin.h"
*/
import "C"

import (
	"unsafe"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

// BurstWindow streams the window's frames to disk through ScreenCaptureKit.
func BurstWindow(window unsafe.Pointer, request BurstRequest) (BurstReport, error) {
	if window == nil {
		return BurstReport{}, i18n.Errorf("wails.capture.nilWindow", nil)
	}
	dir := C.CString(request.Dir)
	defer C.free(unsafe.Pointer(dir))
	result := C.soksakCaptureBurst(
		window,
		C.double(request.Region.X), C.double(request.Region.Y),
		C.double(request.Region.Width), C.double(request.Region.Height),
		C.int(request.DurationMs), C.int(request.Frames), C.int(request.IntervalMs),
		C.longlong(request.MaxBytes), dir, C.int(captureTimeoutMillis),
	)
	defer C.soksakBurstFree(result)
	if result.error != nil {
		return BurstReport{}, capturedRefusal(C.GoString(result.error))
	}
	report := BurstReport{Frames: int(result.frames), Width: int(result.width), Height: int(result.height)}
	if result.frames > 0 && result.times_ms != nil {
		times := unsafe.Slice((*C.double)(result.times_ms), int(result.frames))
		report.TimesMs = make([]float64, len(times))
		for i, t := range times {
			report.TimesMs[i] = float64(t)
		}
	}
	if result.stopped != nil {
		report.Stopped = C.GoString(result.stopped)
	}
	return report, nil
}

func platformBurst() burstSource { return BurstWindow }
