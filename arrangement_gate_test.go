package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
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
// So the shape is stated, in the words it was given in: a left column split into a terminal above a
// browser, and a terminal filling the right. Three panes, and the clicks between them.
//
// Where a sidebar goes was not part of that and is not asserted here. What is asserted is the rule
// the product already has: a set is linked to a plugin in a region, and the section standing is the
// one linked to the focused view's plugin. This window links both sets in the left region, because
// a link must name one, and then:
//
//	click                 the sidebar             the panes
//	terminal (top left)   the terminals' section  begin where the sidebar ends
//	browser (bottom)      the browser's section   begin where the sidebar ends
//	terminal (right)      the terminals' section  begin where the sidebar ends
//
// An earlier version of this file required a second region on the right. Nobody asked for it; it was
// added here, and the window was then changed to satisfy it. A requirement invented in a gate costs
// what a defect costs and is harder to see, because it passes.
//
// Whose section, and not only how wide. A region stands for the plugin of the focused view and for no
// other (`individual`), and the set it stands is the one that plugin is linked to — measured
// 2026-08-17, a browser was focused, a region stood beside it, and the file tree was in it, and this
// gate passed because it asked the region for its width, and a width does not name whose section
// it is holding. That is the reading it was missing and the reason it is here.
const arrangementGateHome = "<local-evidence>/soksak-arrangement-gate"

const arrangementGateIdentifier = "com.soksak.arrangementgate"

type arrangementGate = restoreGate

// The plugins whose sections the two sets are made of. A section is a plugin (A2a) and no plugin
// declares what it stands beside, so which set a person gives the browser is a person's choice —
// what this gate fixes is that the choice is the thing on the screen.
const (
	arrangementBrowserSectionPlugin  = "soksak-plugin-browser-native"
	arrangementTerminalSectionPlugin = "soksak-plugin-file-tree"
)

// paneInset is the gap between the window's edge and the panes, and between a region and the panes
// beside it. Read from the settled window rather than named here — a theme sets it.
type arrangement struct {
	regionEnds float64
	panesStart float64
	// bands is the vertical band each region occupies, and panesBand the one the panes do. A
	// region stands beside the panes, so those two are the same band — and nothing here ever
	// asked. Measured 2026-08-17 from this gate's own picture: the right region began at the
	// space-tab row while the panes began 75 points below it, and every reading passed.
	// starts is where each region begins, and panesEnd where the panes stop. The left region
	// ends before the panes begin and the right one begins after they end — a region that
	// overlaps them is drawn over the work rather than beside it.
	starts    map[string]float64
	panesEnd  float64
	bands     map[string]band
	panesBand band
	panes     map[string]paneBox
	// sections is what is on the screen in each region, keyed <pluginId>.<viewId>.
	sections map[string][]string
}

