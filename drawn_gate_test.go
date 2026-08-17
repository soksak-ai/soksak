package main

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"testing"
	"time"
)

// The link and the screen agree.
//
// A sidebar composed of sections stands where its link names it. Every test of that rule read state
// or a component in isolation, and none of them read the window. So the rule held in three places
// and failed on screen more than once — the icon a tab drew disagreed with the command that reported
// it, and the right region answered OK to a link it never drew. Both were found by eye.
//
// This puts the question to a running build and reads the exposed DOM, which addresses a view by the
// region it is drawn in. A picture is not a verdict (EVIDENCE E1); an address is.
const drawnGateHome = "<local-evidence>/soksak-drawn-gate"

const drawnGateIdentifier = "com.soksak.drawngate"

type drawnGate = restoreGate

func TestWhatTheLinkSaysIsWhatIsDrawn(t *testing.T) {
	gate := newGate(t, drawnGateHome, drawnGateIdentifier)
	plugins := gate.installPlugins()
	gate.start()
	defer gate.quit()

	window := gate.openWorkspace()
	gate.consentAndEnable(window, plugins)
	for _, program := range gate.programs(window) {
		gate.open(window, program)
	}

	// A closed region draws nothing whatever the link names, and the link is what this gate measures.
	// Both are opened by the same command, which is what a person's click goes through.
	for _, region := range []string{"left", "right"} {
		gate.run("workspace.region.toggle", "window="+window, "region="+region, "open=true")
	}

	// The sections to compose from are what this build offers, not a list written here that goes
	// stale the day a plugin changes where it stands.
	available := gate.availableSections(window)
	// The link is given to the plugin of the focused view, which is what `individual` reads — not to
	// the plugin that provides the section. A section provider need not have a pane of its own.
	plugin := gate.aPluginWithAPane(window)
	tested := 0
	for _, region := range []string{"left", "right"} {
		sections := available[region]
		if len(sections) == 0 {
			continue
		}
		tested++
		section := sections[0]
		set := gate.createSet(window, "gate-"+region)
		gate.run("sections.arrange", "window="+window, "set="+set, "sections="+jsonList(section))
		gate.run("sections.link", "window="+window, "plugin="+plugin, "set="+set, "region="+region)
		gate.focusPluginPane(window, plugin)

		// The region is drawn after a layout commit, so this waits for it rather than reading the
		// frame the link happened to land in.
		gate.until(5*time.Second, func() bool { return contains(gate.drawnIn(window, region), section) },
			"the "+region+" region to draw "+section)
		if drawn := gate.drawnIn(window, region); !contains(drawn, section) {
			t.Errorf("%s is linked to the %s region and is not drawn there.\n"+
				"%s holds %v, and every node the window exposes there is:\n%s\n"+
				"The link is a fact nobody can see.",
				section, region, region, drawn, gate.nodesIn(window, region)+
					"\nsections: "+gate.run("sections.list", "window="+window)+
					"\nhealth: "+gate.run("state.health", "window="+window))
		}
		for _, other := range []string{"left", "right"} {
			if other == region {
				continue
			}
			if drawn := gate.drawnIn(window, other); contains(drawn, section) {
				t.Errorf("%s is linked to the %s region and is drawn in the %s one as well: %v",
					section, region, other, drawn)
			}
		}

		gate.run("sections.link", "window="+window, "plugin="+plugin)
		if drawn := gate.drawnIn(window, region); contains(drawn, section) {
			t.Errorf("the link to %s was removed and %s is still drawn in the %s region: %v\n"+
				"Not connected is not present.", plugin, section, region, drawn)
		}
	}
	// One region is not the rule. A section that stands in one place only is dropped by the placement
	// filter for its own reason, and a host that never reads the link's region passes anyway —
	// measured 2026-08-17, a planted host that ignores the region survived this gate until a section
	// stood in both.
	// A modal covers the window, and a native surface is composited above the document — no z-index
	// orders it under the card. The plugin manager opened with two browser pages drawn over it,
	// measured 2026-08-17. The DOM behind a modal keeps its boxes, which is correct; what must go is
	// the surface, so this reads the composition rather than the document.
	gate.showASurface(window)
	gate.run("plugin.manager", "window="+window, "open=true")
	if during := gate.visibleSurfaces(window); len(during) > 0 {
		t.Errorf("the plugin manager is open and %d native surfaces are still visible: %v\n"+
			"A surface above the card is one a person cannot read or click past.", len(during), during)
	}
	gate.run("plugin.manager", "window="+window, "open=false")
	if after := gate.visibleSurfaces(window); len(after) == 0 {
		t.Errorf("the manager closed and no surface came back.\ncomposition: %s",
			gate.run("surface.composition", "window="+window))
	}

	// A link that changes the layout moves panes, and a motion that never plays is a jump.
	//
	// Measured 2026-08-17: `ui.motion` held 64 journeys and every one ended `cancel` 10–13ms after
	// it started, with nothing running. The rect tracker was flushed on every render, and a flush
	// cancels the running interpolation before measuring — after which the element is already at
	// its destination, so nothing new starts. A cancelled journey is not a fault by itself: a second
	// command mid-motion retargets the first. A window where none has ever finished has no motion.
	if finished, cancelled := gate.journeys(window); finished == 0 && cancelled > 0 {
		t.Errorf("%d layout journeys ran and not one finished — every pane jumped to its place.\n"+
			"The rect tracker flushes once per layout commit; a flush per render ends them all.",
			cancelled)
	}

	if tested < 2 {
		t.Fatalf("sections stand in %d of 2 regions, so the region rule was not measured.\n"+
			"available: %v\nA section placed in both is what separates the region from the placement.",
			tested, available)
	}
}

