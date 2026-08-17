package main

import (
	"encoding/json"
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

// buildGateWindow arranges the named window and answers what it holds. Every id comes from the
// answer that made it, never from a list written here.
func (gate *restoreGate) buildGateWindow(window string) gateWindow {
	gate.t.Helper()
	terminalProgram, browserProgram := gate.programsForWindow(window)

	// The first pane is whatever the window opened with; it becomes the terminal, top left.
	first := gate.panes(window)
	if len(first) == 0 {
		gate.t.Fatal("the window has no pane, so nothing can be arranged in it")
	}
	built := gateWindow{terminal: first[0].ID}
	built.terminalTab = gate.open(window, terminalProgram)

	// The browser under the terminal, then the terminal filling the right of the column.
	built.browser, built.browserTab = gate.split(window, built.terminal, "bottom", browserProgram)
	built.right, built.rightTab = gate.split(window, built.terminal, "right", terminalProgram)

	// The arrangement is not built until the panes hold what they were asked to hold. A gate that
	// starts measuring here would otherwise be measuring the tail of its own setup.
	gate.until(10*time.Second, func() bool {
		return len(gate.panes(window)) >= 3 && gate.aVisibleSurface(window) != ""
	}, "the three panes to stand with a surface on screen")
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
