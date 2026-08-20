package wails

import (
	"testing"
	"unsafe"

	compositor "github.com/soksak/wails-service-native-compositor"
)

// The difference between the two halves is subtracted once, by the compositor.
//
// AGENTS 4-1: a plugin's own feature is not handed to the core. The compositor
// holds both halves of one commit — it is the only thing that has them in the
// same instant — and it answers the difference per surface as of 2026-08-16.
//
// The core kept its own subtraction. Two definitions of one number, and the day
// they disagree the drift a person reads depends on which path answered: the
// service's for a caller of the service, the core's for a caller of
// surface.composition. A rule moved to a new home and left standing at the old
// one is not moved.
func TestTheDriftIsTheOneTheCompositorSubtracted(t *testing.T) {
	handle := byte(1)
	backend := &driftingBackend{by: 3}
	service := compositor.NewService(
		func(string) unsafe.Pointer { return unsafe.Pointer(&handle) },
		map[compositor.SurfaceKind]compositor.Backend{"browser": backend})

	if _, err := service.Commit(compositor.Snapshot{
		Window: "win-3ztbjd", Sequence: 1,
		Surfaces: []compositor.Surface{{
			ID: "browser.win-3ztbjd.tab-2trqyu", Generation: 1, Kind: "browser",
			Frame: compositor.Frame{X: 10, Y: 20, Width: 100, Height: 50}, Visible: true, Alpha: 1,
		}},
	}); err != nil {
		t.Fatalf("commit: %v", err)
	}

	composition := NewCompositorSource(service).Latest("win-3ztbjd")
	if len(composition.Placements) != 1 {
		t.Fatalf("one surface was committed and the composition holds %d", len(composition.Placements))
	}
	placement := composition.Placements[0]

	// The backend applied the frame three points to the right and down. The
	// number the core answers is the number the compositor subtracted.
	want := SurfaceFrame{X: 3, Y: 3}
	if placement.Drift != want {
		t.Errorf("drift = %+v, want %+v", placement.Drift, want)
	}
	if !placement.Displaced() {
		t.Error("a surface three points off where it was declared is not displaced")
	}
}

// driftingBackend applies every surface a fixed distance from where it was
// declared, which is what a real backend does when a coordinate rule is wrong.
type driftingBackend struct{ by float64 }

func (backend *driftingBackend) Apply(
	window unsafe.Pointer,
	snapshot compositor.Snapshot,
) ([]compositor.AppliedSurface, error) {
	applied := make([]compositor.AppliedSurface, 0, len(snapshot.Surfaces))
	for _, surface := range snapshot.Surfaces {
		frame := surface.Frame
		frame.X += backend.by
		frame.Y += backend.by
		applied = append(applied, compositor.AppliedSurface{
			ID: surface.ID, Generation: surface.Generation, Frame: frame,
			Visible: surface.Visible, Alpha: surface.Alpha, Layer: surface.Layer,
			Window: window,
		})
	}
	return applied, nil
}

func (backend *driftingBackend) Deliver(string, map[string]any) (map[string]any, error) {
	return nil, nil
}
