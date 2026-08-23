package application

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestWindowCaptureDoesNotChangeTheInputOwner(t *testing.T) {
	for run := 0; run < 2; run++ {
		t.Run(fmt.Sprintf("run-%d", run+1), testWindowCaptureDoesNotChangeTheInputOwner)
	}
}

func testWindowCaptureDoesNotChangeTheInputOwner(t *testing.T) {
	gate := newGate(t, "<local-evidence>/soksak-capture-focus-gate", "com.soksak.capturefocusgate")
	gate.start()
	window := gate.openWorkspace()
	path, err := filepath.Abs(filepath.Join(".task", "capture-focus", "window.png"))
	if err != nil {
		t.Fatal(err)
	}
	before := activeInputOwner(t)
	gate.run("window.snapshot", "window="+window, "path="+path)
	after := activeInputOwner(t)
	if before != after {
		t.Fatalf("window capture changed the input owner: %s -> %s", before, after)
	}
	info, err := os.Stat(path)
	if err != nil || info.Size() == 0 {
		t.Fatalf("window capture was not written: %v", err)
	}
}
