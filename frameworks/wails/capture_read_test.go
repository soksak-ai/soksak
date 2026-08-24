package wails

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A capture is a read, and nothing else.
//
// docs/tech/NATIVE-LAYER.md, Capture: a ScreenCaptureKit capture of this
// process's own window holds "the main webview and every native child in one
// image with no holes. A per-webview snapshot cannot do that."
//
// A compositing path was added to this package anyway, on a measurement that a
// browser pane came back flat. That measurement was taken while the surface was
// attached to the wrong window — the host resolved one native handle for every
// commit — and the pane was genuinely not in that window's pixels. The window
// defect was fixed on 2026-08-16 and the measurement stopped holding the same
// day: with the compositing path disabled entirely, a capture of the workspace
// window held the browser page, the note reporting surfaces 0 and drawn 0.
//
// What the composite cost while it stood is the whole reason for this gate. It
// drew each surface's OWN render at the rectangle the ledger claimed, so the
// image showed what should have been there rather than what was. A browser in
// the wrong window appeared in a picture of the right one, and the pane a person
// was looking at was empty. An instrument that cannot fail the way the screen
// fails reports success either way.
var captureReadFiles = []string{
	"capture.go",
	"capture_commands.go",
	"capture_record.go",
	"capture_service.go",
}

func TestACaptureDrawsNothingItDidNotRead(t *testing.T) {
	// Names of the removed compositing path.
	drawn := []string{
		"CompositeSurfaces", "SurfaceImages", "CompositorImages", "SurfacePixels",
		"image/png", "image/draw",
	}
	// A capture that pulls pixels from anywhere but the window is the defect,
	// whatever the new spelling.

	for _, name := range captureReadFiles {
		source, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("reading %s: %v", name, err)
		}
		for _, reached := range drawn {
			if strings.Contains(string(source), reached) {
				t.Errorf("%s names %q; a capture answers the window's own pixels and draws nothing into them",
					name, reached)
			}
		}
	}
}

func TestCaptureDoesNotChangeWebKitSchedulingThroughPrivateSPI(t *testing.T) {
	files, err := filepath.Glob("capture*")
	if err != nil {
		t.Fatal(err)
	}
	files = append(files,
		"window_host_wails.go",
		"../../frontend/src/commands/catalogWindow.ts",
		"../../frontend/src/commands/catalogCapture.ts",
	)
	for _, path := range files {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		for _, forbidden := range []string{
			"_setWindowOcclusionDetectionEnabled:",
			"soksakSetWindowOcclusionDetection",
			"window_occlusion",
			"soksak:capture-prepare",
			"settleAnimationsForCapture",
		} {
			if strings.Contains(string(body), forbidden) {
				t.Errorf("%s changes capture scheduling through %q", path, forbidden)
			}
		}
	}
}
