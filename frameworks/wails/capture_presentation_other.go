//go:build !darwin

package wails

import "unsafe"

func PresentWindowForCapture(unsafe.Pointer) bool { return false }

func RestoreWindowAfterCapture(unsafe.Pointer, bool) {}
