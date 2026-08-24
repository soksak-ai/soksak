package application

import (
	"encoding/json"
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
	owner := activeInputOwner(t)
	gate := newGate(t, "<local-evidence>/soksak-capture-focus-gate", "com.soksak.capturefocusgate")
	gate.start()
	if afterStart := activeInputOwner(t); afterStart != owner {
		t.Fatalf("unattended application start changed the input owner: %s -> %s", owner, afterStart)
	}
	window := gate.openWorkspace()
	if gateWindowVisible(t, gate, window) {
		t.Fatalf("unattended gate added a visible test window: %s", window)
	}
	if afterOpen := activeInputOwner(t); afterOpen != owner {
		t.Fatalf("unattended workspace open changed the input owner: %s -> %s", owner, afterOpen)
	}
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
	gate.quit()
	if afterQuit := activeInputOwner(t); afterQuit != owner {
		t.Fatalf("unattended application shutdown changed the input owner: %s -> %s", owner, afterQuit)
	}
}

func gateWindowVisible(t *testing.T, gate *restoreGate, window string) bool {
	t.Helper()
	out, err := gate.try("window.monitors", "window="+window)
	if err != nil {
		t.Fatalf("reading test window presentation: %v\n%s", err, out)
	}
	var reply struct {
		Data struct {
			Windows []struct {
				Label    string `json:"label"`
				Presence struct {
					Visible bool `json:"visible"`
				} `json:"presence"`
			} `json:"windows"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(out), &reply); err != nil {
		t.Fatalf("decoding test window presentation: %v\n%s", err, out)
	}
	for _, candidate := range reply.Data.Windows {
		if candidate.Label == window {
			return candidate.Presence.Visible
		}
	}
	t.Fatalf("test window presentation omitted %s", window)
	return false
}
