package main

import (
	"encoding/json"
	"regexp"
	"testing"
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

		if drawn := gate.drawnIn(window, region); !contains(drawn, section) {
			t.Errorf("%s is linked to the %s region and is not drawn there.\n"+
				"%s holds %v. The link is a fact nobody can see.",
				section, region, region, drawn)
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
