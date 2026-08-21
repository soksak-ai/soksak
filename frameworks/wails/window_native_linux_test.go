//go:build linux && cgo

package wails

import (
	"testing"
	"unsafe"
)

func TestFocusFreeRevealRejectsANilGTKWindow(t *testing.T) {
	err := orderWindowFrontWithoutKey(unsafe.Pointer(nil))
	if err == nil {
		t.Fatal("nil GTK window was reported visible")
	}
	if err == ErrRevealWithoutKeyUnsupported {
		t.Fatal("Linux focus-free reveal is not implemented")
	}
}

func TestContentSizeRejectsANilGTKWindow(t *testing.T) {
	if _, _, err := contentSize(unsafe.Pointer(nil)); err == nil {
		t.Fatal("nil GTK window reported a content size")
	}
}
