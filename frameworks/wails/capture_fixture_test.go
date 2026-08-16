package wails

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"testing"
)

// PNG fixtures for the capture tests.
//
// A recording is a sequence of encoded images, and a byte budget is a rule
// about their size — both are judged on real PNG bytes rather than on a
// placeholder, because an encoder's output length is the number the budget is
// spent against.
var background = color.RGBA{20, 20, 20, 255}

// solidPNG is an image of one colour, standing for a frame.
func solidPNG(t *testing.T, w, h int, fill color.RGBA) []byte {
	t.Helper()
	canvas := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			canvas.Set(x, y, fill)
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, canvas); err != nil {
		t.Fatalf("encoding the fixture: %v", err)
	}
	return buffer.Bytes()
}
