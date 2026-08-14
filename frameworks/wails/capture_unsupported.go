//go:build !darwin

package wails

import "unsafe"

// CaptureWindow fails by name where no capture backend exists.
//
// Returning empty bytes with a nil error would make "this platform cannot
// capture" and "the window was blank" the same answer, and a caller cannot tell
// those apart after the fact.
func CaptureWindow(_ unsafe.Pointer, _ Rect) ([]byte, error) {
	return nil, ErrCaptureUnsupported
}
