package wails

import (
	"fmt"
	"math"
	"testing"
)

func floatPtr(value float64) *float64 { return &value }
func boolPtr(value bool) *bool        { return &value }

// showMonitor renders a monitor verdict so a failure names the answer rather
// than the address it came back in.
func showMonitor(index *int) string {
	if index == nil {
		return "none"
	}
	return fmt.Sprintf("%d", *index)
}

// A window name becomes the key "window/<name>" in the snapshot store and a
// slot key in the restore manifest. A separator inside it lets one window's
// snapshot address another namespace's path.
func TestAWindowNameWithASeparatorIsRefused(t *testing.T) {
	for _, name := range []string{"win-a/b", "win-../main", "win-a.b", "win- a", `win-a"b`, "win-a\\b"} {
		if validWindowName(name) {
			t.Errorf("%q was accepted; it addresses a path outside its own snapshot key", name)
		}
	}
}

// A name outside the "win-" family is outside the capability glob the frontend
// assumes, and a window built under it answers no command at all.
func TestANameThatIsNeitherReservedNorAWorkspaceIsRefused(t *testing.T) {
	for _, name := range []string{"", "win-", "w-1", "window-1", "orchestrator", "WIN-1"} {
		if validWindowName(name) {
			t.Errorf("%q was accepted; only the reserved name and win-<id> are addressable", name)
		}
	}
	for _, name := range []string{"main", "win-1", "win-2f1c-4a", "win-A_b-9"} {
		if !validWindowName(name) {
			t.Errorf("%q was refused; it is a name this build must address", name)
		}
	}
}

// The reserved name is accepted when asked for and never produced by the
// generator: the application branches on it, and generating it would tie that
// branch to creation order.
func TestTheReservedNameIsAcceptedButNeverGenerated(t *testing.T) {
	if !validWindowName(controlPlaneWindow) {
		t.Fatalf("%q must stay addressable; the orchestrator is reopened by that exact name", controlPlaneWindow)
	}
	if got := workspaceName(controlPlaneWindow); got == controlPlaneWindow {
		t.Fatalf("the generator produced the reserved name %q", got)
	}
	if got := workspaceName("2f1c"); got != "win-2f1c" {
		t.Fatalf("workspaceName(2f1c) = %q, want win-2f1c", got)
	}
	if !validWindowName(workspaceName("2f1c")) {
		t.Fatal("a generated name must be addressable")
	}
}

// A rect missing any one component is no rect. Half-filling it puts the window
// somewhere it was never asked to be, and that reads as "the restore put it in
// the wrong place" rather than as an error.
func TestAPartialRectIsNoRect(t *testing.T) {
	cases := [][4]*float64{
		{nil, floatPtr(0), floatPtr(1), floatPtr(1)},
		{floatPtr(0), nil, floatPtr(1), floatPtr(1)},
		{floatPtr(0), floatPtr(0), nil, floatPtr(1)},
		{floatPtr(0), floatPtr(0), floatPtr(1), nil},
	}
	for _, c := range cases {
		if frame, ok := frameOf(c[0], c[1], c[2], c[3]); ok {
			t.Errorf("a partial rect produced %+v; it must produce no frame at all", frame)
		}
	}
}

// A window built from a zero-size rect exists and is invisible, which shows up
// only as "the window did not open".
func TestAZeroSizedRectIsNoRect(t *testing.T) {
	cases := [][4]float64{
		{0, 0, 0, 600},
		{0, 0, 800, -1},
		{0, 0, 800, 0},
		// Bounds are whole points here, so a sub-point size truncates to zero
		// and produces exactly the invisible window the rule above forbids.
		{0, 0, 0.4, 600},
	}
	for _, c := range cases {
		if frame, ok := frameOf(floatPtr(c[0]), floatPtr(c[1]), floatPtr(c[2]), floatPtr(c[3])); ok {
			t.Errorf("rect %v produced %+v; a window with no area is not a place", c, frame)
		}
	}
}

