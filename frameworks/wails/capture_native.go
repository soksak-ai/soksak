package wails

import (
	"fmt"
	"unsafe"
)

type capturedFrame interface {
	Frame() nativeFrame
	Release()
}

type nativeFrameCapture func(unsafe.Pointer) (capturedFrame, float64, error)

func captureNativeFrame(window unsafe.Pointer, rect Rect, capture nativeFrameCapture) ([]byte, error) {
	if window == nil {
		return nil, fmt.Errorf("native capture received a nil window")
	}
	frame, scale, err := capture(window)
	if frame != nil {
		defer frame.Release()
	}
	if err != nil {
		return nil, err
	}
	if frame == nil {
		return nil, fmt.Errorf("native capture returned no frame")
	}
	return encodeNativeFrame(frame.Frame(), scale, rect)
}