// availableSections is what `sections.list` offers per region — the same list the host filters by.
func (gate *drawnGate) availableSections(window string) map[string][]string {
	gate.t.Helper()
	var answer struct {
		Data struct {
			Available map[string][]string `json:"available"`
		} `json:"data"`
	}
	out := gate.run("sections.list", "window="+window)
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		gate.t.Fatalf("sections.list: %v\n%s", err, out)
	}
	return answer.Data.Available
}

func (gate *drawnGate) createSet(window string, title string) string {
	gate.t.Helper()
	var answer struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	out := gate.run("sections.create", "window="+window, "title="+title)
	if err := json.Unmarshal([]byte(out), &answer); err != nil || answer.Data.ID == "" {
		gate.t.Fatalf("sections.create: %v\n%s", err, out)
	}
	return answer.Data.ID
}

// aPluginWithAPane names a plugin this window can focus. The focused view is where the link is read.
func (gate *drawnGate) aPluginWithAPane(window string) string {
	gate.t.Helper()
	for _, pane := range gate.panes(window) {
		for _, tab := range pane.Tabs {
			if tab.Plugin != "" {
				return tab.Plugin
			}
		}
	}
	gate.t.Fatal("no pane holds a plugin tab, so nothing can be focused and the link reads nothing")
	return ""
}

// focusPluginPane makes the pane whose active tab is this plugin's the focused one — what
// `individual` reads.
func (gate *drawnGate) focusPluginPane(window string, plugin string) {
	gate.t.Helper()
	for _, pane := range gate.panes(window) {
		for _, tab := range pane.Tabs {
			if tab.Plugin != plugin {
				continue
			}
			gate.run("pane.activate", "window="+window, "pane="+pane.ID)
			gate.run("tab.activate", "window="+window, "tab="+tab.ID)
			return
		}
	}
	gate.t.Fatalf("no pane holds a tab of %s, so nothing can focus it", plugin)
}

type gatePane struct {
	ID          string `json:"id"`
	ActiveTabID string `json:"activeTabId"`
	Tabs        []struct {
		ID     string `json:"id"`
		Plugin string `json:"plugin"`
	} `json:"tabs"`
}

func (gate *drawnGate) panes(window string) []gatePane {
	gate.t.Helper()
	var answer struct {
		Data struct {
			Panes []gatePane `json:"panes"`
		} `json:"data"`
	}
	out := gate.run("pane.list", "window="+window)
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		gate.t.Fatalf("pane.list: %v\n%s", err, out)
	}
	return answer.Data.Panes
}

var drawnAddress = regexp.MustCompile(`^win/[^/]+/([^/]+)/view/([^/]+)/`)

