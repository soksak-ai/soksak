package wails

import (
	"encoding/json"
	"strings"
	"testing"
	"unsafe"
)

// A capture states what it did not draw.
//
// The image is the answer a person and an agent both read, and an empty pane in
// it has two causes that look identical: the window declared no surface, or it
// declared one and nothing was painted. Measured 2026-08-16, a capture answered
// `surfaces: 0` for both, so a browser that was never on screen and a pane with
// no browser in it were one reading.
//
// Every surface the window holds is counted, every one not painted is named
// with the reason, and a capture that composited nothing at all states which of
// the two it was.

// stubSurfaces is an inventory that was measured somewhere else, so the note
// can be judged with no compositor, no window and no native layer.
type stubSurfaces struct {
	placed []SurfacePixels
	png    map[string][]byte
}

func (surfaces stubSurfaces) Placed(string) []SurfacePixels { return surfaces.placed }

func (surfaces stubSurfaces) Image(id string) ([]byte, error) {
	if png, held := surfaces.png[id]; held {
		return png, nil
	}
	return nil, errNoPixels
}

// captureOf is a service with the window read faked, so finish is exercised
// with no window at all.
func captureOf(t *testing.T, surfaces SurfaceImages, width, height float64) *CaptureService {
	t.Helper()
	service := NewCaptureService("win-a", func() unsafe.Pointer { return nil }).withSurfaces(surfaces)
	service.size = func(unsafe.Pointer) (float64, float64, error) { return width, height, nil }
	return service
}

func TestASurfacePuttingNoLightOnTheScreenIsNamedRatherThanDropped(t *testing.T) {
	window := solidPNG(t, 200, 200, background)
	surfaces := stubSurfaces{placed: []SurfacePixels{
		{ID: "brw-hidden", Frame: SurfaceFrame{X: 0, Y: 0, W: 50, H: 50}, Dark: "the native layer hid it"},
		{ID: "brw-lit", Frame: SurfaceFrame{X: 100, Y: 100, W: 50, H: 50}},
	}, png: map[string][]byte{"brw-lit": solidPNG(t, 50, 50, pageInk)}}

	_, note := captureOf(t, surfaces, 200, 200).finish(unsafe.Pointer(&window), window, Whole)

	if note.Surfaces != 2 {
		t.Errorf("the window holds 2 surfaces and the note counts %d; a surface that was not drawn is still one the window holds", note.Surfaces)
	}
	if note.Drawn != 1 {
		t.Errorf("one surface had pixels and %d were drawn", note.Drawn)
	}
	if len(note.Skipped) != 1 || !strings.Contains(note.Skipped[0], "brw-hidden") {
		t.Fatalf("the surface that put no light on the screen must be named: %v", note.Skipped)
	}
	if !strings.Contains(note.Skipped[0], "hid it") {
		t.Errorf("the reason must travel with the name: %q", note.Skipped[0])
	}
}

func TestACaptureThatCompositedNothingSaysWhich(t *testing.T) {
	window := solidPNG(t, 100, 100, background)

	for _, probe := range []struct {
		what     string
		service  *CaptureService
		rect     Rect
		mustSay  string
		surfaces int
	}{
		{
			what:    "a region holding no surface",
			service: captureOf(t, stubSurfaces{placed: []SurfacePixels{{ID: "brw-1", Frame: SurfaceFrame{X: 500, Y: 500, W: 10, H: 10}}}}, 100, 100),
			rect:    Rect{X: 0, Y: 0, Width: 10, Height: 10},
			mustSay: "outside the captured region",
		},
		{
			what:    "a build with no surface source",
			service: NewCaptureService("win-a", func() unsafe.Pointer { return nil }),
			rect:    Whole,
			mustSay: "no native surfaces",
		},
	} {
		_, note := probe.service.finish(unsafe.Pointer(&window), window, probe.rect)
		if len(note.Skipped) == 0 {
			t.Errorf("%s composited nothing and the note is silent", probe.what)
			continue
		}
		if !strings.Contains(strings.Join(note.Skipped, " "), probe.mustSay) {
			t.Errorf("%s must say %q: %v", probe.what, probe.mustSay, note.Skipped)
		}
	}
}

// Pixels is the capture an agent looks through, and it threw the note away.
// The one path with no file to inspect afterwards was the one with no statement
// of what it drew.
//
// The payload is the contract: a caller reads these two keys, so both are
// checked as the caller receives them rather than as the Go value.
func TestTheCaptureAnAgentLooksThroughCarriesItsNote(t *testing.T) {
	encoded, err := json.Marshal(CapturePixels{
		PNG:  "iVBORw0KGgo=",
		Note: CaptureNote{Surfaces: 1, Drawn: 0, Skipped: []string{"brw-1: the native layer hid it"}},
	})
	if err != nil {
		t.Fatalf("encoding the answer: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatalf("decoding the answer: %v", err)
	}
	for _, key := range []string{"png", "note"} {
		if _, given := payload[key]; !given {
			t.Errorf("the answer has no %q; the image and what went into it travel together", key)
		}
	}
	note, _ := payload["note"].(map[string]any)
	if note["surfaces"] != float64(1) || note["drawn"] != float64(0) {
		t.Errorf("a capture that drew none of the window's surfaces must say so: %v", note)
	}
}
