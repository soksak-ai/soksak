package main

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// What the window must hold after each click, written down before anything is measured about it.
//
// Everything else in this repository about layout — how long a motion takes, whether a page travels
// with its pane, whether a frame blinks — is a question about a window that is already the right
// window. None of it was asked first. On 2026-08-17 a person looked at the window this gate's own
// scenarios had left and said the sidebar was gone, and nothing here could answer whether that was
// the arrangement or the loss of it: the readings measured seams and lags in a window whose shape
// nobody had stated.
//
// So the shape is stated. The window is a left column split into a terminal above a browser, and a
// terminal filling the right. One set is linked to the browser's plugin in the **left** region and
// another to the terminals' plugin in the **right**, and both regions are open. From that, what each
// click must leave on the screen:
//
//	click                 left region     right region    the panes
//	terminal (top left)   not standing    standing        begin at the inset, end before the right one
//	browser (bottom)      standing        not standing    begin where the left region ends
//	terminal (right)      not standing    standing        begin at the inset, end before the right one
//
// A region stands for the plugin of the focused view and for no other (`individual`), so which
// region is on the screen is decided by what was clicked — that is the arrangement, and a window
// that answers otherwise is what this gate is for. Everything else asked about a layout — how long a
// motion takes, whether a page travels with its pane, whether a frame blinks — is a question about a
// window that is already this one.
const arrangementGateHome = "<local-evidence>/soksak-arrangement-gate"

const arrangementGateIdentifier = "com.soksak.arrangementgate"

type arrangementGate = restoreGate

// paneInset is the gap between the window's edge and the panes, and between a region and the panes
// beside it. Read from the settled window rather than named here — a theme sets it.
type arrangement struct {
	regionEnds float64
	panesStart float64
	panes      map[string]paneBox
}

func TestEachClickLeavesTheArrangementItIsMeantTo(t *testing.T) {
	gate := newGate(t, arrangementGateHome, arrangementGateIdentifier)
	plugins := gate.installPlugins()
	gate.start()
	defer gate.quit()

	window := gate.openWorkspace()
	gate.consentAndEnable(window, plugins)
	built := gate.buildGateWindow(window)

	set := gate.createSet(window, "arrangement")
	sections := gate.availableSections(window)["left"]
	if len(sections) == 0 {
		t.Fatal("no section stands on the left, so the region could never stand")
	}
	gate.run("sections.arrange", "window="+window, "set="+set, "sections="+jsonList(sections[0]))
	gate.run("sections.link", "window="+window,
		"plugin="+gate.pluginOfTab(window, built.browserTab), "set="+set, "region=left")
	// And the other side, for the plugin the terminals are. Each region holds its own set, so a
	// window that could only ever show one of them would pass a gate about the other by never
	// being asked.
	right := gate.createSet(window, "arrangement-right")
	rightSections := gate.availableSections(window)["right"]
	if len(rightSections) == 0 {
		t.Fatal("no section stands on the right, so that region could never stand")
	}
	gate.run("sections.arrange", "window="+window, "set="+right, "sections="+jsonList(rightSections[0]))
	gate.run("sections.link", "window="+window,
		"plugin="+gate.pluginOfTab(window, built.terminalTab), "set="+right, "region=right")
	gate.run("workspace.region.toggle", "window="+window, "region=left", "open=true")
	gate.run("workspace.region.toggle", "window="+window, "region=right", "open=true")

	// The inset is measured from the window rather than assumed: it is what stands between the edge
	// and the panes when no region does.
	gate.run("tab.activate", "window="+window, "tab="+built.terminalTab)
	gate.settle(window)
	inset := gate.arrangementNow(window).panesStart
	if inset <= 0 || inset > 40 {
		t.Fatalf("the panes begin %0.f from the window's edge, which is not an inset", inset)
	}

	for _, click := range []struct {
		what     string
		tab      string
		stands   bool
		andRight bool
	}{
		{"terminal (top left)", built.terminalTab, false, true},
		{"browser (bottom)", built.browserTab, true, false},
		{"terminal (right)", built.rightTab, false, true},
		// Twice round, because a click that only works from one starting point works from none of
		// the others a person will click from.
		{"browser (bottom), again", built.browserTab, true, false},
		{"terminal (right), again", built.rightTab, false, true},
		{"browser (bottom), from the right", built.browserTab, true, false},
	} {
		gate.run("tab.activate", "window="+window, "tab="+click.tab)
		gate.settle(window)
		now := gate.arrangementNow(window)

		if click.stands {
			if now.regionEnds <= inset {
				t.Errorf("clicking %s: the region stands for this view's plugin and it is not on the "+
					"screen.\n%s\nThe set is linked and the region is open, so what is missing is the "+
					"region itself.", click.what, gate.arrangementLines(window, built))
				continue
			}
			if gap := now.panesStart - now.regionEnds; gap < 0 || gap > inset+1 {
				t.Errorf("clicking %s: the region ends at %.0f and the panes begin at %.0f, %.0f apart "+
					"where the window's own inset is %.0f.\n%s",
					click.what, now.regionEnds, now.panesStart, gap, inset,
					gate.arrangementLines(window, built))
			}
		} else if now.regionEnds > inset {
			t.Errorf("clicking %s: no set stands for this view's plugin and the region is on the "+
				"screen, ending at %.0f.\n%s\nA region with nothing standing in it takes width for "+
				"nothing.", click.what, now.regionEnds, gate.arrangementLines(window, built))
			continue
		} else if now.panesStart > inset+1 {
			t.Errorf("clicking %s: no region stands and the panes begin at %.0f rather than at the "+
				"window's inset of %.0f.\n%s\nThe width the region gave up belongs to the panes.",
				click.what, now.panesStart, inset, gate.arrangementLines(window, built))
		}

		// The other side, by the same definition.
		if right := gate.rightRegionWidth(window); click.andRight != (right > 0) {
			held := "is on the screen"
			if right <= 0 {
				held = "is not on the screen"
			}
			t.Errorf("clicking %s: the right region %s, and the set linked to this view's plugin "+
				"says otherwise.\n%s", click.what, held, gate.arrangementLines(window, built))
		}

		// The three panes keep the shape they were built in, whatever the regions do.
		gate.assertNamedWindow(window, built)

		// One picture per click, kept. A capture nobody looks at is a ceremony; this one is named
		// after the click that produced it and is kept beside the numbers, so the arrangement a person
		// sees and the arrangement this gate judged can be put side by side.
		shot := filepath.Join("evidence", "arrangement",
			strings.NewReplacer(" ", "-", "(", "", ")", "", ",", "").Replace(click.what)+".png")
		gate.run("window.snapshot", "window="+window, "path="+shot)
	}
}

