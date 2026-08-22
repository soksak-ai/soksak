package wails

import (
	"errors"
	"testing"
	"unsafe"
)

type fakeCaptureHandle struct{ released int }

func (handle *fakeCaptureHandle) Frame() nativeFrame {
	return nativeFrame{Width: 1, Height: 1, Stride: 4, BGRA: []byte{3, 2, 1, 0}}
}
func (handle *fakeCaptureHandle) Release() { handle.released++ }

func TestNativeCaptureAlwaysReleasesItsFrame(t *testing.T) {
	handle := &fakeCaptureHandle{}
	png, err := captureNativeFrame(unsafe.Pointer(handle), Whole, func(unsafe.Pointer) (capturedFrame, float64, error) {
		return handle, 1, nil
	})
	if err != nil || len(png) == 0 {
		t.Fatalf("png=%d err=%v", len(png), err)
	}
	if handle.released != 1 {
		t.Fatalf("release count = %d", handle.released)
	}

	failed := &fakeCaptureHandle{}
	_, err = captureNativeFrame(unsafe.Pointer(failed), Whole, func(unsafe.Pointer) (capturedFrame, float64, error) {
		return failed, 0, errors.New("capture failed")
	})
	if err == nil || failed.released != 1 {
		t.Fatalf("failure=%v releases=%d", err, failed.released)
	}
}

func TestNativeCaptureRejectsMissingFrame(t *testing.T) {
	if _, err := captureNativeFrame(unsafe.Pointer(new(byte)), Whole, func(unsafe.Pointer) (capturedFrame, float64, error) {
		return nil, 1, nil
	}); err == nil {
		t.Fatal("nil frame was accepted")
	}
}
