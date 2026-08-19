package wails

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/soksak/soksak-core/core/i18n"
)

// CaptureService exposes window capture to anything driving this application.
//
// A capability with no command cannot be verified from outside, and "there was
// no command for it" is not a reason to leave something unobserved.
type CaptureService struct {
	// name is the window this capture is of, and the handle below is the same
	// window's.
	//
	// The image is that window's own pixels and nothing else. A capture that
	// drew content into the picture from a ledger showed what should have been
	// there rather than what was — measured 2026-08-16, a browser attached to
	// the wrong window appeared in a picture of the right one while the pane a
	// person was looking at was empty.
	name   string
	window func() unsafe.Pointer
	// size answers the window's content size in points. Injected so the rules
	// above it are provable with no window.
	size func(unsafe.Pointer) (float64, float64, error)
	// capture grabs one frame of the window. Injected for the same reason as size: a burst of
	// frames is a loop with a budget and a stopping rule, and none of that needs a display to be
	// judged.
	capture func(unsafe.Pointer, Rect) ([]byte, error)
	// captureDocument is the same picture without the native children, asked of the web view
	// rather than of the compositor. It needs no screen-recording grant, and it is what is left
	// when the window capture is refused for the identity this build runs under.
	captureDocument func(unsafe.Pointer, Rect) ([]byte, error)
	// refused remembers that this identity may not read the screen, so the deadline is paid
	// once rather than per frame. A recording of fourteen frames paid it fourteen times and
	// outlived the command's own deadline — measured 2026-08-17, 20s for a 350ms recording.
	refused atomic.Bool
	// frames announces one recorded frame once its file is complete. Nil sends nothing, which is
	// what a caller that passed no receiver asked for.
	frames func(index int)
	// occlusion turns the window's rendering throttle off or on and answers how many web views it
	// reached. Injected so the hold-and-restore rule is provable with no window.
	occlusion func(window unsafe.Pointer, enabled bool) int
	// prepare tells the document that a capture will read its next rendered frame.
	// Renderers with their own retained surface use this event to redraw after
	// the occlusion throttle has been removed.
	prepare func()
}

func NewCaptureService(name string, window func() unsafe.Pointer) *CaptureService {
	return &CaptureService{
		name:            name,
		window:          window,
		size:            contentSize,
		capture:         CaptureWindow,
		captureDocument: CaptureDocument,
		occlusion:       setWindowOcclusionDetection,
	}
}

// CaptureNote is what a capture contains, beside the image.
//
// The path is answered rather than assumed, so a caller reads where the file
// landed instead of guessing it went where it asked.
type CaptureNote struct {
	Path string `json:"path"`
	// DocumentOnly states that the native children are not in this image: the window capture
	// was refused and the web view was asked for the document instead. A picture that leaves
	// something out and does not say so is read as a window that had nothing there.
	DocumentOnly bool `json:"documentOnly,omitempty"`
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
	defer service.holdRendering(handle)()
	png, documentOnly, err := service.capturing(handle, rect)
	if err != nil {
		return CaptureNote{}, err
	}
	if path == "" {
		return CaptureNote{}, i18n.Errorf("wails.capture.noPath", nil)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return CaptureNote{}, fmt.Errorf("capture could not create %s: %w", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, png, 0o644); err != nil {
		return CaptureNote{}, fmt.Errorf("capture could not write %s: %w", path, err)
	}
	return CaptureNote{Path: path, DocumentOnly: documentOnly}, nil
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
	defer service.holdRendering(handle)()
	png, documentOnly, err := service.capturing(handle, rect)
	if err != nil {
		return CapturePixels{}, err
	}
	note := CaptureNote{DocumentOnly: documentOnly}
	if path != "" {
		if err := writeCapture(path, png); err != nil {
			return CapturePixels{}, err
		}
		note.Path = path
	}
	return CapturePixels{PNG: base64.StdEncoding.EncodeToString(png), Note: note}, nil
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

// occlusionResumeMillis is how long rendering is given to come back after the
// throttle is lifted.
//
// A web view that was covered has not drawn since; captured in the same instant
// the switch is flipped, the image is still the stale frame the throttle left
// there. The value is the contract-conforming implementation's, which is runtime-verified
// on this platform (tauri-plugin-webview-capture, "How occluded capture
// works").
const occlusionResumeMillis = 200

// holdRendering turns the window's throttle off for the length of a capture and
// answers the work to put it back.
//
// Always paired, and the caller defers the release: a capture that failed is
// exactly the case where nobody is watching, and a window left with detection
// off draws forever at a battery cost nobody asked for.
//
// A build that reached no web view waits for nothing. The wait is the price of
// having actually changed something, and paying it where nothing changed makes
// every capture on a platform with no such throttle 200ms slower.
func (service *CaptureService) holdRendering(handle unsafe.Pointer) func() {
	if service.occlusion == nil {
		return func() {}
	}
	if service.occlusion(handle, false) == 0 {
		return func() {}
	}
	if service.prepare != nil {
		service.prepare()
	}
	time.Sleep(occlusionResumeMillis * time.Millisecond)
	return func() { service.occlusion(handle, true) }
}

// capturing takes the window's picture, and the document's when the window's is refused.
//
// Screen recording is granted per application identity on this platform. Measured 2026-08-17: the
// same binary and window captured in 0.3s under the installation's identifier and waited out the
// deadline under any other — which is every gate, since each runs under its own. A run that cannot
// take a picture has no evidence, and evidence that stops at the first refusal is evidence nobody
// has when it matters.
//
// So the document is asked instead, and the answer states that it is the document. The second
// picture is not the first: a page is composited above the document by another process and is not
// in it.
func (service *CaptureService) capturing(handle unsafe.Pointer, rect Rect) ([]byte, bool, error) {
	if service.refused.Load() && service.captureDocument != nil {
		document, documentErr := service.captureDocument(handle, rect)
		if documentErr == nil {
			return document, true, nil
		}
	}
	png, err := service.capture(handle, rect)
	if err == nil {
		return png, false, nil
	}
	// Only for the one refusal the document can answer. Every other failure — no window, a
	// nil handle, a rect that clamps to nothing — is answered as itself, because a fallback
	// that runs on all of them turns a caller's mistake into a picture of something else.
	if service.captureDocument == nil || !strings.Contains(err.Error(), captureNotPermitted) {
		return nil, false, err
	}
	service.refused.Store(true)
	document, documentErr := service.captureDocument(handle, rect)
	if documentErr != nil {
		// the screen. Matched rather than typed, because the sentence is the backend's and this is the one
		return nil, false, fmt.Errorf("%w (the document alone was refused too: %v)", err, documentErr)
	}
	return document, true, nil
}

// captureNotPermitted is the words the window capture answers with when this identity may not read
// the screen. Matched rather than typed, because the sentence is the backend's and this is the one
// refusal the document capture can answer.
const captureNotPermitted = "screen recording is not permitted"
