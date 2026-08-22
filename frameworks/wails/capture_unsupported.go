//go:build !windows && !darwin && (!linux || !cgo || gtk3 || android || server)

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

// CaptureDocument fails by name for the same reason.
//
// Where the window capture has no backend the document capture has none either: it exists because
// one platform grants reading the screen per application identity, and a caller that fell through to
// it here would be told a picture was refused twice for one missing backend.
func CaptureDocument(_ unsafe.Pointer, _ Rect) ([]byte, error) {
	return nil, ErrCaptureUnsupported
}
