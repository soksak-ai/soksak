package wails

import (
	"bytes"
	"image/png"
	"testing"
)

func TestNativeFrameProducesExactCroppedPNG(t *testing.T) {
	frame := nativeFrame{
		Width: 3, Height: 2, Stride: 16,
		BGRA: []byte{
			0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 9, 9, 9, 9,
			255, 255, 255, 0, 0, 0, 0, 0, 0, 255, 255, 0, 9, 9, 9, 9,
		},
	}
	encoded, err := encodeNativeFrame(frame, 2, Rect{X: 0.5, Y: 0, Width: 1, Height: 1})
	if err != nil {
		t.Fatal(err)
	}
	image, err := png.Decode(bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	if image.Bounds().Dx() != 2 || image.Bounds().Dy() != 2 {
		t.Fatalf("bounds = %v", image.Bounds())
	}
	want := [][4]uint32{{0, 0xffff, 0, 0xffff}, {0, 0, 0xffff, 0xffff}, {0, 0, 0, 0xffff}, {0xffff, 0xffff, 0, 0xffff}}
	for index, point := range [][2]int{{0, 0}, {1, 0}, {0, 1}, {1, 1}} {
		r, g, b, a := image.At(point[0], point[1]).RGBA()
		if [4]uint32{r, g, b, a} != want[index] {
			t.Errorf("pixel %v = %04x %04x %04x %04x", point, r, g, b, a)
		}
	}
}

func TestNativeFrameRejectsInvalidInput(t *testing.T) {
	cases := []nativeFrame{
		{},
		{Width: 2, Height: 1, Stride: 7, BGRA: make([]byte, 8)},
		{Width: 2, Height: 2, Stride: 8, BGRA: make([]byte, 8)},
	}
	for _, frame := range cases {
		if _, err := encodeNativeFrame(frame, 1, Whole); err == nil {
			t.Errorf("accepted %+v", frame)
		}
	}
	valid := nativeFrame{Width: 2, Height: 2, Stride: 8, BGRA: make([]byte, 16)}
	if _, err := encodeNativeFrame(valid, 1, Rect{X: 3, Y: 0, Width: 1, Height: 1}); err == nil {
		t.Fatal("empty crop was accepted")
	}
}

func TestCaptureCropClampsDPIAdjustedCoordinates(t *testing.T) {
	crop, err := captureCrop(200, 100, 2, Rect{X: 25, Y: 10, Width: 100, Height: 50})
	if err != nil {
		t.Fatal(err)
	}
	if crop != (pixelRect{X: 50, Y: 20, Width: 150, Height: 80}) {
		t.Fatalf("crop = %+v", crop)
	}
	whole, err := captureCrop(200, 100, 1.5, Whole)
	if err != nil || whole != (pixelRect{Width: 200, Height: 100}) {
		t.Fatalf("whole=%+v err=%v", whole, err)
	}
}