func TestEachClickLeavesTheArrangementItIsMeantTo(t *testing.T) {
	gate := newGate(t, arrangementGateHome, arrangementGateIdentifier)
	plugins := gate.installPlugins()
	gate.start()
	defer gate.quit()

	window := gate.openWorkspace()
	gate.consentAndEnable(window, plugins)
	built := gate.buildGateWindow(window)

	// Two sets, both in the sidebar on the left: one holding the browser's own section, one holding
	// the terminals'. Two sets of the same section would answer every question about which one
	// stands with the same words.
	browserSection := gate.sectionOf(window, "left", arrangementBrowserSectionPlugin)
	browserSet := gate.createSet(window, "arrangement-browser")
	gate.run("sections.arrange", "window="+window, "set="+browserSet,
		"sections="+jsonList(browserSection))
	gate.run("sections.link", "window="+window,
		"plugin="+gate.pluginOfTab(window, built.browserTab), "set="+browserSet, "region=left")
	terminalSection := gate.sectionOf(window, "left", arrangementTerminalSectionPlugin)
	terminalSet := gate.createSet(window, "arrangement-terminal")
	gate.run("sections.arrange", "window="+window, "set="+terminalSet,
		"sections="+jsonList(terminalSection))
	gate.run("sections.link", "window="+window,
		"plugin="+gate.pluginOfTab(window, built.terminalTab), "set="+terminalSet, "region=left")
	gate.run("workspace.region.toggle", "window="+window, "region=left", "open=true")

	// The inset is measured from the window rather than assumed, and from a gap the sidebar is not
	// in: with the right pane focused the sidebar stands beside it, and what is left between the
	// window's edge and the first pane is the window's own inset. Reading it from the gap in front
	// of the sidebar made the measurement depend on the thing being measured — it went to zero the
	// day the sidebar was moved against the view it serves.
	gate.run("tab.activate", "window="+window, "tab="+built.rightTab)
	gate.settle(window)
	inset := gate.arrangementNow(window).panesStart
	if inset <= 0 || inset > 40 {
		t.Fatalf("the panes begin %0.f from the window's edge, which is not an inset", inset)
	}

	// Every way a person can get from one pane to another: three starting points times three
	// clicks, the click's own included. What the sidebar holds depends on what was clicked and on
	// nothing else, so asking it from every starting point is what proves that — a click that only
	// works from one place works from none of the others a person will click from.
	panes := []struct {
		what    string
		tab     string
		section string
	}{
		{"terminal (top left)", built.terminalTab, terminalSection},
		{"browser (bottom)", built.browserTab, browserSection},
		{"terminal (right)", built.rightTab, terminalSection},
	}
	slug := strings.NewReplacer(" ", "-", "(", "", ")", "", ",", "")
	for _, from := range panes {
		for _, click := range panes {
			// The starting point, settled, so what follows is one move and not the tail of another.
			gate.run("tab.activate", "window="+window, "tab="+from.tab)
			gate.settle(window)

			what := fmt.Sprintf("%s from %s", click.what, from.what)
			name := slug.Replace(click.what) + "-from-" + slug.Replace(from.what)
			// The whole move, not its end. The last frame of it is the still this case is kept by:
			// a second capture of the same window right after this one times out, and two capture
			// paths for one picture is one more than the picture needs.
			//
			// Absolute, because a relative path is resolved by the application against its own
			// working directory and the frames land somewhere this run cannot look — measured
			// 2026-08-17, nine recordings answered OK and left no frame anywhere here.
			dir := gate.evidencePath("arrangement", "moves", name)
			wait := gate.recording(window, dir, 6, 40)
			gate.run("tab.activate", "window="+window, "tab="+click.tab)
			said := wait()
			gate.settle(window)
			now := gate.arrangementNow(window)

			// The sidebar is on the screen. Every plugin in this window has a set linked in the
			// left region, so it stands whatever was clicked; what changes is what is in it.
			if now.regionEnds <= 0 {
				t.Errorf("clicking %s: the sidebar is not on the screen.\n%s\nThe set is linked and "+
					"the region is open, so what is missing is the sidebar itself.",
					what, gate.arrangementLines(window, built))
				continue
			}
			// It stands to the left of the pane that was clicked — stated on 2026-08-17 as the
			// thing about this window that does not change and was never asked to. This gate had
			// been measuring it against the window's left edge instead, and called the sidebar
			// wrong every time it stood beside the right-hand pane, which is where it stands.
			clicked := now.panes[gate.paneOfTab(window, click.tab)]
			if gap := clicked.X - now.regionEnds; gap < 0 || gap > inset+1 {
				t.Errorf("clicking %s: the sidebar ends at %.0f and the pane that was clicked begins "+
					"at %.0f, %.0f apart where this window's own inset is %.0f.\n%s\n"+
					"The sidebar stands to the left of the view that was clicked.",
					what, now.regionEnds, clicked.X, gap, inset,
					gate.arrangementLines(window, built))
			}

			// And nearer the view it serves than anything on its other side.
			//
			// The sidebar stands for one view, and how near it is to that view is what marks it as
			// its own. Measured 2026-08-17 in the window as it stood: the left column ended at 414,
			// the sidebar held 420..580, the pane it served began at 586 — six points on each side,
			// so nothing on the screen said which of the two it belonged to. Reported the same day
			// as things that should be grouped reading as foreign.
			behind := 0.0
			for _, box := range now.panes {
				if box.W <= 0 || box.X+box.W > now.starts["left"] {
					continue
				}
				if edge := now.starts["left"] - (box.X + box.W); behind == 0 || edge < behind {
					behind = edge
				}
			}
			if behind > 0 {
				if serves := clicked.X - now.regionEnds; serves >= behind {
					t.Errorf("clicking %s: the sidebar is %.0f from the view it serves and %.0f from "+
						"what is behind it, so nothing says which one it belongs to.\n%s\n"+
						"A sidebar stands nearer the view it stands for than anything on its other side.",
						what, serves, behind, gate.arrangementLines(window, built))
				}
			}

			// And whose section is in it. A sidebar holding another plugin's section is what a
			// person reported as "this is not the browser's sidebar", and it is a different window
			// from the one defined here even though every rectangle in it measures right.
			if got := now.sections["left"]; strings.Join(got, ",") != click.section {
				t.Errorf("clicking %s: the sidebar holds %s where the set linked to this view's "+
					"plugin is %s.\n%s\nA sidebar's width does not name whose section is in it.",
					what, named(got), click.section, gate.arrangementLines(window, built))
			}

			// And in the band the panes are in.
			//
			// The sidebar stands beside the panes and takes the width for the whole column, so the
			// band it holds is theirs — reported 2026-08-17 as a sidebar attached at the overlay's
			// place, and every reading here passed because none of them had asked for a y.
			//
			// It was made the band of the view it stands for on 2026-08-18, to answer a report that
			// things next to each other which should read as one group read as foreign: the sidebar
			// held 87..612 beside a view holding 354..612, twice the height and read as two things.
			// The reading agreed afterwards, and the window was worse. The width is the column's
			// whoever stands in it, so the sidebar shrank and left an empty bordered box above it,
			// 160 points wide and half the column tall. The
			// grouping cannot be bought with the band while the width is the column's; what it would
			// take is the panes reclaiming that space, which is a different window from the one this
			// gate states.
			if where, standing := now.bands["left"]; standing && !now.panesBand.empty() {
				if apart := math.Max(math.Abs(where.top-now.panesBand.top),
					math.Abs(where.bottom-now.panesBand.bottom)); apart > 1 {
					t.Errorf("clicking %s: the sidebar holds %s where the panes hold %s, %.0f apart.\n%s\n"+
						"A sidebar stands beside the panes; a band of its own is one drawn somewhere "+
						"else and taking the width anyway.",
						what, where, now.panesBand, apart, gate.arrangementLines(window, built))
				}
			}

			// And it reads as one thing with the view it stands for.
			//
			// The two are drawn inside one border already — the relation surface strokes the union of
			// the rail and the view it is bound to. Inside that border they were a different colour
			// and a different shape: measured 2026-08-18, the sidebar at rgb(29,26,22) with square
			// corners beside a pane at rgb(39,35,30) with 14px ones. One outline around two cards
			// reads as two things — reported as things next to each other that should be one group
			// reading as foreign.
			//
			// The rail used to be told to look "distinct from a split pane at a glance". It is
			// distinguished by what it holds — a section, a header, its own tabs — and standing
			// against the view it serves it is one card with it.
			look := gate.styleOf(window, "chrome/rail/left",
				[]string{"backgroundColor", "borderRadius"})
			pane := gate.styleOf(window, "layout/pane/"+gate.paneOfTab(window, click.tab),
				[]string{"backgroundColor", "borderRadius"})
			for _, property := range []string{"backgroundColor", "borderRadius"} {
				if look[property] != pane[property] {
					t.Errorf("clicking %s: the sidebar's %s is %s where the view it stands for is %s.\n%s\n"+
						"They are drawn inside one border; two cards inside it read as two things.",
						what, property, look[property], pane[property],
						gate.arrangementLines(window, built))
				}
			}

			// One node per address, whatever is standing.
			gate.assertOneNodePerAddress(window, "clicking "+what)

			// The three panes keep the shape they were built in, whatever the sidebar does.
			gate.assertNamedWindow(window, built)

			// The still this case is kept by: the last frame of its own recording. A second capture
			// of the same window right after the first times out — measured 2026-08-17, six runs
			// running, `RuntimeError: capture timed out` — and two capture paths for one picture is
			// one more than the picture needs.
			gate.keepLastFrame(dir, gate.evidencePath("arrangement", name+".png"), said)
		}
	}
}

