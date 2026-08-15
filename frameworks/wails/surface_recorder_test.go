package wails

import (
	"errors"
	"strings"
	"testing"
	"unsafe"

	compositor "github.com/soksak/wails-service-native-compositor"
)

// stubNativeLayer is a native layer that applies nothing. It reports whatever it is
// told to report, which is how a read-back that disagrees with the declaration
// becomes reproducible with no window.
type stubNativeLayer struct {
	applied []compositor.AppliedSurface
	err     error
	// saw is the inventory the recorder handed on. The recorder is a witness,
	// never a writer, and this is what proves it.
	saw []compositor.Snapshot
}

func (backend *stubNativeLayer) Apply(_ unsafe.Pointer, snapshot compositor.Snapshot) ([]compositor.AppliedSurface, error) {
	backend.saw = append(backend.saw, snapshot)
	if backend.err != nil {
		return nil, backend.err
	}
	return backend.applied, nil
}

func declaredNativeSurface(id string, generation uint64, frame compositor.Frame) compositor.Surface {
	return compositor.Surface{
		ID: id, Generation: generation, Kind: "browser",
		Frame: frame, Visible: true, Alpha: 1, Layer: 10,
	}
}

// The declaration and the read-back are only comparable when they come from one
// commit. Read from two places at two moments, a resize turns a correct layer
// into a drift report and back again depending on which read won.
func TestTheRecorderHoldsBothHalvesOfOneCommit(t *testing.T) {
	backend := &stubNativeLayer{applied: []compositor.AppliedSurface{
		{ID: "browser-1", Generation: 3, Frame: compositor.Frame{X: 10, Y: 26, Width: 300, Height: 200}, Visible: true, Alpha: 1, Layer: 10},
	}}
	recorder := NewSurfaceRecorder(backend)

	if _, err := recorder.Apply(nil, compositor.Snapshot{
		Sequence: 9,
		Surfaces: []compositor.Surface{
			declaredNativeSurface("browser-1", 3, compositor.Frame{X: 10, Y: 20, Width: 300, Height: 200}),
		},
	}); err != nil {
		t.Fatalf("apply: %v", err)
	}

	latest := recorder.Latest()
	if latest.Sequence != 9 {
		t.Errorf("sequence = %d, want 9", latest.Sequence)
	}
	if len(latest.Placements) != 1 {
		t.Fatalf("placements = %d, want 1", len(latest.Placements))
	}
	placement := latest.Placements[0]
	if placement.Declared != (SurfaceFrame{X: 10, Y: 20, W: 300, H: 200}) {
		t.Errorf("declared = %+v", placement.Declared)
	}
	if placement.Applied != (SurfaceFrame{X: 10, Y: 26, W: 300, H: 200}) {
		t.Errorf("applied = %+v", placement.Applied)
	}
	if placement.Kind != "browser" || placement.Generation != 3 || placement.Layer != 10 {
		t.Errorf("the identity of the surface did not survive the recording: %+v", placement)
	}
	if drift := placement.Drift(); drift != (SurfaceFrame{Y: 6}) {
		t.Errorf("drift = %+v, want a 6 point difference on y alone", drift)
	}
}

// The recorder sits on the one path the inventory travels. Changing what it
// carries would make the composition it reports a description of itself.
func TestTheRecorderPassesTheInventoryThroughUntouched(t *testing.T) {
	backend := &stubNativeLayer{}
	recorder := NewSurfaceRecorder(backend)
	snapshot := compositor.Snapshot{
		Sequence: 2,
		Surfaces: []compositor.Surface{
			declaredNativeSurface("browser-1", 1, compositor.Frame{Width: 5, Height: 5}),
		},
	}

	// The inner backend's answer is the answer. A recorder that refused an
	// inventory of its own would be a second policy on the one write path, and
	// the surfaces it rejected would already be on screen.
	if _, err := recorder.Apply(nil, snapshot); err != nil {
		t.Fatalf("the recorder refused what the native layer accepted: %v", err)
	}
	if len(backend.saw) != 1 {
		t.Fatalf("the inner backend saw %d snapshots, want 1", len(backend.saw))
	}
	if backend.saw[0].Sequence != 2 || len(backend.saw[0].Surfaces) != 1 {
		t.Errorf("the recorder altered the inventory: %+v", backend.saw[0])
	}
}

