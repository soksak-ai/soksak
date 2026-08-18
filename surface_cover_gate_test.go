package main

import (
	"encoding/json"
	"testing"
)

// No native surface stands over another.
//
// A window's presence answers for the window and misparented for which window. Neither answers for
// one surface inside it, and until `surface.composition` carried `coveredBy` a surface entirely
// behind another held a right-looking frame, its generation and zero drift while nobody could see
// any of it — every reading in this build called that correct.
//
// This is the rule that makes the number refuse something, and it is derived rather than chosen.
// Layers are what deliberate ordering is expressed with, and nothing in this build declares one:
// every surface is layer 0, which makes them peers. Two peers holding one place is not a design,
// it is one of them being in the wrong place, and which of the two a person sees is then the order
// the inventory happened to be built in.
//
// The two states that look like exceptions are not. A pane under the plugin manager's card is under
// a DOM overlay, which is not a surface. A view that is not the active tab is parked — the core
// hides it (viewPark), so it is not applied-visible and is not there to be covered rather than
// hidden behind something.
//
// So: zero, in every state a person can put the window in.
const surfaceCoverHome = "<local-evidence>/soksak-surface-cover-gate"

const surfaceCoverIdentifier = "com.soksak.surfacecovergate"

type surfaceCoverGate = restoreGate

// coverReading is one surface and what lies over it.
type coverReading struct {
	ID              string   `json:"id"`
	AppliedVisible  bool     `json:"appliedVisible"`
	CoveredBy       []string `json:"coveredBy"`
	CoveredFraction float64  `json:"coveredFraction"`
}

// coversIn is what lies over every surface of one window.
func (gate *surfaceCoverGate) coversIn(window string) []coverReading {
	gate.t.Helper()
	var answer struct {
		Data struct {
			Surfaces []coverReading `json:"surfaces"`
		} `json:"data"`
	}
	out := gate.run("surface.composition", "window="+window)
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		gate.t.Fatalf("surface.composition: %v\n%s%s", err, out, gate.lastWords())
	}
	return answer.Data.Surfaces
}

// refuseCover reports every surface something is standing over.
func (gate *surfaceCoverGate) refuseCover(window string, state string) {
	gate.t.Helper()
	held := gate.coversIn(window)
	standing := 0
	behind := 0
	for _, surface := range held {
		if surface.AppliedVisible {
			standing++
		}
		if surface.CoveredFraction == 0 {
			continue
		}
		behind++
		gate.t.Errorf("%s: %s is %.0f%% behind %v.\n"+
			"Every surface here is layer 0, which makes them peers, and two peers holding one "+
			"place is one of them being in the wrong place — which of them a person sees is the "+
			"order the inventory was built in.",
			state, surface.ID, surface.CoveredFraction*100, surface.CoveredBy)
	}
	// The count, always. A run that reports nothing behind another in a window holding one surface
	// has asked a question that could not have failed, and it reads exactly like a run that asked a
	// real one — measured while writing this, the first state holds one surface and proves nothing.
	gate.t.Logf("%s: %d surfaces, %d standing, %d behind another", state, len(held), standing, behind)
}

func TestNoSurfaceStandsOverAnother(t *testing.T) {
	gate := newGate(t, surfaceCoverHome, surfaceCoverIdentifier)
	plugins := gate.installPlugins()
	gate.start()
	defer gate.quit()

	window := gate.openWorkspace()
	gate.consentAndEnable(window, plugins)
	built := gate.buildGateWindow(window)
	gate.refuseCover(window, "as built")

	// A second page beside the first. One surface can stand nowhere wrong; two is the smallest
	// window where the question exists at all.
	_, browserProgram := gate.programsForWindow(window)
	_, second := gate.split(window, built.right, "right", browserProgram)
	gate.activate(window, second, "cover/second")
	gate.refuseCover(window, "two pages side by side")

	// The region takes its width from the panes, so opening it moves every page. A page that kept
	// its old rectangle through that would land on its neighbour.
	gate.run("workspace.region.toggle", "window="+window, "region=left", "open=true")
	gate.run("ui.layout.wait-settled", "window="+window)
	gate.refuseCover(window, "with the sidebar standing")

	// Back to one pane's page in front. The tab that leaves is parked, which is the core hiding it
	// — not there rather than behind something, and a reading that confused the two would call a
	// working window covered.
	gate.activate(window, built.browserTab, "cover/first")
	gate.refuseCover(window, "after switching back")

	// The card a person opens over the work. A DOM overlay is not a surface: the pages under it are
	// hidden by the core or they are not, and either way nothing native is standing on them.
	gate.run("plugin.manager", "window="+window, "open=true")
	gate.run("ui.layout.wait-settled", "window="+window)
	gate.refuseCover(window, "with the plugin manager open")
	gate.run("plugin.manager", "window="+window, "open=false")
	gate.run("ui.layout.wait-settled", "window="+window)
	gate.refuseCover(window, "with the manager closed again")
}