func TestANonFiniteRectIsNoRect(t *testing.T) {
	cases := [][4]float64{
		{math.NaN(), 0, 1, 1},
		{0, math.Inf(1), 1, 1},
		{0, 0, math.Inf(-1), 1},
		{0, 0, 1, math.NaN()},
	}
	for _, c := range cases {
		if frame, ok := frameOf(floatPtr(c[0]), floatPtr(c[1]), floatPtr(c[2]), floatPtr(c[3])); ok {
			t.Errorf("rect %v produced %+v; a non-finite component has no position on any screen", c, frame)
		}
	}
}

// A component too large for the 32-bit integer the platform is handed does not
// fail on the way — it wraps. Measured: x = 1e300 truncated to the largest
// int64 and arrived at the platform as -1, so the window moved to the left edge
// and the placement reported success.
func TestARectThatCannotSurviveTheTripIsNoRect(t *testing.T) {
	cases := [][4]float64{
		{1e300, 0, 800, 600},
		{0, -1e300, 800, 600},
		{0, 0, 1e300, 600},
		{0, 0, 800, 1e300},
		// The first value that no longer fits, and the first below it.
		{frameLimit, 0, 800, 600},
		{0, -frameLimit - 1, 800, 600},
	}
	for _, c := range cases {
		if frame, ok := frameOf(floatPtr(c[0]), floatPtr(c[1]), floatPtr(c[2]), floatPtr(c[3])); ok {
			t.Errorf("rect %v produced %+v; that number is not the one the platform receives", c, frame)
		}
	}
	// The edges of the range still pass, or the rule has quietly become
	// "windows may not go near the far edge of a large desktop".
	edges := [][4]float64{
		{frameLimit - 1, 0, 800, 600},
		{-frameLimit, 0, 800, 600},
	}
	for _, c := range edges {
		if _, ok := frameOf(floatPtr(c[0]), floatPtr(c[1]), floatPtr(c[2]), floatPtr(c[3])); !ok {
			t.Errorf("rect %v was refused; it is inside the range the platform carries", c)
		}
	}
}

func TestAFullRectIsAFrame(t *testing.T) {
	frame, ok := frameOf(floatPtr(10), floatPtr(20), floatPtr(800), floatPtr(600))
	if !ok || frame != (Frame{X: 10, Y: 20, W: 800, H: 600}) {
		t.Fatalf("frameOf(10,20,800,600) = %+v, %v", frame, ok)
	}
}

// A false default makes opening a window look like nothing happened.
func TestFocusDefaultsToTrue(t *testing.T) {
	if !shouldFocus(nil) {
		t.Error("an unstated focus must be true; a silent new window reads as a failed command")
	}
	if !shouldFocus(boolPtr(true)) {
		t.Error("focus:true must be true")
	}
	if shouldFocus(boolPtr(false)) {
		t.Error("focus:false must be false; a respawn must not steal the orchestrator's focus")
	}
}

// Everything after a '#' never reaches location.search, so boot instructions
// carried there vanish with nothing reported anywhere.
func TestAnInitQueryThatWouldNotSurviveTheURLIsRefused(t *testing.T) {
	for _, init := range []string{"root=a#b", "#", "?root=a"} {
		if err := checkInitQuery(init); err == nil {
			t.Errorf("init %q was accepted; the boot instruction would be dropped with no error", init)
		}
	}
	for _, init := range []string{"", "root=a", "root=%2Fx&fresh=1"} {
		if err := checkInitQuery(init); err != nil {
			t.Errorf("init %q was refused: %v", init, err)
		}
	}
}

var leftDisplay = Display{Index: 0, X: 0, Y: 0, W: 1920, H: 1080, Scale: 2}
var rightDisplay = Display{Index: 1, X: 1920, Y: 0, W: 2560, H: 1440, Scale: 1}