// A failing apply that overwrote the composition would answer with an empty
// layer while the previous surfaces are still on screen. A failing apply that
// left no trace would answer with a healthy composition forever.
func TestAFailedApplyLeavesTheCompositionAndNamesItself(t *testing.T) {
	backend := &stubNativeLayer{applied: []compositor.AppliedSurface{
		{ID: "browser-1", Generation: 1, Frame: compositor.Frame{Width: 100, Height: 100}, Visible: true, Alpha: 1},
	}}
	recorder := NewSurfaceRecorder(backend)
	if _, err := recorder.Apply(nil, compositor.Snapshot{
		Sequence: 4,
		Surfaces: []compositor.Surface{declaredNativeSurface("browser-1", 1, compositor.Frame{Width: 100, Height: 100})},
	}); err != nil {
		t.Fatalf("apply: %v", err)
	}

	backend.err = errors.New("apply WKWebView batch: status=2")
	if _, err := recorder.Apply(nil, compositor.Snapshot{Sequence: 5}); err == nil {
		t.Fatal("the recorder swallowed the native layer's failure")
	}

	latest := recorder.Latest()
	if latest.Sequence != 4 || len(latest.Placements) != 1 {
		t.Errorf("the failed apply replaced the composition: %+v", latest)
	}
	if !strings.Contains(latest.Failure, "status=2") {
		t.Errorf("failure = %q; it must carry what the native layer said", latest.Failure)
	}
	if latest.FailedSequence != 5 {
		t.Errorf("failedSequence = %d, want 5", latest.FailedSequence)
	}

	// And it clears, or one bad commit makes every later healthy one look bad.
	backend.err = nil
	if _, err := recorder.Apply(nil, compositor.Snapshot{Sequence: 6}); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if recorder.Latest().Failure != "" {
		t.Errorf("a landed commit left the previous failure behind: %q", recorder.Latest().Failure)
	}
}

// Both halves arrive sorted by id, but nothing in the contract says the native
// layer must return them in the order it was given. Pairing by position would
// subtract one surface's frame from another's.
func TestTheHalvesArePairedByIdentityNotByPosition(t *testing.T) {
	backend := &stubNativeLayer{applied: []compositor.AppliedSurface{
		{ID: "browser-2", Generation: 1, Frame: compositor.Frame{X: 200, Width: 10, Height: 10}, Visible: true, Alpha: 1},
		{ID: "browser-1", Generation: 1, Frame: compositor.Frame{X: 100, Width: 10, Height: 10}, Visible: true, Alpha: 1},
	}}
	recorder := NewSurfaceRecorder(backend)
	if _, err := recorder.Apply(nil, compositor.Snapshot{
		Sequence: 1,
		Surfaces: []compositor.Surface{
			declaredNativeSurface("browser-1", 1, compositor.Frame{X: 100, Width: 10, Height: 10}),
			declaredNativeSurface("browser-2", 1, compositor.Frame{X: 200, Width: 10, Height: 10}),
		},
	}); err != nil {
		t.Fatalf("apply: %v", err)
	}

	for _, placement := range recorder.Latest().Placements {
		if drift := placement.Drift(); drift != (SurfaceFrame{}) {
			t.Errorf("%s drifted by %+v; the halves were paired by position", placement.ID, drift)
		}
	}
}

// A surface on screen that no declaration asked for, and a declaration the
// native layer never answered about, both carry the surface's name. Dropping
// either would make the count agree while the screen does not.
func TestTheRecorderNamesEveryHalfWithoutAPartner(t *testing.T) {
	backend := &stubNativeLayer{applied: []compositor.AppliedSurface{
		{ID: "browser-9", Generation: 1, Frame: compositor.Frame{Width: 10, Height: 10}, Visible: true, Alpha: 1},
	}}
	recorder := NewSurfaceRecorder(backend)
	_, err := recorder.Apply(nil, compositor.Snapshot{
		Sequence: 1,
		Surfaces: []compositor.Surface{declaredNativeSurface("browser-1", 1, compositor.Frame{Width: 10, Height: 10})},
	})
	if err != nil {
		t.Fatalf("apply: %v", err)
	}

	latest := recorder.Latest()
	if len(latest.Placements) != 1 || latest.Placements[0].ID != "browser-9" || !latest.Placements[0].Undeclared {
		t.Errorf("the surface the native layer holds is not reported as undeclared: %+v", latest.Placements)
	}
	if len(latest.Unapplied) != 1 || latest.Unapplied[0] != "browser-1" {
		t.Errorf("unapplied = %v, want [browser-1]", latest.Unapplied)
	}
}

func TestARecorderWithNothingToRecordIsRefused(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("a recorder with no backend was built; every commit would report success and apply nothing")
		}
	}()
	NewSurfaceRecorder(nil)
}
