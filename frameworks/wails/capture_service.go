package wails

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"unsafe"

	"github.com/soksak/soksak-core/core/i18n"
)

// CaptureService exposes window capture to anything driving this application.
//
// A capability with no command cannot be verified from outside, and "there was
// no command for it" is not a reason to leave something unobserved.
type CaptureService struct {
	// name is the window this capture is of. The handle below is the same
	// window's, and the surfaces drawn into the image are the ones that window
	// declared — measured 2026-08-16, a capture that asked for every window's
	// surfaces drew a workspace window's browser into a picture of the
	// orchestrator, and into a picture of the workspace window whose pane was
	// in fact empty.
	name   string
	window func() unsafe.Pointer
	// surfaces finishes the image with content that draws outside this process. Absent, the
	// capture is the window layer alone, which is what it was before native surfaces existed.
	surfaces SurfaceImages
	// size answers the window's content size in points, which is the scale the surface frames are
	// drawn at. Injected so the composite is testable with no window.
	size func(unsafe.Pointer) (float64, float64, error)
	// capture grabs one frame of the window. Injected for the same reason as size: a burst of
	// frames is a loop with a budget and a stopping rule, and none of that needs a display to be
	// judged.
	capture func(unsafe.Pointer, Rect) ([]byte, error)
	// frames announces one recorded frame once its file is complete. Nil sends nothing, which is
	// what a caller that passed no receiver asked for.
	frames func(index int)
}

// SurfaceImages is where a capture gets the pixels of content that is not in the document.
type SurfaceImages interface {
	// Placed names every surface the native layer holds for one window and where it is, in CSS
	// points. Per window, because a capture is of one window: reading every window's surfaces drew
	// the workspace browser into a picture of the orchestrator and into a picture of the workspace
	// window alike, and the second of those is a screenshot of an empty pane with a browser in it.
	Placed(window string) []SurfacePixels
	// Image answers one surface's own PNG.
	Image(id string) ([]byte, error)
}

func NewCaptureService(name string, window func() unsafe.Pointer) *CaptureService {
	return &CaptureService{name: name, window: window, size: contentSize, capture: CaptureWindow}
}

// withSurfaces names where the capture gets content that draws outside this process.
//
// Separate from the constructor because the compositor is built after the capture service in the
// host, and because a build with no native surfaces should not have to pass a nil.
//
// Unexported: this is composition, not a method a page calls. Exported, the generator would bind
// it and the page could hand the capture a different source of pixels.
func (service *CaptureService) withSurfaces(surfaces SurfaceImages) *CaptureService {
	service.surfaces = surfaces
	return service
}

// CaptureNote is what a capture contains, beside the file.
//
// A capture that quietly left a pane empty is the defect this whole path exists to remove, so the
// answer states how many surfaces it drew and why any were left out. Without it a caller looking
// at a flat rectangle cannot tell a page that failed to load from a composite that never ran.
type CaptureNote struct {
	Path string `json:"path"`
	// Surfaces is how many native surfaces the inventory held at capture time.
	Surfaces int `json:"surfaces"`
	// Drawn is how many of them were drawn into the image.
	Drawn int `json:"drawn"`
	// Skipped names each one that was not, with the reason.
	Skipped []string `json:"skipped,omitempty"`
}

