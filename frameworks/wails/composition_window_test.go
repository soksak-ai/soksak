package wails

import (
	"testing"
	"unsafe"

	compositor "github.com/soksak/wails-service-native-compositor"
)

// A surface is attached to the window that declared it.
//
// Measured 2026-08-16: the host handed the compositor one native handle for
// every commit and every reading read one inventory. A workspace window's
// browser was therefore created inside the orchestrator — a 1128×718 surface
// inside a 999×617 window — while surface.composition answered the same single
// surface for `main` and for `win-8ed56cd7d9305935`, both with zero drift. The
// pane the person was looking at was empty and no number said so.
//
// Two windows, two handles, and each half of the answer keyed by the window it
// was asked about, is what makes that state reportable.
type windowRecordingBackend struct{ attached map[string]unsafe.Pointer }

func (backend *windowRecordingBackend) Apply(
	window unsafe.Pointer,
	snapshot compositor.Snapshot,
) ([]compositor.AppliedSurface, error) {
	applied := make([]compositor.AppliedSurface, 0, len(snapshot.Surfaces))
	for _, surface := range snapshot.Surfaces {
		backend.attached[surface.ID] = window
		applied = append(applied, compositor.AppliedSurface{
			ID: surface.ID, Generation: surface.Generation, Frame: surface.Frame,
			Visible: surface.Visible, Alpha: surface.Alpha, Layer: surface.Layer,
		})
	}
	return applied, nil
}

func (backend *windowRecordingBackend) Deliver(string, map[string]any) (map[string]any, error) {
	return nil, nil
}

// twoWindowCompositor is two named windows with distinct native handles, and a
// surface declared in each.
func twoWindowCompositor(t *testing.T) (*compositor.Service, *windowRecordingBackend, map[string]unsafe.Pointer) {
	t.Helper()
	orchestrator, workspace := byte(1), byte(2)
	handles := map[string]unsafe.Pointer{
		"main":  unsafe.Pointer(&orchestrator),
		"win-a": unsafe.Pointer(&workspace),
	}
	backend := &windowRecordingBackend{attached: map[string]unsafe.Pointer{}}
	service := compositor.NewService(func(name string) unsafe.Pointer { return handles[name] },
		map[compositor.SurfaceKind]compositor.Backend{"browser": backend})

	for _, declaration := range []struct {
		window string
		id     string
		frame  compositor.Frame
	}{
		{"main", "srf-orchestrator", compositor.Frame{X: 0, Y: 0, Width: 200, Height: 100}},
		{"win-a", "brw-workspace", compositor.Frame{X: 166, Y: 152, Width: 1128, Height: 718}},
	} {
		if _, err := service.Commit(compositor.Snapshot{
			Window: declaration.window, Sequence: 1,
			Surfaces: []compositor.Surface{{
				ID: declaration.id, Generation: 1, Kind: "browser",
				Frame: declaration.frame, Visible: true, Alpha: 1,
			}},
		}); err != nil {
			t.Fatalf("commit %s in %s: %v", declaration.id, declaration.window, err)
		}
	}
	return service, backend, handles
}

func TestASurfaceIsAttachedToTheWindowThatDeclaredIt(t *testing.T) {
	_, backend, handles := twoWindowCompositor(t)

	if got := backend.attached["brw-workspace"]; got != handles["win-a"] {
		t.Errorf("the workspace window's browser was attached to %v, not to win-a (%v)", got, handles["win-a"])
	}
	if got := backend.attached["srf-orchestrator"]; got != handles["main"] {
		t.Errorf("the orchestrator's surface was attached to %v, not to main (%v)", got, handles["main"])
	}
}

func TestACompositionIsTheWindowsOwn(t *testing.T) {
	service, _, _ := twoWindowCompositor(t)
	source := NewCompositorSource(service)

	workspace := source.Latest("win-a")
	if len(workspace.Placements) != 1 || workspace.Placements[0].ID != "brw-workspace" {
		t.Fatalf("win-a's composition must hold its own one surface: %+v", workspace.Placements)
	}
	orchestrator := source.Latest("main")
	if len(orchestrator.Placements) != 1 || orchestrator.Placements[0].ID != "srf-orchestrator" {
		t.Fatalf("main's composition must hold its own one surface: %+v", orchestrator.Placements)
	}
}
