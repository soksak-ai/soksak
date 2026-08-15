package wails

import "github.com/soksak/soksak-core/core/i18n"

// Rect is a window-relative region in CSS points with a top-left origin, the
// same coordinate contract the DOM and the compositor already share. A zero
// rect means the whole window.
type Rect struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// Whole is the rect that captures the entire window.
var Whole = Rect{}

// ErrCaptureUnsupported is returned where no capture backend exists. It names
// the platform rather than returning empty bytes, so "not implemented here" and
// "captured nothing" stay distinct answers.
var ErrCaptureUnsupported = i18n.Errorf("wails.capture.unsupportedPlatform", nil)

const captureTimeoutMillis = 5000
