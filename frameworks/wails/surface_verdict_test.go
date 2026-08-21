package wails

import (
	"encoding/json"
	"testing"

	"github.com/soksak-ai/soksak-core/core/control"
)

// surface.composition is the named judgement.
//
// engine_surface_stats already has both halves and their difference, one entry
// per surface. A caller asking whether the screen holds the layout
// has to walk the list and take a maximum, which puts the rule in every caller
// and means two callers can disagree about the same commit. This is that
// maximum, taken once, next to the coordinate system it is measured in.
func compositionPayload(t *testing.T, registry *control.Registry) map[string]any {
	t.Helper()
	answer, err := registry.Invoke("surface.composition", control.Args{"window": jsonString("main")})
	if err != nil {
		t.Fatalf("surface.composition: %v", err)
	}
	encoded, err := json.Marshal(answer)
	if err != nil {
		t.Fatalf("encoding the answer: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("decoding the answer: %v", err)
	}
	return decoded
}

func TestTheCompositionAnswersOneNumber(t *testing.T) {
	registry := surfaceRegistry(t, Composition{
		Sequence: 7,
		Placements: []SurfacePlacement{
			placedSurface("browser-main-tab-7k2qx3", SurfaceFrame{X: 10, Y: 20, W: 300, H: 400}, SurfaceFrame{X: 10, Y: 20, W: 300, H: 400}),
			placedSurface("browser-main-tab-4mz6ph", SurfaceFrame{X: 0, Y: 0, W: 100, H: 100}, SurfaceFrame{X: 0, Y: 0, W: 100, H: 100}),
		},
	}, true)

	payload := compositionPayload(t, registry)
	if payload["worst"] != float64(0) {
		t.Errorf("two surfaces on their declared rectangles answer worst %v, not 0", payload["worst"])
	}
	if payload["sequence"] != float64(7) {
		t.Errorf("the answer came from sequence %v, not the commit that produced it", payload["sequence"])
	}
	if payload["coordinates"] != "css-top-left" {
		t.Errorf("the coordinate system is %v; both halves are declared to be CSS top-left", payload["coordinates"])
	}
}

func TestTheCompositionExposesInteractivePresentationAndSettledFrame(t *testing.T) {
	placement := placedSurface(
		"browser-main-tab-7k2qx3",
		SurfaceFrame{X: 40, Y: 20, W: 760, H: 580},
		SurfaceFrame{X: 40, Y: 20, W: 760, H: 580},
	)
	settled := SurfaceFrame{X: 256, Y: 20, W: 544, H: 580}
	placement.Settled = &settled
	placement.LayerContentsRedrawPolicy = 2
	placement.LayerContentsPlacement = 11
	registry := surfaceRegistry(t, Composition{Interactive: true, Sequence: 8, Placements: []SurfacePlacement{placement}}, true)

	payload := compositionPayload(t, registry)
	if payload["interactive"] != true {
		t.Fatalf("interactive phase is not exposed: %v", payload["interactive"])
	}
	surfaces := payload["surfaces"].([]any)
	settledPayload := surfaces[0].(map[string]any)["settled"].(map[string]any)
	if settledPayload["x"] != float64(256) || settledPayload["w"] != float64(544) {
		t.Fatalf("raw settled frame is not exposed: %v", settledPayload)
	}
	surface := surfaces[0].(map[string]any)
	if surface["layerContentsRedrawPolicy"] != float64(2) || surface["layerContentsPlacement"] != float64(11) {
		t.Fatalf("live resize layer policy is not exposed: %v", surface)
	}
}

func TestTheWorstDifferenceIsTheLargestOneAnywhere(t *testing.T) {
	// Largest across every surface and every component. Reporting the first
	// difference, or only the origin, lets a surface that is the right size in
	// the wrong place hide behind one that is merely a point off.
	registry := surfaceRegistry(t, Composition{
		Sequence: 3,
		Placements: []SurfacePlacement{
			placedSurface("browser-main-tab-7k2qx3", SurfaceFrame{X: 0, Y: 0, W: 100, H: 100}, SurfaceFrame{X: 1, Y: 0, W: 100, H: 100}),
			placedSurface("browser-main-tab-4mz6ph", SurfaceFrame{X: 0, Y: 0, W: 100, H: 100}, SurfaceFrame{X: 0, Y: 0, W: 100, H: 88}),
			placedSurface("browser-main-tab-qd53wv", SurfaceFrame{X: 0, Y: 0, W: 100, H: 100}, SurfaceFrame{X: 0, Y: -4, W: 100, H: 100}),
		},
	}, true)

	payload := compositionPayload(t, registry)
	if payload["worst"] != float64(12) {
		t.Errorf("worst is %v; the largest difference anywhere is 12 (the height of browser-main-tab-4mz6ph)", payload["worst"])
	}
	if payload["displaced"] != float64(3) {
		t.Errorf("%v surfaces counted as displaced, not 3", payload["displaced"])
	}
}

func TestASurfaceMissingFromOneHalfIsNotADifference(t *testing.T) {
	// A surface that was declared and never applied is not a rectangle in the
	// wrong place; there is no rectangle. Folding it into worst would answer a
	// number for something that has none, and folding it into 0 would call a
	// pane with no surface correct.
	registry := surfaceRegistry(t, Composition{
		Sequence:  4,
		Unapplied: []string{"browser-main-tab-2fjr7c"},
		Placements: []SurfacePlacement{
			placedSurface("browser-main-tab-7k2qx3", SurfaceFrame{X: 0, Y: 0, W: 10, H: 10}, SurfaceFrame{X: 0, Y: 0, W: 10, H: 10}),
			{ID: "browser-main-tab-cw3lpd", Applied: SurfaceFrame{X: 5, Y: 5, W: 20, H: 20}, Undeclared: true},
		},
	}, true)

	payload := compositionPayload(t, registry)
	if payload["worst"] != float64(0) {
		t.Errorf("worst is %v; the one surface with both halves sits on its rectangle", payload["worst"])
	}
	unapplied, _ := payload["unapplied"].([]any)
	if len(unapplied) != 1 || unapplied[0] != "browser-main-tab-2fjr7c" {
		t.Errorf("unapplied is %v, not the one surface that was declared and never applied", payload["unapplied"])
	}
	undeclared, _ := payload["undeclared"].([]any)
	if len(undeclared) != 1 || undeclared[0] != "browser-main-tab-cw3lpd" {
		t.Errorf("undeclared is %v, not the one surface on screen that nobody asked for", payload["undeclared"])
	}
}

func TestAFailedApplyIsCarriedIntoTheJudgement(t *testing.T) {
	// The compositor keeps answering with the last inventory that landed, so a
	// layer refusing every new one still reports zero difference. The answer
	// names the refusal and the sequence it happened at; without them every
	// reading of a stuck compositor is a screen that looks correct.
	registry := surfaceRegistry(t, Composition{
		Sequence:       9,
		Failure:        "the native parent went away",
		FailedSequence: 10,
		Placements: []SurfacePlacement{
			placedSurface("browser-main-tab-7k2qx3", SurfaceFrame{X: 0, Y: 0, W: 10, H: 10}, SurfaceFrame{X: 0, Y: 0, W: 10, H: 10}),
		},
	}, true)

	payload := compositionPayload(t, registry)
	if payload["worst"] != float64(0) {
		t.Errorf("worst is %v; the surfaces that did land are on their rectangles", payload["worst"])
	}
	if payload["failure"] != "the native parent went away" {
		t.Errorf("the refusal is %v", payload["failure"])
	}
	if payload["failedSequence"] != float64(10) {
		t.Errorf("the refusal happened at %v, not 10", payload["failedSequence"])
	}
	if payload["sequence"] != float64(9) {
		t.Errorf("the numbers describe sequence %v, which is the last one that landed", payload["sequence"])
	}
}

func TestNoNativeParentIsSaidRatherThanCountedAsZeroDifference(t *testing.T) {
	// With no container to attach to there are no surfaces, and no surfaces is
	// worst 0. That is the same answer as a screen that is correct, so the
	// container is a separate field.
	registry := surfaceRegistry(t, Composition{}, false)

	payload := compositionPayload(t, registry)
	if payload["nativeParentPresent"] != false {
		t.Errorf("nativeParentPresent is %v with no container", payload["nativeParentPresent"])
	}
	if payload["sequence"] != float64(0) {
		t.Errorf("sequence is %v; nothing has been applied", payload["sequence"])
	}
}

func TestTheCompositionJudgementBelongsToTheFramework(t *testing.T) {
	// A process with no window has no native layer, so there is no
	// host-independent answer to what it applied.
	for _, command := range surfaceRegistry(t, Composition{}, true).Describe().Commands {
		if command.Name != "surface.composition" {
			continue
		}
		if command.Owner != control.OwnerFramework {
			t.Errorf("surface.composition is owned by %q; the surfaces belong to a window", command.Owner)
		}
		return
	}
	t.Fatal("surface.composition is not on the registry")
}
