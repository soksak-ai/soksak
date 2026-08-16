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
	return &CaptureService{name: name, window: window, size: contentSize}
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
		return windowPNG, note
	}
	// A cropped capture would need every frame translated into the crop, and the one caller that
	// crops is measuring a region of chrome. Compositing only the whole window keeps the
	// arithmetic in one place.
	if rect != Whole {
		return windowPNG, note
	}
	placed := service.surfaces.Placed(service.name)
	note.Surfaces = len(placed)
	if len(placed) == 0 {
		return windowPNG, note
	}
	width, height, err := service.size(handle)
	if err != nil {
		note.Skipped = append(note.Skipped, "the window size is unreadable: "+err.Error())
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
	png, err := CaptureWindow(handle, rect)
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

// Pixels answers with a base64 PNG instead of touching the disk, for callers
// that only want to look.
func (service *CaptureService) Pixels(rect Rect) (string, error) {
	handle, err := service.target()
	if err != nil {
		return "", err
	}
	png, err := CaptureWindow(handle, rect)
	if err != nil {
		return "", err
	}
	composite, _ := service.finish(handle, png, rect)
	return base64.StdEncoding.EncodeToString(composite), nil
}
