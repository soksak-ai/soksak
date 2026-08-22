package wails

import (
	"unsafe"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

type capturedFrame interface {
	Frame() nativeFrame
	Release()
}

type nativeFrameCapture func(unsafe.Pointer) (capturedFrame, float64, error)

func captureNativeFrame(window unsafe.Pointer, rect Rect, capture nativeFrameCapture) ([]byte, error) {
	if window == nil {
		return nil, i18n.Errorf("wails.capture.nilWindow", nil)
	}
	frame, scale, err := capture(window)
	if frame != nil {
		defer frame.Release()
	}
	if err != nil {
		return nil, err
	}
	if frame == nil {
		return nil, i18n.Errorf("wails.capture.noFrame", nil)
	}
	return encodeNativeFrame(frame.Frame(), scale, rect)
}
