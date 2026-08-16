package wails

import (
	"strings"
	"testing"

	"github.com/soksak/soksak-core/core/control"
)

// A region of a window is captured under the contract its callers use.
//
// Measured 2026-08-16 on the running application: window.snapshot with a tab or
// a rect, window.pixels, and window.record all failed with INTERNAL. Every one
// of them arrives at this host through window_snapshot_region, and it read a
// region as x/y/width/height with a path required, while its only caller sends
// x/y/w/h and wants the image back. Two contracts under one name, and the
// failure named neither.
//
// The keys are the caller's: the page measures a node and hands over w and h,
// the same spelling the surface frames already travel in.
func TestARegionIsReadInTheCallersSpelling(t *testing.T) {
	rect, err := captureRect(callArgs(t, map[string]any{"x": 10, "y": 20, "w": 30, "h": 40}))
	if err != nil {
		t.Fatalf("the caller's own spelling was refused: %v", err)
	}
	if rect != (Rect{X: 10, Y: 20, Width: 30, Height: 40}) {
		t.Errorf("the region arrived as %+v", rect)
	}
}

func TestNoRegionAtAllIsTheWholeWindow(t *testing.T) {
	// window.pixels and window.snapshot both send an empty region to mean the
	// window. Refusing it made the whole-window base64 capture unreachable.
	rect, err := captureRect(callArgs(t, map[string]any{}))
	if err != nil {
		t.Fatalf("an absent region was refused: %v", err)
	}
	if rect != Whole {
		t.Errorf("an absent region is %+v, not the whole window", rect)
	}
}

func TestAHalfNamedRegionNamesWhatIsMissing(t *testing.T) {
	// Absent is the whole window; half-present is a mistake, and the component
	// left out would decode as zero — a legitimate origin and an impossible size.
	_, err := captureRect(callArgs(t, map[string]any{"x": 0, "y": 0, "w": 100}))
	if err == nil {
		t.Fatal("a region missing its height was accepted")
	}
	if !strings.Contains(err.Error(), "h") {
		t.Errorf("the refusal did not name the missing component: %v", err)
	}
}

func TestARegionCaptureDoesNotNeedAPathToAnswer(t *testing.T) {
	// The caller that measures pixels never writes a file. Requiring a path made
	// the measurement path fail before it reached a window at all.
	_, err := captureRegistry(t).Invoke("window_snapshot_region",
		callArgs(t, map[string]any{"x": 0, "y": 0, "w": 10, "h": 10}))
	if err == nil {
		t.Fatal("a region capture succeeded with no window to capture")
	}
	if strings.Contains(err.Error(), "path") {
		t.Errorf("a region capture was refused for want of a path: %v", err)
	}
}

var _ = control.Args{}
