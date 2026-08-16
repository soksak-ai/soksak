//go:build darwin

package wails

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#include "capture_occlusion_darwin.h"
*/
import "C"

import "unsafe"

// setWindowOcclusionDetection turns detection off or on for every web view in
// one window and answers how many it reached.
func setWindowOcclusionDetection(window unsafe.Pointer, enabled bool) int {
	on := C.int(0)
	if enabled {
		on = 1
	}
	return int(C.soksakSetWindowOcclusionDetection(window, on))
}
