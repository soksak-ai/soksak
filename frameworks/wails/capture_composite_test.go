package wails

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/png"
	"testing"
)

// The window capture composites this process's own layers, and a native surface draws in another
// process. Measured 2026-08-16: a browser pane came back as a flat rectangle while the surface
// itself reported title "Example Domain" and progress 1, and a terminal in the same pane — drawn
// in the document — came through with its glyphs. The page was loading correctly the whole time
// and the image did not have it.
//
// So the image is finished here: each surface is asked for its own pixels and they are drawn where
// the surface is. Without this the one eye this project has is blind to exactly the content G3
// exists to place.

// solidPNG is an image of one colour, standing for a page.
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

func decode(t *testing.T, data []byte) image.Image {
	t.Helper()
	decoded, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("decoding the composite: %v", err)
	}
	return decoded
}

func at(t *testing.T, img image.Image, x, y int) color.RGBA {
	t.Helper()
	r, g, b, a := img.At(x, y).RGBA()
	return color.RGBA{uint8(r >> 8), uint8(g >> 8), uint8(b >> 8), uint8(a >> 8)}
}

var (
	background = color.RGBA{20, 20, 20, 255}
	pageInk    = color.RGBA{200, 40, 40, 255}
)

func TestASurfacesPixelsLandWhereTheSurfaceIs(t *testing.T) {
	// The window image is in device pixels and a surface frame is in CSS points. The scale between
	// them is what places the page, and getting it wrong puts the page in the wrong half of the
	// window on every retina display.
	window := solidPNG(t, 400, 300, background)
	pixels := map[string][]byte{"brw-a": solidPNG(t, 200, 100, pageInk)}
	surfaces := []SurfacePixels{{ID: "brw-a", Frame: SurfaceFrame{X: 50, Y: 25, W: 100, H: 50}}}

	composite, err := CompositeSurfaces(window, 200, 150, surfaces, func(id string) ([]byte, error) {
		return pixels[id], nil
	})
	if err != nil {
		t.Fatalf("compositing: %v", err)
	}

	image := decode(t, composite)
	if got := image.Bounds().Dx(); got != 400 {
		t.Errorf("the composite is %d wide; the window image was 400", got)
	}
	// Scale is 400/200 = 2, so the surface covers device pixels 100..300 across and 50..150 down.
	for _, probe := range []struct {
		x, y int
		want color.RGBA
		what string
	}{
		{101, 51, pageInk, "just inside the top left of the surface"},
		{299, 149, pageInk, "just inside the bottom right"},
		{99, 51, background, "just outside the left edge"},
		{101, 49, background, "just above the top edge"},
		{301, 149, background, "just outside the right edge"},
		{10, 10, background, "far from the surface"},
	} {
		if got := at(t, image, probe.x, probe.y); got != probe.want {
			t.Errorf("%s (%d,%d) is %v, not %v", probe.what, probe.x, probe.y, got, probe.want)
		}
	}
}

func TestASurfaceThatCannotBeAskedLeavesTheRestOfTheImage(t *testing.T) {
	// One web process that will not answer must not cost the whole capture. The hole is what the
	// window layer had there, which is what the image showed before this existed.
	window := solidPNG(t, 200, 200, background)
	surfaces := []SurfacePixels{
		{ID: "brw-broken", Frame: SurfaceFrame{X: 0, Y: 0, W: 50, H: 50}},
		{ID: "brw-ok", Frame: SurfaceFrame{X: 100, Y: 100, W: 50, H: 50}},
	}
	composite, err := CompositeSurfaces(window, 200, 200, surfaces, func(id string) ([]byte, error) {
		if id == "brw-broken" {
			return nil, errNoPixels
		}
		return solidPNG(t, 50, 50, pageInk), nil
	})
	if err != nil {
		t.Fatalf("compositing: %v", err)
	}
	image := decode(t, composite)
	if got := at(t, image, 25, 25); got != background {
		t.Errorf("the surface that refused left %v behind, not the window layer", got)
	}
	if got := at(t, image, 125, 125); got != pageInk {
		t.Errorf("the surface that answered is %v, not its page", got)
	}
}

func TestNoSurfacesLeavesTheWindowImageExactlyAsItWas(t *testing.T) {
	// Re-encoding an image nobody drew on changes its bytes for no reason, and every caller that
	// compares two captures then sees a difference that is not on screen.
	window := solidPNG(t, 100, 100, background)
	composite, err := CompositeSurfaces(window, 100, 100, nil, func(string) ([]byte, error) {
		t.Fatal("a surface was asked for pixels when there were none")
		return nil, nil
	})
	if err != nil {
		t.Fatalf("compositing: %v", err)
	}
	if !bytes.Equal(composite, window) {
		t.Error("the window image was re-encoded with no surface to draw")
	}
}

func TestASnapshotTakenAtAnotherScaleStillFillsTheRectangle(t *testing.T) {
	// A snapshot at the display's backing scale matches the target exactly. One taken in points
	// does not, and copying it straight puts a half-size page in the corner of the pane — which
	// reads as a rendering bug rather than as two scales meeting.
	window := solidPNG(t, 400, 400, background)
	surfaces := []SurfacePixels{{ID: "brw-a", Frame: SurfaceFrame{X: 0, Y: 0, W: 100, H: 100}}}
	// Scale is 2, so the target is 200x200 device pixels while the snapshot is 100x100.
	composite, err := CompositeSurfaces(window, 200, 200, surfaces, func(string) ([]byte, error) {
		return solidPNG(t, 100, 100, pageInk), nil
	})
	if err != nil {
		t.Fatalf("compositing: %v", err)
	}
	image := decode(t, composite)
	for _, probe := range []struct {
		x, y int
		want color.RGBA
		what string
	}{
		{1, 1, pageInk, "the top left of the pane"},
		{198, 198, pageInk, "the bottom right of the pane"},
		{201, 201, background, "just outside the pane"},
	} {
		if got := at(t, image, probe.x, probe.y); got != probe.want {
			t.Errorf("%s (%d,%d) is %v, not %v", probe.what, probe.x, probe.y, got, probe.want)
		}
	}
}

func TestASurfaceOutsideTheWindowIsClipped(t *testing.T) {
	// A surface can be declared past the edge during a resize. Drawing it unclipped either panics
	// or silently wraps, and both are worse than the pane being cut off.
	window := solidPNG(t, 100, 100, background)
	surfaces := []SurfacePixels{{ID: "brw-a", Frame: SurfaceFrame{X: 80, Y: 80, W: 40, H: 40}}}
	composite, err := CompositeSurfaces(window, 100, 100, surfaces, func(string) ([]byte, error) {
		return solidPNG(t, 40, 40, pageInk), nil
	})
	if err != nil {
		t.Fatalf("compositing: %v", err)
	}
	image := decode(t, composite)
	if got := at(t, image, 99, 99); got != pageInk {
		t.Errorf("the visible corner of the surface is %v, not its page", got)
	}
}

// errNoPixels stands for whatever a web process reports when it will not produce a snapshot.
var errNoPixels = errors.New("the web process did not answer")
