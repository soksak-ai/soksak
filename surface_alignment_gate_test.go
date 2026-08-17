package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

// A page stays on its pane while a person opens a sidebar.
//
// Recorded 2026-08-17 and counted frame by frame: the browser page was drawn over the file tree and
// past the window's left edge, and when the layout changed it did not travel — it stood still and
// then appeared 160 points away one frame later. The composition reported zero drift throughout,
// because the number it compares is the rectangle the document declared, and that declaration was
// the stale one.
//
// So the reading here is the other pair: the declaring element **now** against the surface **now**,
// which `layout.alignment` answers in one sample. The stimulus is the click a person makes, on the
// exposed toggle, rather than the command behind it — a path that only the plane can take is a path
// nobody walks.
const surfaceAlignmentGateHome = "<local-evidence>/soksak-surface-alignment-gate"

const surfaceAlignmentGateIdentifier = "com.soksak.surfacealignmentgate"

type surfaceAlignmentGate = restoreGate

// alignmentSample is one reading of the worst-placed surface during a layout change.
type alignmentSample struct {
	at   time.Duration
	off  float64
	lag  float64
	dom  float64
	held float64
}

// surfaceOffTolerance is how far apart a pane and its page may be and still be in the same place.
// Both halves carry the same float64 through one commit, so the resting state is exact; what this
// forgives is the rounding a reading writes down, not a displacement.
const surfaceOffTolerance = 2.0

// surfaceOffBudget is how long a page may be behind its pane.
//
// The declaration is measured in the document and applied across a process boundary, and that round
// trip was measured at 38 to 68ms in this build — the native work inside it is under a fifth of a
// millisecond. A page cannot be closer to its pane than one of those, so a budget under it fails a
// window doing the best this pipeline allows. One commit with a frame of room.
const surfaceOffBudget = 100 * time.Millisecond

// longestOff is the longest unbroken stretch the page spent away from its pane, with the worst
// distance inside it. Unbroken is the measure: a single reading between two aligned ones is the
// frame the commit takes, and a hundred of them in a row is a page sitting in the wrong place.
func longestOff(samples []alignmentSample) (time.Duration, float64, int) {
	longest, worst, count := time.Duration(0), 0.0, 0
	runStart, runWorst, runCount := -1, 0.0, 0
	closeRun := func(end int) {
		if runStart < 0 {
			return
		}
		if span := samples[end].at - samples[runStart].at; span >= longest {
			longest, worst, count = span, runWorst, runCount
		}
		runStart, runWorst, runCount = -1, 0, 0
	}
	for i, sample := range samples {
		if sample.off <= surfaceOffTolerance {
			closeRun(i - 1)
			continue
		}
		if runStart < 0 {
			runStart = i
		}
		runCount++
		if sample.off > runWorst {
			runWorst = sample.off
		}
	}
	closeRun(len(samples) - 1)
	return longest, worst, count
}

func TestAPageStaysOnItsPaneWhileTheSidebarOpens(t *testing.T) {
	gate := newGate(t, surfaceAlignmentGateHome, surfaceAlignmentGateIdentifier)
	plugins := gate.installPlugins()
	gate.start()
	defer gate.quit()

	window := gate.openWorkspace()
	gate.consentAndEnable(window, plugins)
	for _, program := range gate.programs(window) {
		gate.open(window, program)
	}

	// More than one page, because that is the window a person has. Each surface is one more
	// rectangle in every commit and one more move for the native layer to apply, and a pipeline
	// that keeps up with one can fall a long way behind four — the recorded window held four.
	for _, program := range gate.programs(window) {
		if !strings.Contains(program, "browser") {
			continue
		}
		for extra := 0; extra < 3; extra++ {
			gate.open(window, program)
		}
	}

	// A surface has to be on screen before its placement means anything.
	if surface := gate.aVisibleSurface(window); surface == "" {
		t.Fatal("no surface is on screen, so its placement cannot be watched")
	}

	// A region with nothing standing in it takes no width, and a region that takes no width moves
	// nothing. The link is settled first, and the region closed, so the click below is the change.
	set := gate.createSet(window, "alignment")
	sections := gate.availableSections(window)["left"]
	if len(sections) == 0 {
		t.Fatal("no section stands on the left, so the toggle would move nothing")
	}
	gate.run("sections.arrange", "window="+window, "set="+set, "sections="+jsonList(sections[0]))
	gate.run("sections.link", "window="+window,
		"plugin="+gate.aPluginWithAPane(window), "set="+set, "region=left")
	gate.run("workspace.region.toggle", "window="+window, "region=left", "open=false")
	gate.until(5*time.Second, func() bool { return gate.worstOff(window) == 0 },
		"the page to settle on its pane before the click")

	// The clicks a person makes, on the node the window exposes. Repeated, because that is what was
	// recorded: the sidebar came and went six times in three seconds, and a change that starts while
	// the last one is still moving is the case a single press never produces.
	samples := gate.watchAlignment(window, func() {
		for press := 0; press < 6; press++ {
			gate.run("ui.input.click", "window="+window, "address=chrome/titlebar/region/left")
			time.Sleep(250 * time.Millisecond)
		}
	})

	longest, worst, count := longestOff(samples)
	t.Logf("%d readings, worst unbroken stretch off its pane: %s (%.0fpt, %d readings)",
		len(samples), longest, worst, count)
	if longest > surfaceOffBudget {
		t.Errorf("the page was off its pane for %s without returning to it, worst %.0fpt over %d readings.\n%s\n"+
			"A page drawn away from its pane is one a person sees over the sidebar, and the "+
			"composition agrees with itself the whole time.",
			longest, worst, count, alignmentLines(samples))
	}
}

