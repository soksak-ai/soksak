package wails

import "errors"

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
var ErrCaptureUnsupported = errors.New("window capture is not implemented on this platform")

const captureTimeoutMillis = 5000
