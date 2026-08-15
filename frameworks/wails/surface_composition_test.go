package wails

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/soksak/soksak-core/core/control"
)

// stubComposition is a composition that was recorded somewhere else. It exists
// so the drift arithmetic can be judged with no window, no compositor and no
// native layer — the numbers are the rule, and the rule must be provable
// without the thing that produces them.
type stubComposition struct{ latest Composition }

func (s stubComposition) Latest() Composition { return s.latest }

func surfaceRegistry(t *testing.T, latest Composition, parent bool) *control.Registry {
	t.Helper()
	registry := control.NewRegistry()
	RegisterSurface(registry, SurfaceDeps{
		Composition:  stubComposition{latest: latest},
		NativeParent: func() bool { return parent },
	})
	return registry
}

// surfaceStatsPayload invokes the command and decodes what a caller receives,
// rather than the Go value. The payload is the contract: a field the page reads
// by another name is missing to the page whatever the struct calls it.
func surfaceStatsPayload(t *testing.T, registry *control.Registry) map[string]any {
	t.Helper()
	answer, err := registry.Invoke("engine_surface_stats", nil)
	if err != nil {
		t.Fatalf("engine_surface_stats: %v", err)
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

func placedSurface(id string, declared, applied SurfaceFrame) SurfacePlacement {
	return SurfacePlacement{
		ID: id, Kind: "browser", Generation: 1, Layer: 10,
		Declared: declared, DeclaredVisible: true, DeclaredAlpha: 1,
		Applied: applied, AppliedVisible: true, AppliedAlpha: 1,
	}
}

func surfaceRows(t *testing.T, payload map[string]any) []map[string]any {
	t.Helper()
	raw, present := payload["surfaces"]
	if !present {
		t.Fatalf("the payload carries no surfaces: %v", payload)
	}
	list, ok := raw.([]any)
	if !ok {
		t.Fatalf("surfaces is not a list: %T", raw)
	}
	out := make([]map[string]any, 0, len(list))
	for _, entry := range list {
		row, ok := entry.(map[string]any)
		if !ok {
			t.Fatalf("a surface row is not an object: %T", entry)
		}
		out = append(out, row)
	}
	return out
}

// The whole reason this group exists: the declaration and the native read-back
// arrive in one CSS top-left space, so the compositing verdict is a subtraction
// a caller can read as a number instead of a screenshot to squint at.
func TestTheCompositionReportsBothHalvesAndTheDifference(t *testing.T) {
	registry := surfaceRegistry(t, Composition{
		Sequence: 7,
		Placements: []SurfacePlacement{
			placedSurface("browser-1",
				SurfaceFrame{X: 10, Y: 20, W: 300, H: 200},
				SurfaceFrame{X: 10, Y: 26, W: 300, H: 200}),
		},
	}, true)

	payload := surfaceStatsPayload(t, registry)
	row := surfaceRows(t, payload)[0]

	for key, want := range map[string]map[string]float64{
		"declared": {"x": 10, "y": 20, "w": 300, "h": 200},
		"frame":    {"x": 10, "y": 26, "w": 300, "h": 200},
		"drift":    {"x": 0, "y": 6, "w": 0, "h": 0},
	} {
		got, ok := row[key].(map[string]any)
		if !ok {
			t.Fatalf("%s is not a rectangle: %#v", key, row[key])
		}
		for axis, value := range want {
			if got[axis] != value {
				t.Errorf("%s.%s = %v, want %v", key, axis, got[axis], value)
			}
		}
	}
	if row["displaced"] != true {
		t.Errorf("a surface applied 6 points below its declaration is not displaced: %#v", row)
	}
	if payload["displaced"] != float64(1) {
		t.Errorf("displaced = %v, want 1", payload["displaced"])
	}
	if payload["sequence"] != float64(7) {
		t.Errorf("sequence = %v, want 7", payload["sequence"])
	}
}

// Zero is the pass condition, and it has to be reachable. A verdict that can
// only ever say "displaced" measures the arithmetic instead of the layer.
func TestAnExactMatchIsZeroDifference(t *testing.T) {
	frame := SurfaceFrame{X: 4, Y: 8, W: 100, H: 50}
	registry := surfaceRegistry(t, Composition{
		Sequence:   3,
		Placements: []SurfacePlacement{placedSurface("browser-1", frame, frame)},
	}, true)

	payload := surfaceStatsPayload(t, registry)
	if payload["displaced"] != float64(0) {
		t.Fatalf("displaced = %v, want 0", payload["displaced"])
	}
	row := surfaceRows(t, payload)[0]
	drift, _ := row["drift"].(map[string]any)
	for axis, value := range drift {
		if value != float64(0) {
			t.Errorf("drift.%s = %v, want 0", axis, value)
		}
	}
	if row["displaced"] != false {
		t.Errorf("an exact match reports displaced: %#v", row)
	}
}

// The page reads frame.w and frame.h. A payload that spells them width and
// height hands it undefined, every overflow subtraction becomes NaN, NaN
// compares false against the tolerance, and the check reports "every surface is
// inside the window" for a surface that is nowhere near it.
func TestTheRectangleKeysAreTheOnesThePageReads(t *testing.T) {
	registry := surfaceRegistry(t, Composition{
		Sequence: 1,
		Placements: []SurfacePlacement{
			placedSurface("browser-1", SurfaceFrame{W: 10, H: 10}, SurfaceFrame{W: 10, H: 10}),
		},
	}, true)

	for key, rect := range map[string]any(surfaceRows(t, surfaceStatsPayload(t, registry))[0]) {
		object, ok := rect.(map[string]any)
		if !ok || len(object) != 4 {
			continue
		}
		if _, wrong := object["width"]; wrong {
			t.Errorf("%s carries width; the page reads w", key)
		}
		if _, wrong := object["height"]; wrong {
			t.Errorf("%s carries height; the page reads h", key)
		}
		for _, axis := range []string{"x", "y", "w", "h"} {
			if _, present := object[axis]; !present {
				t.Errorf("%s has no %s", key, axis)
			}
		}
	}
}

// The page's fallback for a failed read is registered:-1. Answering 0 surfaces
// when nothing has ever been committed would be indistinguishable from a
// window whose panes hold no native surface — one is a boot that has not
// happened, the other is a correct empty composition.
func TestNoCommitYetIsNotAnEmptyComposition(t *testing.T) {
	never := surfaceStatsPayload(t, surfaceRegistry(t, Composition{}, true))
	if never["sequence"] != float64(0) {
		t.Errorf("sequence = %v before any commit, want 0", never["sequence"])
	}
	if never["registered"] != float64(0) {
		t.Errorf("registered = %v before any commit, want 0", never["registered"])
	}

	empty := surfaceStatsPayload(t, surfaceRegistry(t, Composition{Sequence: 12}, true))
	if empty["sequence"] != float64(12) {
		t.Errorf("sequence = %v after an empty commit, want 12", empty["sequence"])
	}
	if never["sequence"] == empty["sequence"] {
		t.Error("a committed empty inventory reads the same as no commit at all")
	}
}

// A composition that keeps answering with the last inventory that landed while
// every new one is refused looks healthy. The refusal is the fact worth having.
func TestAnApplyThatDidNotLandIsCarriedByName(t *testing.T) {
	payload := surfaceStatsPayload(t, surfaceRegistry(t, Composition{
		Sequence:       4,
		Failure:        "browser native batch inventory mismatch: desired=2 applied=1",
		FailedSequence: 5,
	}, true))

	failure, _ := payload["failure"].(string)
	if !strings.Contains(failure, "inventory mismatch") {
		t.Errorf("failure = %q; it must carry what the native layer said", failure)
	}
	if payload["failedSequence"] != float64(5) {
		t.Errorf("failedSequence = %v, want 5", payload["failedSequence"])
	}
	if payload["sequence"] != float64(4) {
		t.Errorf("sequence = %v; the composition is still the last one that landed", payload["sequence"])
	}
}

// A surface the native layer holds that no declaration asked for, and a
// declaration the native layer never reported back, are different defects and
// both carry the name of the surface.
func TestUnmatchedHalvesAreNamed(t *testing.T) {
	orphan := placedSurface("browser-9", SurfaceFrame{}, SurfaceFrame{X: 5, Y: 5, W: 20, H: 20})
	orphan.Undeclared = true
	payload := surfaceStatsPayload(t, surfaceRegistry(t, Composition{
		Sequence:   2,
		Placements: []SurfacePlacement{orphan},
		Unapplied:  []string{"browser-3"},
	}, true))

	row := surfaceRows(t, payload)[0]
	if row["undeclared"] != true {
		t.Errorf("a surface no declaration asked for is not marked: %#v", row)
	}
	if row["displaced"] != true {
		t.Error("a surface with no declaration cannot match one, so it is displaced")
	}
	unapplied, _ := payload["unapplied"].([]any)
	if len(unapplied) != 1 || unapplied[0] != "browser-3" {
		t.Errorf("unapplied = %#v, want [browser-3]", payload["unapplied"])
	}
}

// hidden is what the native layer reported, never what the document asked for:
// the whole point of reading this is to catch the two disagreeing.
func TestHiddenComesFromTheAppliedHalf(t *testing.T) {
	frame := SurfaceFrame{W: 10, H: 10}
	hidden := placedSurface("browser-1", frame, frame)
	hidden.AppliedVisible = false

	transparent := placedSurface("browser-2", frame, frame)
	transparent.AppliedAlpha = 0

	collapsed := placedSurface("browser-3", frame, SurfaceFrame{X: 4, Y: 4})

	registry := surfaceRegistry(t, Composition{
		Sequence:   1,
		Placements: []SurfacePlacement{hidden, transparent, collapsed},
	}, true)

	list := surfaceRows(t, surfaceStatsPayload(t, registry))
	if list[0]["hidden"] != true || list[0]["effectivelyHidden"] != true {
		t.Errorf("a surface the native layer hid reads visible: %#v", list[0])
	}
	if list[1]["hidden"] != false {
		t.Errorf("a fully transparent surface is not hidden, it is transparent: %#v", list[1])
	}
	if list[1]["effectivelyHidden"] != true {
		t.Errorf("alpha 0 puts no light on the screen: %#v", list[1])
	}
	if list[2]["effectivelyHidden"] != true {
		t.Errorf("a surface with no area puts no light on the screen: %#v", list[2])
	}
}

// The page reads providerParentPresent to tell "the native container is gone"
// from "there are no surfaces". Both answer with an empty list.
func TestTheNativeParentIsReportedSeparatelyFromTheSurfaceCount(t *testing.T) {
	present := surfaceStatsPayload(t, surfaceRegistry(t, Composition{}, true))
	if present["providerParentPresent"] != true {
		t.Errorf("providerParentPresent = %v, want true", present["providerParentPresent"])
	}
	gone := surfaceStatsPayload(t, surfaceRegistry(t, Composition{}, false))
	if gone["providerParentPresent"] != false {
		t.Errorf("providerParentPresent = %v, want false", gone["providerParentPresent"])
	}
}

// One inventory, one writer. A backend command that closes or hides one surface
// is the second writer NATIVE-LAYER.md refuses: the next full commit reverts
// it, so the caller sees the surface return with no way to determine why.
func TestTheCommandsTheInventoryOwnsAreRefusedWithSomewhereToGo(t *testing.T) {
	registry := surfaceRegistry(t, Composition{}, true)

	served := map[string]bool{}
	for _, command := range registry.Describe().Commands {
		served[command.Name] = true
	}
	refused := map[string]string{}
	for _, entry := range registry.Describe().Unserved {
		refused[entry.Name] = entry.BlockedBy
	}

	for name, mustSay := range map[string]string{
		"webview_close":   "data-native-surface",
		"webview_recover": "crash",
	} {
		if served[name] {
			t.Errorf("%s is served; a second writer's change is reverted by the next commit", name)
		}
		reason, declared := refused[name]
		if !declared {
			t.Errorf("%s is neither served nor declared unserved; the caller gets 'not registered'", name)
			continue
		}
		if !strings.Contains(reason, mustSay) {
			t.Errorf("%s is refused with %q, which does not tell the caller where to go instead (want %q in it)",
				name, reason, mustSay)
		}
		_, err := registry.Invoke(name, nil)
		if err == nil {
			t.Errorf("%s answered instead of refusing", name)
			continue
		}
		if !strings.Contains(err.Error(), name) || !strings.Contains(err.Error(), reason) {
			t.Errorf("invoking %s failed with %q; it must carry the name and the reason", name, err)
		}
	}
}

func TestTheSurfaceCommandBelongsToTheFramework(t *testing.T) {
	// There is no host-independent answer: a process with no window has no
	// native layer to have applied anything.
	for _, command := range surfaceRegistry(t, Composition{}, true).Describe().Commands {
		if command.Name != "engine_surface_stats" {
			continue
		}
		if command.Owner != control.OwnerFramework {
			t.Errorf("engine_surface_stats is owned by %q; the surfaces belong to a window", command.Owner)
		}
		return
	}
	t.Fatal("engine_surface_stats is not on the registry")
}

func TestTheSurfaceGroupRefusesToRegisterHalfWired(t *testing.T) {
	for name, deps := range map[string]SurfaceDeps{
		"no composition":   {NativeParent: func() bool { return true }},
		"no native parent": {Composition: stubComposition{}},
	} {
		func() {
			defer func() {
				if recover() == nil {
					t.Errorf("registering with %s was accepted; every later answer would be a guess", name)
				}
			}()
			RegisterSurface(control.NewRegistry(), deps)
		}()
	}
}
