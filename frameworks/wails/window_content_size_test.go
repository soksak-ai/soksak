package wails

import "testing"

func TestContentSizeConvertsClientPixelsToDIPs(t *testing.T) {
	for _, test := range []struct {
		name string
		right, bottom int32
		dpi uint32
		wantW, wantH float64
	}{
		{"96 DPI", 1200, 800, 96, 1200, 800},
		{"144 DPI", 1200, 900, 144, 800, 600},
	} {
		t.Run(test.name, func(t *testing.T) {
			width, height, err := contentSizeFromClientRect(0, 0, test.right, test.bottom, test.dpi)
			if err != nil || width != test.wantW || height != test.wantH {
				t.Fatalf("size=%gx%g err=%v", width, height, err)
			}
		})
	}
}

func TestContentSizeRejectsInvalidNativeReadings(t *testing.T) {
	for _, test := range []struct { right, bottom int32; dpi uint32 }{
		{0, 800, 96}, {1200, 0, 96}, {1200, 800, 0},
	} {
		if _, _, err := contentSizeFromClientRect(0, 0, test.right, test.bottom, test.dpi); err == nil {
			t.Fatalf("accepted rect=%dx%d dpi=%d", test.right, test.bottom, test.dpi)
		}
	}
}
