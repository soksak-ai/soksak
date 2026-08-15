package wails

import (
	"bytes"
	"image"
	"image/draw"
	"image/png"
)

// SurfacePixels names one surface and its rectangle, in the same CSS points the declaration used.
type SurfacePixels struct {
	ID    string
	Frame SurfaceFrame
}

// SurfacePixelSource answers with a surface's own PNG. An error leaves that surface's rectangle as
// the window layer had it.
type SurfacePixelSource func(id string) ([]byte, error)

// CompositeSurfaces finishes a window capture by drawing each native surface into it.
//
// The window image holds this process's own layers. A native surface draws in another process, so
// its rectangle arrives flat — measured 2026-08-16, a browser pane was a solid block while the
// surface itself reported title "Example Domain" and progress 1, and a terminal in the same pane,
// drawn in the document, came through with its glyphs. The page was loading correctly the whole
// time and the image did not have it.
//
// windowWidth and windowHeight are the window's content size in points. The image is in device
// pixels, so their ratio is the scale a surface frame is drawn at; using 1 puts every pane in the
// wrong quarter of the window on a retina display.
//
// A surface that cannot be asked leaves its rectangle alone. One wedged web process must not cost
// the whole capture, and what stays there is what the image showed before this existed.
func CompositeSurfaces(
	windowPNG []byte,
	windowWidth float64,
	windowHeight float64,
	surfaces []SurfacePixels,
	pixels SurfacePixelSource,
) ([]byte, error) {
	// Re-encoding an image nobody drew on changes its bytes for no reason, and a caller comparing
	// two captures then reads a difference that is not on screen.
	if len(surfaces) == 0 || pixels == nil {
		return windowPNG, nil
	}
	if windowWidth <= 0 || windowHeight <= 0 {
		return windowPNG, nil
	}

	decoded, err := png.Decode(bytes.NewReader(windowPNG))
	if err != nil {
		return nil, err
	}
	bounds := decoded.Bounds()
	canvas := image.NewRGBA(bounds)
	draw.Draw(canvas, bounds, decoded, bounds.Min, draw.Src)

	scaleX := float64(bounds.Dx()) / windowWidth
	scaleY := float64(bounds.Dy()) / windowHeight
	drew := false

	for _, surface := range surfaces {
		data, askErr := pixels(surface.ID)
		if askErr != nil || len(data) == 0 {
			continue
		}
		page, decodeErr := png.Decode(bytes.NewReader(data))
		if decodeErr != nil {
			continue
		}
		target := image.Rect(
			bounds.Min.X+int(surface.Frame.X*scaleX+0.5),
			bounds.Min.Y+int(surface.Frame.Y*scaleY+0.5),
			bounds.Min.X+int((surface.Frame.X+surface.Frame.W)*scaleX+0.5),
			bounds.Min.Y+int((surface.Frame.Y+surface.Frame.H)*scaleY+0.5),
		)
		// A surface can be declared past the edge during a resize. Unclipped, the draw either
		// panics or wraps, and both are worse than the pane being cut off.
		clipped := target.Intersect(bounds)
		if clipped.Empty() {
			continue
		}
		drawSurface(canvas, clipped, target, page)
		drew = true
	}

	if !drew {
		return windowPNG, nil
	}
	var out bytes.Buffer
	if err := png.Encode(&out, canvas); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// drawSurface copies a surface's image into its rectangle, scaling if the two disagree.
//
// A snapshot taken at the display's backing scale already matches the target and the copy is 1:1.
// One taken in points does not, and copying it straight would put a half-size page in the corner
// of the pane — which reads as a rendering bug rather than as two scales meeting. Nearest
// neighbour, because the only ratios that occur are whole display scales and this is evidence
// rather than a picture to look at closely.
func drawSurface(canvas *image.RGBA, clipped, target image.Rectangle, page image.Image) {
	source := page.Bounds()
	if source.Dx() == target.Dx() && source.Dy() == target.Dy() {
		draw.Draw(canvas, clipped, page, source.Min.Add(clipped.Min.Sub(target.Min)), draw.Src)
		return
	}
	for y := clipped.Min.Y; y < clipped.Max.Y; y++ {
		for x := clipped.Min.X; x < clipped.Max.X; x++ {
			sx := source.Min.X + (x-target.Min.X)*source.Dx()/target.Dx()
			sy := source.Min.Y + (y-target.Min.Y)*source.Dy()/target.Dy()
			canvas.Set(x, y, page.At(sx, sy))
		}
	}
}
