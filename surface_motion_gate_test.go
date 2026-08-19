package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

// A surface that is on screen stays on screen while the layout moves.
//
// A person recorded the window and the frames were counted: the page left x=1003, appeared at
// x=1163 one frame later, and between those two positions it was **gone for 39 frames** — 650ms of
// nothing where a browser had been (measured 2026-08-17, 60fps recording, 98 frames). It never
// occupied an intermediate position. From the seat of whoever is watching, the browser blanks and
// then reappears somewhere else.
//
// Nothing in this build could see that. The composition reports the last commit, so a reading taken
// before and after the move answers with two good frames and covers nothing in between.
// This watches the surface across the move instead, at the rate the screen changes.
const surfaceMotionGateHome = "<local-evidence>/soksak-surface-motion-gate"

const surfaceMotionGateIdentifier = "com.soksak.surfacemotiongate"

type surfaceMotionGate = restoreGate

// surfaceSample is one reading of one surface during a move.
type surfaceSample struct {
	at time.Duration
	// Whether the surface itself is on the screen.
	visible bool
	// Whether the pane is showing the picture the surface left when it stepped aside.
	pictured bool
	x        float64
	w        float64
}

// shown is what the rule is about: the pane has the page on it, one way or the other.
func (s surfaceSample) shown() bool { return (s.visible && s.w > 0) || s.pictured }

func TestASurfaceStaysOnScreenWhileTheLayoutMoves(t *testing.T) {
	gate := newGate(t, surfaceMotionGateHome, surfaceMotionGateIdentifier)
	plugins := gate.installPlugins()
	gate.start()
	defer gate.quit()

	window := gate.openWorkspace()
	// This gate records presentation without taking keyboard focus. Disable
	// background rendering suspension for the test window and restore it before
	// shutdown.
	gate.run("window_occlusion", "window="+window, "enabled=false")
	defer gate.run("window_occlusion", "window="+window, "enabled=true")
	gate.consentAndEnable(window, plugins)
	for _, program := range gate.programs(window) {
		gate.open(window, program)
	}

	// A surface has to be on screen before its disappearance means anything.
	surface := gate.aVisibleSurface(window)
	if surface == "" {
		t.Fatal("no surface is on screen, so a move cannot be watched")
	}

	// The move is the one that was recorded: a place opens, takes its width, and every pane beside
	// it shifts by that much. The link is settled first and the place closed, so the only change
	// being watched is the opening.
	set := gate.createSet(window, "motion")
	sections := gate.availableSections(window)
	if len(sections) == 0 {
		t.Fatal("this build offers no section, so no move can be caused here")
	}
	gate.run("sections.arrange", "window="+window, "set="+set, "sections="+jsonList(sections[0]))
	gate.run("sections.link", "window="+window,
		"plugin="+gate.aPluginWithAPane(window), "set="+set, "place=rail")
	gate.run("workspace.region.toggle", "window="+window, "region=rail", "open=false")

	samples := gate.watchSurface(window, surface, func() {
		gate.run("workspace.region.toggle", "window="+window, "region=rail", "open=true")
	})

	// Gone is either state a person reads as a blank pane: the compositor hiding it, or a rectangle
	// with no width left to draw in.
	var blank []surfaceSample
	for _, sample := range samples {
		if !sample.shown() {
			blank = append(blank, sample)
		}
	}
	t.Logf("%d readings across the move:\n%s", len(samples), sampleLines(samples))
	if len(blank) > 0 {
		t.Errorf("the pane holding %s showed neither the page nor its picture for %s, over %d readings.\n%s\n"+
			"A pane that goes blank is what a person reads as a view that failed.",
			surface, blank[len(blank)-1].at-blank[0].at, len(blank), sampleLines(samples))
	}
}

// watchSurface reads one surface as fast as the plane answers, from just before the change until it
// has been still for a while. Reading before and after answers with two good frames and covers
// nothing in between, which is where the hole was.
func (gate *surfaceMotionGate) watchSurface(window string, surface string, cause func()) []surfaceSample {
	gate.t.Helper()
	started := time.Now()
	var samples []surfaceSample
	read := func() surfaceSample {
		visible, frame := gate.surfaceState(window, surface)
		return surfaceSample{
			at:       time.Since(started),
			visible:  visible,
			pictured: len(gate.parkedPictures(window)) > 0,
			x:        frame[0],
			w:        frame[1],
		}
	}
	samples = append(samples, read())
	cause()
	for time.Since(started) < 2*time.Second {
		samples = append(samples, read())
	}
	return samples
}

func (gate *surfaceMotionGate) surfaceState(window string, surface string) (visible bool, frame [2]float64) {
	gate.t.Helper()
	var answer struct {
		Data struct {
			Surfaces []struct {
				ID              string `json:"id"`
				DeclaredVisible bool   `json:"declaredVisible"`
				AppliedVisible  bool   `json:"appliedVisible"`
				Applied         struct {
					X float64 `json:"x"`
					W float64 `json:"w"`
				} `json:"applied"`
			} `json:"surfaces"`
		} `json:"data"`
	}
	out := gate.run("surface.composition", "window="+window)
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		gate.t.Fatalf("surface.composition: %v\n%s", err, out)
	}
	for _, s := range answer.Data.Surfaces {
		if s.ID != surface {
			continue
		}
		return s.DeclaredVisible && s.AppliedVisible, [2]float64{s.Applied.X, s.Applied.W}
	}
	// The surface this watch names is not in the composition at all. That is a different fact from
	// a surface that is hidden — one is a page taken off the screen, the other is a page that was
	// replaced by another with a new name — and reporting the second as the first sends whoever
	// reads it to look for a visibility defect that is not there.
	gate.t.Fatalf("%s is no longer in the composition: it was replaced while it was being watched.\n%s",
		surface, out)
	return false, [2]float64{}
}

// aVisibleSurface names one surface the compositor has on screen, bringing a pane forward until one
// is. A surface already hidden proves nothing about a surface that vanishes.
func (gate *surfaceMotionGate) aVisibleSurface(window string) string {
	gate.t.Helper()
	if found := gate.visibleSurfaces(window); len(found) > 0 {
		return found[0]
	}
	for _, pane := range gate.panes(window) {
		for _, tab := range pane.Tabs {
			gate.run("pane.activate", "window="+window, "pane="+pane.ID)
			gate.activate(window, tab.ID, "motion/surface/"+tab.ID)
			// Read once. The activation's own transaction has closed, so a pane showing no surface
			// here shows none, and the next pane is tried.
			if found := gate.visibleSurfaces(window); len(found) > 0 {
				return found[0]
			}
		}
	}
	return ""
}

func sampleLines(samples []surfaceSample) string {
	lines := make([]string, 0, len(samples))
	for _, sample := range samples {
		state := "on screen "
		if !sample.visible {
			state = "picture   "
		}
		if !sample.shown() {
			state = "BLANK     "
		}
		lines = append(lines, fmt.Sprintf("  %6dms %s x=%.0f w=%.0f",
			sample.at.Milliseconds(), state, sample.x, sample.w))
	}
	return strings.Join(lines, "\n")
}
