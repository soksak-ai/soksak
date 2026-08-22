package wails

import (
	"bytes"
	"fmt"
	"image"
	"image/png"
	"math"
)

type nativeFrame struct {
	Width  int
	Height int
	Stride int
	BGRA   []byte
}

type pixelRect struct{ X, Y, Width, Height int }

func encodeNativeFrame(frame nativeFrame, scale float64, rect Rect) ([]byte, error) {
	if frame.Width < 1 || frame.Height < 1 || frame.Stride < frame.Width*4 || len(frame.BGRA) < frame.Stride*frame.Height {
		return nil, fmt.Errorf("invalid native capture frame: %dx%d stride=%d bytes=%d", frame.Width, frame.Height, frame.Stride, len(frame.BGRA))
	}
	crop, err := captureCrop(frame.Width, frame.Height, scale, rect)
	if err != nil {
		return nil, err
	}
	pixels := image.NewNRGBA(image.Rect(0, 0, crop.Width, crop.Height))
	for y := 0; y < crop.Height; y++ {
		sourceRow := (crop.Y+y)*frame.Stride + crop.X*4
		targetRow := y * pixels.Stride
		for x := 0; x < crop.Width; x++ {
			source := sourceRow + x*4
			target := targetRow + x*4
			pixels.Pix[target+0] = frame.BGRA[source+2]
			pixels.Pix[target+1] = frame.BGRA[source+1]
			pixels.Pix[target+2] = frame.BGRA[source+0]
			pixels.Pix[target+3] = 0xff
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, pixels); err != nil {
		return nil, err
	}
	if encoded.Len() == 0 {
		return nil, fmt.Errorf("native capture encoded no PNG bytes")
	}
	return encoded.Bytes(), nil
}

func captureCrop(width, height int, scale float64, rect Rect) (pixelRect, error) {
	if width < 1 || height < 1 || scale <= 0 || math.IsNaN(scale) || math.IsInf(scale, 0) {
		return pixelRect{}, fmt.Errorf("invalid capture extent or scale")
	}
	if rect == Whole {
		return pixelRect{Width: width, Height: height}, nil
	}
	if rect.Width <= 0 || rect.Height <= 0 {
		return pixelRect{}, fmt.Errorf("capture region must have positive width and height")
	}
	x0 := max(0, int(math.Floor(rect.X*scale)))
	y0 := max(0, int(math.Floor(rect.Y*scale)))
	x1 := min(width, int(math.Ceil((rect.X+rect.Width)*scale)))
	y1 := min(height, int(math.Ceil((rect.Y+rect.Height)*scale)))
	if x1 <= x0 || y1 <= y0 {
		return pixelRect{}, fmt.Errorf("capture region is empty after clamping")
	}
	return pixelRect{X: x0, Y: y0, Width: x1 - x0, Height: y1 - y0}, nil
}