// Choosing by overlapping area moves a window between monitors on a one-point
// nudge, which appears as "it sometimes opens on the other screen".
func TestAStraddlingWindowGetsExactlyOneMonitor(t *testing.T) {
	displays := []Display{leftDisplay, rightDisplay}
	if got := monitorOf(Frame{X: 100, Y: 100, W: 800, H: 600}, displays); got == nil || *got != 0 {
		t.Fatalf("a window centred on the left screen answered %s", showMonitor(got))
	}
	if got := monitorOf(Frame{X: 2000, Y: 200, W: 800, H: 600}, displays); got == nil || *got != 1 {
		t.Fatalf("a window centred on the right screen answered %s", showMonitor(got))
	}
	// Its centre is exactly 1920. The right edge is outside and the left edge
	// is inside, so a shared point never lets list order decide.
	straddle := Frame{X: 1520, Y: 0, W: 800, H: 600}
	if got := monitorOf(straddle, displays); got == nil || *got != 1 {
		t.Fatalf("a window centred on the seam answered %s, want the right screen", showMonitor(got))
	}
	if got := monitorOf(straddle, []Display{rightDisplay, leftDisplay}); got == nil || *got != 0 {
		t.Fatalf("reordering the catalogue changed the verdict: %s", showMonitor(got))
	}
}

// Falling back to 0 is indistinguishable from "it is on the first monitor".
func TestAWindowOffEveryScreenBelongsToNoMonitor(t *testing.T) {
	if got := monitorOf(Frame{X: -5000, Y: -5000, W: 100, H: 100}, []Display{leftDisplay, rightDisplay}); got != nil {
		t.Fatalf("an off-screen window answered monitor %d", *got)
	}
}

func TestAnEmptyDisplayCatalogueAnswersNoMonitor(t *testing.T) {
	if got := monitorOf(Frame{X: 0, Y: 0, W: 10, H: 10}, nil); got != nil {
		t.Fatalf("an empty catalogue answered monitor %d", *got)
	}
}

// Two processes only agree about ownership if they discard the remainder the
// same way.
func TestTheCentreTruncatesInOneDirection(t *testing.T) {
	if x, y := centreOf(Frame{X: 0, Y: 0, W: 3, H: 3}); x != 1 || y != 1 {
		t.Errorf("centre of {0,0,3,3} = (%d,%d), want (1,1)", x, y)
	}
	if x, y := centreOf(Frame{X: 10, Y: 20, W: 5, H: 7}); x != 12 || y != 23 {
		t.Errorf("centre of {10,20,5,7} = (%d,%d), want (12,23)", x, y)
	}
}

// Collapsing a shared name to one row says there is one window, and the caller
// then cannot tell "I cannot pick which one" from "there is only one".
func TestCensusFoldsASharedNameIntoOneRowWithTwoHosts(t *testing.T) {
	folded := foldCensus([]censusRow{
		{Label: "main", Hosts: 1, Focused: false},
		{Label: "main", Hosts: 1, Focused: true},
		{Label: "win-1", Hosts: 1, Focused: false},
	})
	if len(folded) != 2 {
		t.Fatalf("folded to %d rows, want 2: %+v", len(folded), folded)
	}
	if folded[0].Label != "main" || folded[0].Hosts != 2 {
		t.Fatalf("the shared name reported %+v, want hosts 2", folded[0])
	}
	if !folded[0].Focused {
		t.Fatal("one holder had focus; folding must keep that fact")
	}
}

// Landing exactly on top of the source window makes it impossible to see that
// a new window opened at all.
func TestCascadeOffsetsFromTheSourceAndKeepsTheFreshSize(t *testing.T) {
	got := cascadeFrom(Frame{X: 100, Y: 50, W: 1000, H: 618}, Frame{X: 0, Y: 0, W: 800, H: 600})
	want := Frame{X: 128, Y: 78, W: 800, H: 600}
	if got != want {
		t.Fatalf("cascadeFrom = %+v, want %+v", got, want)
	}
}

// Every identifier prefix in this product is exactly three letters, so that the
// string alone says what kind of thing it names. One letter cannot: "w-" is
// window, webview and workspace at once, and a reader who has to ask is reading
// a name that failed at its only job. The frontend issues its own identifiers
// under the same law (frontend/src/state/ids.ts), and this is the half of it
// that lives on the host.
func TestTheWindowNamePrefixIsThreeLetters(t *testing.T) {
	if got := workspaceWindowPrefix; len(got) != 4 || got[3] != '-' {
		t.Fatalf("prefix %q is not three letters and a dash", got)
	}
	for _, c := range workspaceWindowPrefix[:3] {
		if c < 'a' || c > 'z' {
			t.Fatalf("prefix %q holds %q, which is not a lowercase letter", workspaceWindowPrefix, c)
		}
	}
}