// drawnIn is the set of views the window addresses inside a region — read from what is exposed,
// which is what is on screen, rather than from the state that decided it.
func (gate *drawnGate) drawnIn(window string, region string) []string {
	gate.t.Helper()
	var answer struct {
		Data struct {
			Nodes []struct {
				Address string `json:"address"`
				Rect    struct {
					W float64 `json:"w"`
					H float64 `json:"h"`
				} `json:"rect"`
			} `json:"nodes"`
		} `json:"data"`
	}
	out := gate.run("ui.snapshot.dom", "window="+window)
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		gate.t.Fatalf("ui.snapshot.dom: %v\n%s", err, out)
	}
	seen := map[string]bool{}
	var found []string
	for _, node := range answer.Data.Nodes {
		m := drawnAddress.FindStringSubmatch(node.Address)
		// A view kept alive behind another still has an address; it has no box. Drawn is what a
		// person can see, so the rectangle is the test.
		if m == nil || m[1] != region || seen[m[2]] || node.Rect.W <= 0 || node.Rect.H <= 0 {
			continue
		}
		seen[m[2]] = true
		found = append(found, m[2])
	}
	return found
}

// focusASurface brings a pane forward until the compositor has one on screen. A surface that is not

// surfaceAppears waits rather than reads once: a page is fetched and the surface is declared after,

// showASurface brings a pane forward until the compositor has one on screen. A surface that is not
// the tab its pane shows is already hidden, and hiding it again proves nothing about an overlay.
func (gate *drawnGate) showASurface(window string) {
	gate.t.Helper()
	for _, pane := range gate.panes(window) {
		for _, tab := range pane.Tabs {
			gate.run("pane.activate", "window="+window, "pane="+pane.ID)
			gate.run("tab.activate", "window="+window, "tab="+tab.ID)
			for attempt := 0; attempt < 20; attempt++ {
				if len(gate.visibleSurfaces(window)) > 0 {
					return
				}
				time.Sleep(100 * time.Millisecond)
			}
		}
	}
	gate.t.Fatalf("no pane could be brought to show a native surface.\npanes: %s\ncomposition: %s",
		gate.run("pane.list", "window="+window), gate.run("surface.composition", "window="+window))
}

// visibleSurfaces is what the compositor has on screen — declared and applied both true. The
// document is not the reading: a native surface is composited above it.
func (gate *drawnGate) visibleSurfaces(window string) []string {
	gate.t.Helper()
	var answer struct {
		Data struct {
			Surfaces []struct {
				ID              string `json:"id"`
				DeclaredVisible bool   `json:"declaredVisible"`
				AppliedVisible  bool   `json:"appliedVisible"`
			} `json:"surfaces"`
		} `json:"data"`
	}
	out := gate.run("surface.composition", "window="+window)
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		gate.t.Fatalf("surface.composition: %v\n%s", err, out)
	}
	var found []string
	for _, surface := range answer.Data.Surfaces {
		if surface.DeclaredVisible && surface.AppliedVisible {
			found = append(found, surface.ID)
		}
	}
	return found
}

// nodesIn is every node the window exposes inside a region, with its box. A gate that reports
// "not drawn" without them sends its reader back to the window to find out what was there.
func (gate *drawnGate) nodesIn(window string, region string) string {
	gate.t.Helper()
	var answer struct {
		Data struct {
			Nodes []struct {
				Address string `json:"address"`
				Rect    struct {
					W float64 `json:"w"`
					H float64 `json:"h"`
				} `json:"rect"`
			} `json:"nodes"`
		} `json:"data"`
	}
	out := gate.run("ui.snapshot.dom", "window="+window)
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		gate.t.Fatalf("ui.snapshot.dom: %v\n%s", err, out)
	}
	var lines []string
	for _, node := range answer.Data.Nodes {
		m := drawnAddress.FindStringSubmatch(node.Address)
		if m == nil || m[1] != region {
			continue
		}
		lines = append(lines, fmt.Sprintf("  %s  %gx%g", node.Address, node.Rect.W, node.Rect.H))
	}
	if len(lines) == 0 {
		return "  (the window exposes no node in that region at all)"
	}
	return strings.Join(lines, "\n")
}

// journeys counts how the window's layout motions ended.
func (gate *drawnGate) journeys(window string) (finished int, cancelled int) {
	gate.t.Helper()
	var answer struct {
		Data struct {
			Journeys []struct {
				End string `json:"end"`
			} `json:"journeys"`
		} `json:"data"`
	}
	out := gate.run("ui.motion", "window="+window)
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		gate.t.Fatalf("ui.motion: %v\n%s", err, out)
	}
	for _, journey := range answer.Data.Journeys {
		switch journey.End {
		case "finish":
			finished++
		case "cancel":
			cancelled++
		}
	}
	return finished, cancelled
}

func contains(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

func jsonList(values ...string) string {
	body, err := json.Marshal(values)
	if err != nil {
		panic(err)
	}
	return string(body)
}