// watchAlignment reads the alignment as fast as the plane answers, from just before the change until
// the layout has been still for a while.
func (gate *surfaceAlignmentGate) watchAlignment(window string, cause func()) []alignmentSample {
	gate.t.Helper()
	started := time.Now()
	var samples []alignmentSample
	read := func() alignmentSample {
		off, lag, dom, held := gate.alignment(window)
		return alignmentSample{at: time.Since(started), off: off, lag: lag, dom: dom, held: held}
	}
	samples = append(samples, read())
	// The cause runs beside the reading, not before it. Running it first and reading afterwards
	// samples the stillness after the change and nothing of the change — 258 readings that way held
	// no disagreement at all, because every one of them was taken once the layout had settled.
	done := make(chan struct{})
	go func() {
		defer close(done)
		cause()
	}()
	settled := time.Time{}
	for {
		samples = append(samples, read())
		select {
		case <-done:
			if settled.IsZero() {
				settled = time.Now()
			}
		default:
		}
		if !settled.IsZero() && time.Since(settled) > time.Second {
			return samples
		}
		if time.Since(started) > 15*time.Second {
			return samples
		}
	}
}

// alignment is the worst distance between a pane and the page drawn for it, with the two x
// coordinates that make it up.
func (gate *surfaceAlignmentGate) alignment(window string) (off float64, lag float64, dom float64, held float64) {
	gate.t.Helper()
	var answer struct {
		Data struct {
			WorstOff float64 `json:"worstOff"`
			WorstLag float64 `json:"worstLag"`
			Surfaces []struct {
				Dom struct {
					X float64 `json:"x"`
				} `json:"dom"`
				Applied *struct {
					X float64 `json:"x"`
				} `json:"applied"`
				Off *float64 `json:"off"`
			} `json:"surfaces"`
		} `json:"data"`
	}
	out := gate.run("layout.alignment", "window="+window)
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		gate.t.Fatalf("layout.alignment: %v\n%s", err, out)
	}
	for _, surface := range answer.Data.Surfaces {
		if surface.Off == nil || *surface.Off < answer.Data.WorstOff {
			continue
		}
		dom = surface.Dom.X
		if surface.Applied != nil {
			held = surface.Applied.X
		}
	}
	return answer.Data.WorstOff, answer.Data.WorstLag, dom, held
}

func (gate *surfaceAlignmentGate) worstOff(window string) float64 {
	gate.t.Helper()
	off, _, _, _ := gate.alignment(window)
	return off
}

func worstOf(samples []alignmentSample) float64 {
	worst := 0.0
	for _, sample := range samples {
		if sample.off > worst {
			worst = sample.off
		}
	}
	return worst
}

func alignmentLines(samples []alignmentSample) string {
	lines := make([]string, 0, len(samples))
	for _, sample := range samples {
		lines = append(lines, fmt.Sprintf("  %6dms off=%.0f lag=%.0f pane_x=%.0f page_x=%.0f",
			sample.at.Milliseconds(), sample.off, sample.lag, sample.dom, sample.held))
	}
	return strings.Join(lines, "\n")
}