// finish draws the native surfaces into a window image.
//
// One surface that will not answer leaves its rectangle as the window layer had it. Losing the
// whole capture because one web process is wedged costs more than the hole does — but the hole is
// named in the answer rather than left to be discovered by looking.
func (service *CaptureService) finish(handle unsafe.Pointer, windowPNG []byte, rect Rect) ([]byte, CaptureNote) {
	note := CaptureNote{}
	if service.surfaces == nil || service.size == nil {
		// Said rather than left blank. This build composites no native surfaces, and a caller
		// looking at a flat pane would otherwise read the same empty note as a build that
		// composited and found none.
		note.Skipped = append(note.Skipped, "this build draws no native surfaces into a capture")
		return windowPNG, note
	}
	placed := service.surfaces.Placed(service.name)
	// Every surface this window holds, drawn or not. A count of the drawable ones alone answers
	// zero for a window whose only pane is hidden, which is the same answer as a window with no
	// pane — one of those is an empty rectangle a person is looking at.
	note.Surfaces = len(placed)

	// The image covers the region, and a surface frame is in window points, so each one is
	// translated into the crop. A region was captured from the window layer alone before this,
	// which made a browser pane cropped to its own rectangle come back flat — the one capture a
	// person wants when the question is what that page shows.
	width, height := rect.Width, rect.Height
	if rect == Whole {
		var err error
		if width, height, err = service.size(handle); err != nil {
			note.Skipped = append(note.Skipped, "the window size is unreadable: "+err.Error())
			return windowPNG, note
		}
	}

	lit := make([]SurfacePixels, 0, len(placed))
	for _, surface := range placed {
		if surface.Dark != "" {
			note.Skipped = append(note.Skipped, surface.ID+": "+surface.Dark)
			continue
		}
		framed := surface
		framed.Frame.X -= rect.X
		framed.Frame.Y -= rect.Y
		if !framed.Frame.Overlaps(SurfaceFrame{W: width, H: height}) {
			note.Skipped = append(note.Skipped, surface.ID+": it is outside the captured region")
			continue
		}
		lit = append(lit, framed)
	}
	placed = lit
	if len(placed) == 0 {
		return windowPNG, note
	}
	composite, err := CompositeSurfaces(windowPNG, width, height, placed, func(id string) ([]byte, error) {
		png, askErr := service.surfaces.Image(id)
		if askErr != nil {
			note.Skipped = append(note.Skipped, id+": "+askErr.Error())
			return nil, askErr
		}
		note.Drawn++
		return png, nil
	})
	if err != nil {
		note.Drawn = 0
		note.Skipped = append(note.Skipped, "the composite failed: "+err.Error())
		return windowPNG, note
	}
	return composite, note
}

func (service *CaptureService) ServiceName() string { return "soksak-capture" }

func (service *CaptureService) target() (unsafe.Pointer, error) {
	if service.window == nil {
		return nil, i18n.Errorf("wails.capture.noWindowSource", nil)
	}
	handle := service.window()
	if handle == nil {
		return nil, i18n.Errorf("wails.capture.beforeWindow", nil)
	}
	return handle, nil
}

// Snapshot writes a PNG of the whole window and answers with where it landed.
//
// The path is returned rather than assumed, so a caller verifies from the
// response instead of guessing where the file went.
func (service *CaptureService) Snapshot(path string) (CaptureNote, error) {
	return service.SnapshotRegion(path, Whole)
}

// SnapshotRegion writes a PNG cropped to a window-relative rect in CSS points.
func (service *CaptureService) SnapshotRegion(path string, rect Rect) (CaptureNote, error) {
	handle, err := service.target()
	if err != nil {
		return CaptureNote{}, err
	}
	png, err := service.capture(handle, rect)
	if err != nil {
		return CaptureNote{}, err
	}
	png, note := service.finish(handle, png, rect)
	if path == "" {
		return CaptureNote{}, i18n.Errorf("wails.capture.noPath", nil)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return CaptureNote{}, fmt.Errorf("capture could not create %s: %w", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, png, 0o644); err != nil {
		return CaptureNote{}, fmt.Errorf("capture could not write %s: %w", path, err)
	}
	note.Path = path
	return note, nil
}

// CapturePixels is an image and the statement of what went into it.
//
// The two travel together. This is the capture with no file left behind to
// inspect afterwards, so a caller that receives only the image has no way to
// ask later what was drawn — and it threw the note away entirely, which made
// the one path an agent looks through the one path with no evidence.
type CapturePixels struct {
	PNG  string      `json:"png"`
	Note CaptureNote `json:"note"`
}

// Pixels answers with a base64 PNG instead of touching the disk, for callers
// that only want to look.
func (service *CaptureService) Pixels(rect Rect) (CapturePixels, error) {
	return service.PixelsAt("", rect)
}

// PixelsAt captures a region and, given a path, leaves the file there too.
//
// Cropping and saving are separate axes. A caller that named a path once
// received base64 and no file, and one that wanted only to measure was refused
// for want of a path it had no use for — so both are answered here and neither
// is required.
func (service *CaptureService) PixelsAt(path string, rect Rect) (CapturePixels, error) {
	handle, err := service.target()
	if err != nil {
		return CapturePixels{}, err
	}
	png, err := service.capture(handle, rect)
	if err != nil {
		return CapturePixels{}, err
	}
	composite, note := service.finish(handle, png, rect)
	if path != "" {
		if err := writeCapture(path, composite); err != nil {
			return CapturePixels{}, err
		}
		note.Path = path
	}
	return CapturePixels{PNG: base64.StdEncoding.EncodeToString(composite), Note: note}, nil
}

// writeCapture puts one capture on disk, creating the directory it names.
func writeCapture(path string, png []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("capture could not create %s: %w", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, png, 0o644); err != nil {
		return fmt.Errorf("capture could not write %s: %w", path, err)
	}
	return nil
}
