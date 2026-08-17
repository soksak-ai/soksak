package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// The window every motion gate measures, stated once.
//
// A window with one pane in it answers questions about one pane. What is being measured here is what
// a person watches while the layout changes, and the layout that was named on 2026-08-17 is **a
// left column split into a terminal on top and a browser underneath, and a terminal filling the
// right**. Three panes, one of them holding a native surface, a column the region takes its width
// from and a column that only moves. One page rather than several is the harder case, not the
// easier one: whether it travels with its pane is the whole question, and with one page there is
// nothing else on the screen to mistake it for.
//
// Built through the same commands a person's clicks go through, so the arrangement a gate measures
// is one this build can actually be put into.

// gateWindow is the arrangement above, named by what each pane holds.
type gateWindow struct {
	terminal string // the pane top left
	browser  string // the pane under it — the one with a page in it
	right    string // the pane filling the right
	// The tabs in each, for focus work — a region stands for the plugin of the focused view.
	terminalTab string
	browserTab  string
	rightTab    string
}

// buildGateWindow arranges the named window and answers what it holds.
//
// Declared rather than assembled. Building it by splitting one pane after another makes the result
// depend on which pane each split lands on and in what order: dividing downwards first and then
// splitting the top half to the right gives a right pane the height of that half, which is a
// different window from the one named — measured 2026-08-17, and nothing read the shape that came
// out. `layout.apply` states the whole space at once and builds a fresh one, so the same call from
// any starting point makes the same window. Every id comes from the answer that made it.
func (gate *restoreGate) buildGateWindow(window string) gateWindow {
	gate.t.Helper()
	terminalProgram, browserProgram := gate.programsForWindow(window)

	// The first pane is the space's own; each later one splits it on the side it names. So: a
	// terminal, a terminal taking the right of the window, and a browser taking the bottom of what
	// is left — a left column of terminal over browser, and a terminal down the whole right.
	spaces := fmt.Sprintf(
		`[{"title":"named","panes":[{"program":%q},{"program":%q,"side":"right"},{"program":%q,"side":"bottom"}]}]`,
		terminalProgram, terminalProgram, browserProgram)
	var answer struct {
		Data struct {
			Spaces []struct {
				SpaceID string `json:"spaceId"`
				Panes   []struct {
					PaneID  string `json:"paneId"`
					Program string `json:"program"`
				} `json:"panes"`
			} `json:"spaces"`
			Skipped []struct {
				Program string `json:"program"`
				Reason  string `json:"reason"`
			} `json:"skipped"`
		} `json:"data"`
	}
	out := gate.run("layout.apply", "window="+window, "spaces="+spaces)
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		gate.t.Fatalf("layout.apply: %v\n%s", err, out)
	}
	if len(answer.Data.Skipped) > 0 {
		gate.t.Fatalf("the named window asked for programs this build does not have: %v", answer.Data.Skipped)
	}
	if len(answer.Data.Spaces) != 1 || len(answer.Data.Spaces[0].Panes) != 3 {
		gate.t.Fatalf("the named window was asked for as three panes and came back as %s", out)
	}
	space := answer.Data.Spaces[0]
	built := gateWindow{
		terminal: space.Panes[0].PaneID,
		right:    space.Panes[1].PaneID,
		browser:  space.Panes[2].PaneID,
	}
	gate.run("space.activate", "window="+window, "space="+space.SpaceID)

	// The arrangement is not built until the panes hold what they were asked to hold. A gate that
	// starts measuring here would otherwise be measuring the tail of its own setup.
	gate.until(10*time.Second, func() bool {
		return len(gate.panes(window)) >= 3 && gate.aVisibleSurface(window) != ""
	}, "the three panes to stand with a surface on screen")

	built.terminalTab = gate.tabInPane(window, built.terminal)
	built.browserTab = gate.tabInPane(window, built.browser)
	built.rightTab = gate.tabInPane(window, built.right)
	gate.assertNamedWindow(window, built)
	// The shape it actually made, written down. A gate that states the window it measured lets its
	// reader check the window rather than the claim.
	gate.t.Logf("the named window:%s", gate.paneShape(window, built))
	return built
}

// programsForWindow names the terminal program and the browser program this build offers. Refused
// rather than guessed: a gate that silently arranges two terminals measures a window with one
// surface in it and reports it as the named one.
func (gate *restoreGate) programsForWindow(window string) (terminal string, browser string) {
	gate.t.Helper()
	for _, program := range gate.programs(window) {
		switch {
		case strings.Contains(program, "browser") && browser == "":
			browser = program
		case strings.Contains(program, "terminal") && terminal == "":
			terminal = program
		}
	}
	if terminal == "" || browser == "" {
		gate.t.Fatalf("this build offers no terminal or no browser program: %v", gate.programs(window))
	}
	return terminal, browser
}

