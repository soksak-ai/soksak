//go:build applicationgate

package application

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestWindowCaptureDoesNotChangeTheInputOwner(t *testing.T) {
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
	for capture := 1; capture <= 2; capture++ {
		path, err := filepath.Abs(filepath.Join(
			".task", "capture-focus", fmt.Sprintf("window-%d.png", capture),
		))
		if err != nil {
			t.Fatal(err)
		}
		before := activeInputOwner(t)
		gate.run("window.snapshot", "window="+window, "path="+path)
		after := activeInputOwner(t)
		if before != after {
			t.Fatalf("window capture %d changed the input owner: %s -> %s", capture, before, after)
		}
		if gateWindowVisible(t, gate, window) {
			t.Fatalf("window capture %d made the test window visible: %s", capture, window)
		}
		info, err := os.Stat(path)
		if err != nil || info.Size() == 0 {
			t.Fatalf("window capture %d was not written: %v", capture, err)
		}
	}
	gate.quit()
	if afterQuit := activeInputOwner(t); afterQuit != owner {
		t.Fatalf("unattended application shutdown changed the input owner: %s -> %s", owner, afterQuit)
	}
}

func gateWindowVisible(t *testing.T, gate *restoreGate, window string) bool {
	return gateWindowPresentation(t, gate, window).Visible
}

type gatePresentation struct {
	Visible bool    `json:"visible"`
	Key     bool    `json:"key"`
	Alpha   float64 `json:"alpha"`
}

func gateWindowPresentation(t *testing.T, gate *restoreGate, window string) gatePresentation {
	t.Helper()
	out, err := gate.try("window.monitors", "window="+window)
	if err != nil {
		t.Fatalf("reading test window presentation: %v\n%s", err, out)
	}
	var reply struct {
		Data struct {
			Windows []struct {
				Label    string           `json:"label"`
				Presence gatePresentation `json:"presence"`
			} `json:"windows"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(out), &reply); err != nil {
		t.Fatalf("decoding test window presentation: %v\n%s", err, out)
	}
	for _, candidate := range reply.Data.Windows {
		if candidate.Label == window {
			return candidate.Presence
		}
	}
	t.Fatalf("test window presentation omitted %s", window)
	return gatePresentation{}
}