// named is a list of sections as a sentence, and "nothing" when there are none — an empty pair of
// brackets beside another empty pair reads as two of the same thing.
func named(sections []string) string {
	if len(sections) == 0 {
		return "nothing"
	}
	return strings.Join(sections, ", ")
}

// sectionOf is the section a named plugin placed in a region. A gate that took whichever section came
// first took the file tree for the browser and asked nothing that could tell them apart.
func (gate *arrangementGate) sectionOf(window string, region string, plugin string) string {
	gate.t.Helper()
	available := gate.availableSections(window)[region]
	for _, key := range available {
		if strings.HasPrefix(key, plugin+".") {
			return key
		}
	}
	gate.t.Fatalf("%s placed no section in the %s region, so nothing of its can stand there.\n"+
		"placed there: %v\nThe plugin is installed from the development tree; a build without it "+
		"cannot be asked whose section stands.", plugin, region, available)
	return ""
}

// settle waits until the window has stopped changing shape, so what is read is what a person is
// left looking at rather than a frame of the way there.
// settleFloorMs is the shortest a settle may take: a layout motion lasts that long, and two
// readings taken before it starts are two readings of the window it is leaving. Measured
// 2026-08-17, a click was judged against the arrangement of the click before it.
const settleFloorMs = 220

func (gate *arrangementGate) settle(window string) {
	gate.t.Helper()
	started := time.Now()
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
		return same >= 2 && time.Since(started) >= settleFloorMs*time.Millisecond
	}, "the window to settle")
}

