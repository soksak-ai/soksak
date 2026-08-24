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
	assertCaptureOnlyWindowIsMaterialized(t, gate, window)
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
		assertCaptureOnlyWindowIsMaterialized(t, gate, window)
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

type gateWindowPresentation struct {
	Known   bool
	Visible bool
	Key     bool
	Alpha   float64
}

// A capture-only window has two independent obligations. It must be ordered into AppKit so
// WebKit and retained renderers receive presentation callbacks, and it must put no light on the
// user's desktop or become the key window. Keeping it hidden satisfies only the second obligation:
// Xterm's IntersectionObserver then pauses its renderer and a capture contains an empty terminal.
func assertCaptureOnlyWindowIsMaterialized(t *testing.T, gate *restoreGate, window string) {
	t.Helper()
	presence := gateWindowPresence(t, gate, window)
	if !presence.Known {
		t.Fatalf("capture-only window has no native presentation observation: %s", window)
	}
	if !presence.Visible {
		t.Fatalf("capture-only window is hidden, so retained renderers cannot present: %s", window)
	}
	if presence.Alpha != 0 {
		t.Fatalf("capture-only window puts light on the desktop: %s alpha=%v", window, presence.Alpha)
	}
	if presence.Key {
		t.Fatalf("capture-only window owns keyboard focus: %s", window)
	}
}

func gateWindowVisible(t *testing.T, gate *restoreGate, window string) bool {
	presence := gateWindowPresence(t, gate, window)
	return presence.Visible && presence.Alpha > 0
}

func gateWindowPresence(t *testing.T, gate *restoreGate, window string) gateWindowPresentation {
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
					Known   bool    `json:"known"`
					Visible bool    `json:"visible"`
					Key     bool    `json:"key"`
					Alpha   float64 `json:"alpha"`
				} `json:"presence"`
			} `json:"windows"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(out), &reply); err != nil {
		t.Fatalf("decoding test window presentation: %v\n%s", err, out)
	}
	for _, candidate := range reply.Data.Windows {
		if candidate.Label == window {
			return gateWindowPresentation{
				Known: candidate.Presence.Known, Visible: candidate.Presence.Visible,
				Key: candidate.Presence.Key, Alpha: candidate.Presence.Alpha,
			}
		}
	}
	t.Fatalf("test window presentation omitted %s", window)
	return gateWindowPresentation{}
}
