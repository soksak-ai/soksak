package wails

import (
	"strings"
	"testing"

	"github.com/soksak/soksak-core/core/control"
)

func captureRegistry(t *testing.T) *control.Registry {
	t.Helper()
	registry := control.NewRegistry()
	// No window: these must answer that rather than take the process down, and
	// this test package has no application to give them one.
	RegisterCapture(registry, NewCaptureService(nil))
	return registry
}

func TestTheCaptureIsReachableThroughTheRegistry(t *testing.T) {
	// It was a frontend binding only, which made the surface that exists to be
	// looked at the one an outside caller could not ask for.
	described := captureRegistry(t).Describe()

	found := map[string]control.Owner{}
	for _, command := range described.Commands {
		found[command.Name] = command.Owner
	}
	for _, name := range []string{"window_snapshot", "window_snapshot_region"} {
		owner, present := found[name]
		if !present {
			t.Errorf("%s is not on the registry", name)
			continue
		}
		if owner != control.OwnerFramework {
			t.Errorf("%s is owned by %q; the pixels belong to a window", name, owner)
		}
	}
}

func TestCaptureNeedsSomewhereToWrite(t *testing.T) {
	if _, err := captureRegistry(t).Invoke("window_snapshot", nil); err == nil {
		t.Fatal("a snapshot with no path succeeded")
	}
}

func TestCaptureWithNoWindowSaysSoRatherThanCrashing(t *testing.T) {
	_, err := captureRegistry(t).Invoke("window_snapshot",
		callArgs(t, map[string]any{"path": "<local-evidence>/does-not-matter.png"}))
	if err == nil {
		t.Fatal("a capture with no window succeeded")
	}
	if !strings.Contains(err.Error(), "window") {
		t.Errorf("the refusal did not name what was missing: %v", err)
	}
}

func TestARegionOfNoAreaIsRefusedRatherThanWidened(t *testing.T) {
	// Zero would reach the capture as Whole. A caller who asked for a region
	// and received the window compares the wrong pixels and believes them.
	for _, rect := range []map[string]any{
		{"path": "<local-evidence>/x.png", "x": 0, "y": 0, "width": 0, "height": 100},
		{"path": "<local-evidence>/x.png", "x": 0, "y": 0, "width": 100, "height": 0},
		{"path": "<local-evidence>/x.png", "x": 0, "y": 0, "width": -5, "height": 100},
	} {
		_, err := captureRegistry(t).Invoke("window_snapshot_region", callArgs(t, rect))
		if err == nil {
			t.Errorf("%v was accepted as a region", rect)
			continue
		}
		if strings.Contains(err.Error(), "window capture") {
			t.Errorf("%v reached the capture rather than being refused: %v", rect, err)
		}
	}
}

func TestARegionNeedsEveryComponent(t *testing.T) {
	// A missing component would decode as zero, which is a legitimate origin
	// and an impossible size — so it is named instead.
	_, err := captureRegistry(t).Invoke("window_snapshot_region",
		callArgs(t, map[string]any{"path": "<local-evidence>/x.png", "x": 0, "y": 0, "width": 100}))
	if err == nil {
		t.Fatal("a region missing its height was accepted")
	}
	if !strings.Contains(err.Error(), "height") {
		t.Errorf("the refusal did not name the missing component: %v", err)
	}
}