// tabInPane names the tab a pane is showing.
func (gate *restoreGate) tabInPane(window string, pane string) string {
	gate.t.Helper()
	for _, held := range gate.panes(window) {
		if held.ID != pane {
			continue
		}
		if held.ActiveTabID != "" {
			return held.ActiveTabID
		}
		if len(held.Tabs) > 0 {
			return held.Tabs[0].ID
		}
	}
	gate.t.Fatalf("pane %s holds no tab", pane)
	return ""
}

// assertNamedWindow reads the rectangles the window actually made and refuses anything but the
// window that was named: a left column divided into a terminal above a browser, and one pane filling
// the right for the whole height.
//
// A gate that arranges a window and never reads the arrangement measures whatever it happened to
// build. This one built the wrong shape for a day without a word.
func (gate *restoreGate) assertNamedWindow(window string, built gateWindow) {
	gate.t.Helper()
	boxes := gate.paneBoxes(window)
	terminal, browser, right := boxes[built.terminal], boxes[built.browser], boxes[built.right]
	for name, box := range map[string]paneBox{
		"terminal (top left)": terminal, "browser (bottom left)": browser, "right": right,
	} {
		if box.W <= 0 || box.H <= 0 {
			gate.t.Fatalf("the %s pane has no rectangle: %s", name, gate.paneShape(window, built))
		}
	}

	// One column on the left, one on the right, and the left one divided.
	if !about(terminal.X, browser.X) || !about(terminal.W, browser.W) {
		gate.t.Fatalf("the terminal and the browser are not one column: %s", gate.paneShape(window, built))
	}
	if terminal.Y+terminal.H > browser.Y+2 {
		gate.t.Fatalf("the browser is not under the terminal: %s", gate.paneShape(window, built))
	}
	if right.X < terminal.X+terminal.W {
		gate.t.Fatalf("the right pane is not to the right of that column: %s", gate.paneShape(window, built))
	}
	// The whole height, which is what "the right is a terminal" means: as tall as the two together.
	column := (browser.Y + browser.H) - terminal.Y
	if right.H < column-4 {
		gate.t.Fatalf("the right pane is %0.f tall against a left column of %0.f, so it fills half the "+
			"window rather than the side of it: %s", right.H, column, gate.paneShape(window, built))
	}
}

// paneBox is one pane's rectangle, as the window draws it.
type paneBox struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

// paneBoxes is every pane's rectangle by pane id, read from the same pass the surfaces are read in.
func (gate *restoreGate) paneBoxes(window string) map[string]paneBox {
	gate.t.Helper()
	var answer struct {
		Data struct {
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
	boxes := make(map[string]paneBox, len(answer.Data.Panes))
	for _, pane := range answer.Data.Panes {
		boxes[pane.Pane] = pane.paneBox
	}
	return boxes
}

// paneShape is the window as it stands, named pane by pane — what to read when the shape is refused.
func (gate *restoreGate) paneShape(window string, built gateWindow) string {
	gate.t.Helper()
	boxes := gate.paneBoxes(window)
	lines := []string{}
	for _, named := range []struct {
		what string
		pane string
	}{{"terminal (top left)", built.terminal}, {"browser (bottom left)", built.browser}, {"right", built.right}} {
		box := boxes[named.pane]
		lines = append(lines, fmt.Sprintf("\n  %-22s %s x=%.0f y=%.0f w=%.0f h=%.0f",
			named.what, named.pane, box.X, box.Y, box.W, box.H))
	}
	return strings.Join(lines, "")
}

// about is two rounded readings of the same edge.
func about(a float64, b float64) bool { return a-b < 2 && b-a < 2 }

// paneOfTab names the pane a tab is in now.
func (gate *restoreGate) paneOfTab(window string, tab string) string {
	gate.t.Helper()
	for _, pane := range gate.panes(window) {
		for _, held := range pane.Tabs {
			if held.ID == tab {
				return pane.ID
			}
		}
	}
	gate.t.Fatalf("no pane holds %s", tab)
	return ""
}

// pluginOfTab names the plugin whose view a tab holds.
func (gate *restoreGate) pluginOfTab(window string, tab string) string {
	gate.t.Helper()
	for _, pane := range gate.panes(window) {
		for _, held := range pane.Tabs {
			if held.ID == tab {
				return held.Plugin
			}
		}
	}
	gate.t.Fatalf("no pane holds %s", tab)
	return ""
}

// split puts a new pane beside one, running a program in it, and answers both ids.
func (gate *restoreGate) split(window string, pane string, side string, program string) (string, string) {
	gate.t.Helper()
	var answer struct {
		Data struct {
			PaneID string `json:"paneId"`
			TabID  string `json:"tabId"`
		} `json:"data"`
	}
	out := gate.run("pane.split", "window="+window, "pane="+pane, "side="+side, "program="+program)
	if err := json.Unmarshal([]byte(out), &answer); err != nil || answer.Data.PaneID == "" {
		gate.t.Fatalf("pane.split %s of %s named no pane: %v\n%s", side, pane, err, out)
	}
	return answer.Data.PaneID, answer.Data.TabID
}
