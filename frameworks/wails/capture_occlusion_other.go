//go:build !darwin

package wails

import "unsafe"

// setWindowOcclusionDetection is a no-op where the platform has no such
// throttle.
//
// Zero rather than a refusal: Windows and Linux pause a web view only when it
// is minimised or hidden and keep drawing while it is covered, so there is
// nothing to turn off and a capture there is already the current frame. A
// refusal would make every capture on those platforms report a failure that
// describes macOS.
func setWindowOcclusionDetection(unsafe.Pointer, bool) int { return 0 }
