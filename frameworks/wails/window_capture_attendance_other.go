//go:build !darwin

package wails

import "unsafe"

// Non-Darwin presentation remains the native runner's window-lifecycle fact.
// The common host performs no second presentation mutation on those platforms.
func presentCaptureOnlyWindow(unsafe.Pointer) error { return nil }