// settle waits until the window has stopped changing shape, so what is read is what a person is
// left looking at rather than a frame of the way there.
func (gate *arrangementGate) settle(window string) {
	gate.t.Helper()
	last := arrangement{}
	same := 0
	gate.until(5*time.Second, func() bool {
		now := gate.arrangementNow(window)
		if now.regionEnds == last.regionEnds && now.panesStart == last.panesStart {
			same++
		} else {
			same = 0
		}
		last = now
		return same >= 2
	}, "the window to settle")
}

// arrangementNow is where the region ends and where the panes begin, from one reading.
func (gate *arrangementGate) arrangementNow(window string) arrangement {
	gate.t.Helper()
	var answer struct {
		Data struct {
			Regions []struct {
				Region string  `json:"region"`
				X      float64 `json:"x"`
				W      float64 `json:"w"`
			} `json:"regions"`
			Panes []struct {
				Pane string `json:"pane"`
				paneBox
			} `json:"panes"`
		} `json:"data"`
	}
	out := gate.run("layout.alignment", "window="+window)
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		gate.t.Fatalf("layout.alignment: %v\n%s", err, out)
	}
	now := arrangement{panesStart: -1, panes: map[string]paneBox{}}
	// A region with no width is not on the screen, whatever x it is parked at. A collapsed rail
	// stays at the station it last held, and reading its right edge as "where the region ends" makes
	// an absent region look like a wide one — which is how this gate first accused the window of
	// keeping a sidebar it had already given up.
	for _, region := range answer.Data.Regions {
		if region.Region == "left" && region.W > 0 && region.X+region.W > now.regionEnds {
			now.regionEnds = region.X + region.W
		}
	}
	for _, pane := range answer.Data.Panes {
		now.panes[pane.Pane] = pane.paneBox
		if pane.W <= 0 {
			continue
		}
		if now.panesStart < 0 || pane.X < now.panesStart {
			now.panesStart = pane.X
		}
	}
	if now.panesStart < 0 {
		now.panesStart = 0
	}
	return now
}

// rightRegionWidth is how much of the window the right region holds. Zero is not standing.
func (gate *arrangementGate) rightRegionWidth(window string) float64 {
	gate.t.Helper()
	var answer struct {
		Data struct {
			Regions []struct {
				Region string  `json:"region"`
				W      float64 `json:"w"`
			} `json:"regions"`
		} `json:"data"`
	}
	out := gate.run("layout.alignment", "window="+window)
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		gate.t.Fatalf("layout.alignment: %v\n%s", err, out)
	}
	widest := 0.0
	for _, region := range answer.Data.Regions {
		if region.Region == "right" && region.W > widest {
			widest = region.W
		}
	}
	return widest
}

// arrangementLines is the window as it stands — the region and every pane, named.
func (gate *arrangementGate) arrangementLines(window string, built gateWindow) string {
	gate.t.Helper()
	now := gate.arrangementNow(window)
	lines := []string{
		fmt.Sprintf("  region ends at %.0f, panes begin at %.0f", now.regionEnds, now.panesStart),
		// Which plugin the window is reading the standing for, and what stands. A region on the
		// screen with nothing in it and a region standing for the wrong plugin are two different
		// defects that look the same from the outside.
		"  focused view: " + gate.run("state.tree", "window="+window),
		"  sections: " + gate.run("sections.list", "window="+window),
	}
	for _, named := range []struct {
		what string
		pane string
	}{{"terminal (top left)", built.terminal}, {"browser (bottom)", built.browser}, {"right", built.right}} {
		box := now.panes[named.pane]
		lines = append(lines, fmt.Sprintf("  %-20s %s x=%.0f y=%.0f w=%.0f h=%.0f",
			named.what, named.pane, box.X, box.Y, box.W, box.H))
	}
	return strings.Join(lines, "\n")
}