// arrangementNow is where the region ends, where the panes begin, and whose sections are standing,
// from one reading.
func (gate *arrangementGate) arrangementNow(window string) arrangement {
	gate.t.Helper()
	var answer struct {
		Data struct {
			Regions []struct {
				Region string  `json:"region"`
				X      float64 `json:"x"`
				W      float64 `json:"w"`
				H      float64 `json:"h"`
				Y      float64 `json:"y"`
			} `json:"regions"`
			Sections []struct {
				Region  string `json:"region"`
				Section string `json:"section"`
			} `json:"sections"`
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
	now := arrangement{
		panesStart: -1,
		panes:      map[string]paneBox{},
		sections:   map[string][]string{},
		starts:     map[string]float64{},
		bands:      map[string]band{},
	}
	// A region with no width is not on the screen, whatever x it is parked at. A collapsed rail
	// stays at the station it last held, and reading its right edge as "where the region ends" makes
	// an absent region look like a wide one — which is how this gate first accused the window of
	// keeping a sidebar it had already given up.
	for _, region := range answer.Data.Regions {
		if region.W <= 0 || region.H <= 0 {
			continue
		}
		now.bands[region.Region] = band{top: region.Y, bottom: region.Y + region.H}
		now.starts[region.Region] = region.X
		if region.Region == "left" && region.W > 0 && region.X+region.W > now.regionEnds {
			now.regionEnds = region.X + region.W
		}
	}
	for _, section := range answer.Data.Sections {
		now.sections[section.Region] = append(now.sections[section.Region], section.Section)
	}
	for _, pane := range answer.Data.Panes {
		now.panes[pane.Pane] = pane.paneBox
		if pane.W <= 0 {
			continue
		}
		if now.panesBand.empty() {
			now.panesBand = band{top: pane.Y, bottom: pane.Y + pane.H}
		} else {
			if pane.Y < now.panesBand.top {
				now.panesBand.top = pane.Y
			}
			if pane.Y+pane.H > now.panesBand.bottom {
				now.panesBand.bottom = pane.Y + pane.H
			}
		}
		if pane.X+pane.W > now.panesEnd {
			now.panesEnd = pane.X + pane.W
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

// arrangementLines is the window as it stands — the region, whose sections are in it, and every
// pane, named.
func (gate *arrangementGate) arrangementLines(window string, built gateWindow) string {
	gate.t.Helper()
	now := gate.arrangementNow(window)
	lines := []string{
		fmt.Sprintf("  region ends at %.0f, panes begin at %.0f", now.regionEnds, now.panesStart),
		fmt.Sprintf("  bands: left %s, right %s, panes %s", now.bands["left"], now.bands["right"], now.panesBand),
		fmt.Sprintf("  standing: left %s, right %s",
			named(now.sections["left"]), named(now.sections["right"])),
		// Which plugin the window is reading the standing for, and what stands. A region on the
		// screen with nothing in it and a region standing for the wrong plugin are two different
		// defects that look the same from the outside.
		"  focused view: " + gate.run("state.tree", "window="+window),
		"  sections: " + gate.run("sections.list", "window="+window),
	}
	for _, row := range []struct {
		what string
		pane string
	}{{"terminal (top left)", built.terminal}, {"browser (bottom)", built.browser}, {"right", built.right}} {
		box := now.panes[row.pane]
		lines = append(lines, fmt.Sprintf("  %-20s %s x=%.0f y=%.0f w=%.0f h=%.0f",
			row.what, row.pane, box.X, box.Y, box.W, box.H))
	}
	return strings.Join(lines, "\n")
}

// band is the top and bottom of something, in the window's own coordinates.
type band struct {
	top    float64
	bottom float64
}

func (b band) String() string {
	return fmt.Sprintf("%.0f..%.0f", b.top, b.bottom)
}

func (b band) empty() bool { return b.bottom <= b.top }

// recording captures the window while something happens to it, and returns the wait.
//
// The pictures this gate keeps are of settled windows — one per click, taken once nothing is moving.
// A person watching the run sees everything between them, and on 2026-08-17 said none of it matched
// while every reading here passed. A still of the end of a move is not evidence about the move.
func (gate *arrangementGate) recording(window string, dir string, frames int, intervalMs int) func() string {
	gate.t.Helper()
	// The frames of this run and no other. Left behind, a longer recording's frames outlive a
	// shorter one's and the still is taken from whichever sorts last — measured 2026-08-18, a
	// picture of the window as it stood an hour earlier, read here as the change not having landed.
	if err := os.RemoveAll(dir); err != nil {
		gate.t.Fatalf("clearing %s: %v", dir, err)
	}
	done := make(chan struct{})
	var out string
	var err error
	go func() {
		defer close(done)
		out, err = gate.try("window.record", "window="+window, "dir="+dir,
			fmt.Sprintf("frames=%d", frames), fmt.Sprintf("intervalMs=%d", intervalMs))
	}()
	// The capture is running before the thing it is meant to capture. Without the wait the first
	// frames are of a window nothing has happened to yet.
	time.Sleep(40 * time.Millisecond)
	// A recording that failed is reported where it failed. Swallowed, it leaves a case with no
	// evidence and a run with no reason in it.
	return func() string {
		<-done
		if err != nil {
			gate.t.Errorf("recording into %s: %v\n%s", dir, err, out)
		}
		return out
	}
}

// assertOneNodePerAddress refuses a window that exposes the same address twice.
//
// The address is the only name anything outside has for a node, so two nodes under one name make
// every command that uses it a coin toss and every reading ambiguous. Measured 2026-08-17: both
// regions wrote their cells as pane/left/<i> and their bodies as body/left, so the right region
// answered to the left region's name — and ui.tree had been reporting the collision all along with
// nothing asking it.
func (gate *arrangementGate) assertOneNodePerAddress(window string, what string) {
	gate.t.Helper()
	var answer struct {
		Data struct {
			Duplicates []struct {
				Address string `json:"address"`
				Count   int    `json:"count"`
			} `json:"duplicates"`
		} `json:"data"`
	}
	out := gate.run("ui.tree", "window="+window)
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		gate.t.Fatalf("ui.tree: %v\n%s", err, out)
	}
	if len(answer.Data.Duplicates) == 0 {
		return
	}
	lines := make([]string, 0, len(answer.Data.Duplicates))
	for _, duplicate := range answer.Data.Duplicates {
		lines = append(lines, fmt.Sprintf("  %s (%d nodes)", duplicate.Address, duplicate.Count))
	}
	gate.t.Errorf("after %s the window exposes %d address(es) more than once:\n%s\n"+
		"An address names one node. Two under one name make every command that uses it a guess.",
		what, len(answer.Data.Duplicates), strings.Join(lines, "\n"))
}

// keepLastFrame keeps a recording's final frame as this case's still.
//
// The frame is one the run actually drew, at the end of the move it recorded, rather than a second
// capture taken afterwards. Two captures of one window back to back is how `window.snapshot` came to
// answer `capture timed out` — the still is already in the recording, so it is taken from there.
func (gate *arrangementGate) keepLastFrame(dir string, path string, said string) {
	gate.t.Helper()
	frames, err := filepath.Glob(filepath.Join(dir, "f*.png"))
	if err != nil || len(frames) == 0 {
		// A run with no picture is a run with no evidence. The capture answers under any identity
		// now — the document is taken through the web view when the screen is refused — so a case
		// that kept no frame is a defect and not a machine this gate has to live with.
		gate.t.Errorf("the recording in %s left no frame, so this case has no picture: %v\n"+
			"what the window answered: %s", dir, err, said)
		return
	}
	sort.Strings(frames)
	body, err := os.ReadFile(frames[len(frames)-1])
	if err != nil {
		gate.t.Errorf("reading %s: %v", frames[len(frames)-1], err)
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		gate.t.Errorf("making %s: %v", filepath.Dir(path), err)
		return
	}
	if err := os.WriteFile(path, body, 0o644); err != nil {
		gate.t.Errorf("writing %s: %v", path, err)
	}
}

// evidencePath is a path under this repository's evidence directory, absolute.
//
// A relative path handed to the application is resolved against the application's working
// directory, which is not this one — measured 2026-08-17, nine recordings answered OK and left no
// frame anywhere this run could find.
func (gate *arrangementGate) evidencePath(parts ...string) string {
	gate.t.Helper()
	here, err := os.Getwd()
	if err != nil {
		gate.t.Fatalf("asking where this run is: %v", err)
	}
	return filepath.Join(append([]string{here, "evidence"}, parts...)...)
}

// styleOf reads named computed styles off one exposed node, found by the tail of its address.
//
// The gate addresses nodes by what they are — `rail/left`, `layout/pane/<id>` — and the window
// answers with the whole address, workspace and all. Matching the tail keeps the gate from carrying
// a second copy of how an address is built.
func (gate *arrangementGate) styleOf(window string, suffix string, props []string) map[string]string {
	gate.t.Helper()
	var tree struct {
		Data struct {
			Nodes []struct {
				Address string `json:"address"`
			} `json:"nodes"`
		} `json:"data"`
	}
	out := gate.run("ui.tree", "window="+window)
	if err := json.Unmarshal([]byte(out), &tree); err != nil {
		gate.t.Fatalf("ui.tree: %v\n%s", err, out)
	}
	address := ""
	for _, node := range tree.Data.Nodes {
		if strings.HasSuffix(node.Address, suffix) {
			address = node.Address
			break
		}
	}
	if address == "" {
		gate.t.Fatalf("no node is exposed at %s, so its look cannot be read", suffix)
	}
	var answer struct {
		Data struct {
			Style map[string]string `json:"style"`
		} `json:"data"`
	}
	measured := gate.run("ui.measure", "window="+window, "address="+address, "props="+jsonList(props...))
	if err := json.Unmarshal([]byte(measured), &answer); err != nil {
		gate.t.Fatalf("ui.measure %s: %v\n%s", address, err, measured)
	}
	return answer.Data.Style
}
