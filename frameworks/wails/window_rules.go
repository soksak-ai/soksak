package wails

import (
	"fmt"
	"math"
	"strings"
)

// The rules that decide what a window is called, where it goes, and which
// screen owns it.
//
// Creating a window belongs to the framework. Deciding what to create does not:
// if the name shape drifts, one build's restore manifest cannot read the
// other's; if the rect verdict drifts, the same restore keeps its position on
// only one of them. Nothing here creates a window or asks whether one is alive
// — those are facts held by whoever owns windows.

// workspaceWindowPrefix marks a workspace window and separates it from the
// reserved orchestrator name.
//
// The identifier after it is opaque and never reused: a closed window's name on
// a new window makes that window inherit the dead one's restored state. The
// prefix itself cannot change — an earlier generation used "win-" and the
// frontend's capability glob still assumes "w-*".
const workspaceWindowPrefix = "w-"

// cascadePoints is the offset a fresh window takes from the one that opened it.
// 28pt is roughly a centimetre (72pt to the inch). Landing exactly on top makes
// it impossible to see that a window opened at all.
//
// An earlier build divided a physical position by the scale factor to get here.
// Frames are already device-independent points in this host, so the offset is
// applied directly and there is no second copy of that arithmetic to drift.
const cascadePoints = 28

// validWindowName reports whether this name may address a window.
//
// Two rules, for two different failures. A name outside the "w-" family (the
// reserved orchestrator name aside) falls outside the capability glob the
// frontend assumes, and every command sent to such a window times out rather
// than failing. And the name becomes the key "window/<name>" in the snapshot
// store plus a slot key in the restore manifest, so a separator inside it lets
// one window's snapshot address another namespace's path. An earlier build
// leaned on the shape of a uuid and on a guard in the frontend for the second
// rule; a backend that trusts a frontend guard is the half that actually
// creates the unreachable window.
func validWindowName(name string) bool {
	if name == controlPlaneWindow {
		return true
	}
	body, found := strings.CutPrefix(name, workspaceWindowPrefix)
	if !found || body == "" {
		return false
	}
	for _, r := range body {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}

// workspaceName turns an opaque identifier into a workspace window name. The
// prefix is this package's rule; the entropy belongs to whoever supplied the
// identifier.
func workspaceName(id string) string {
	return workspaceWindowPrefix + id
}

// frameLimit is one past the furthest a frame component can travel and still
// arrive as the number that was sent.
//
// The frame is applied as a 32-bit integer at the platform edge, and neither
// step on the way there reports a loss: Go's float-to-int conversion of an
// out-of-range value is implementation-defined rather than an error, and the
// narrowing to 32 bits wraps silently. Measured 2026-08-15 with x = 1e300:
// window_place answered success having asked for x = 9223372036854775807, which
// arrives at the platform as -1. The window moves somewhere nobody chose and
// the placement is reported as done — a failure that is invisible at every
// layer that could have named it. An earlier build could not have this case: its
// command took i32/u32 and the decoder refused the number by type.
const frameLimit = 1 << 31

// frameOf reads a requested rectangle. All four components must be present,
// finite, small enough to arrive, and leave the window with area.
//
// A missing component means no rect at all rather than a rect with a zero in
// it: half-filling one puts the window somewhere it was never asked to be, and
// that shows up as "the restore put it in the wrong place" rather than as an
// error. A window with no area is created and invisible, which shows up only as
// "the window did not open" — so the size test runs after truncation to whole
// points, where a sub-point size becomes exactly that invisible window.
func frameOf(x, y, w, h *float64) (Frame, bool) {
	if x == nil || y == nil || w == nil || h == nil {
		return Frame{}, false
	}
	for _, component := range []float64{*x, *y, *w, *h} {
		if math.IsNaN(component) || math.IsInf(component, 0) {
			return Frame{}, false
		}
		// Before the truncation, because afterwards the excess is gone and what
		// is left is a plausible coordinate.
		if component >= frameLimit || component < -frameLimit {
			return Frame{}, false
		}
	}
	frame := Frame{X: int(*x), Y: int(*y), W: int(*w), H: int(*h)}
	if frame.W <= 0 || frame.H <= 0 {
		return Frame{}, false
	}
	return frame, true
}

// shouldFocus answers whether a new window comes forward. The default is true:
// a user who opens a window expects it to be the one they are looking at, and a
// false default makes opening a window look like nothing happened. Only a
// restore asks for false, so it can bring windows back without taking the
// focus away from whatever the user is using.
func shouldFocus(requested *bool) bool {
	if requested == nil {
		return true
	}
	return *requested
}

// checkInitQuery accepts the boot instruction a new window carries in its URL.
//
// The core never interprets it — the frontend's boot does. It does check that
// the instruction survives the trip: the query is joined with "?", so a leading
// "?" produces two, and everything after a "#" never reaches location.search.
// Either way the instruction is dropped with nothing reported anywhere.
func checkInitQuery(init string) error {
	if strings.Contains(init, "#") {
		return fmt.Errorf("init query contains '#'; everything after it never reaches location.search: %q", init)
	}
	if strings.HasPrefix(init, "?") {
		return fmt.Errorf("init query starts with '?'; it is joined onto the URL with one already: %q", init)
	}
	return nil
}

// centreOf is the one point that decides which screen owns a window. The
// remainder is discarded, and two processes only agree about ownership if they
// discard it the same way.
func centreOf(frame Frame) (int, int) {
	return frame.X + frame.W/2, frame.Y + frame.H/2
}

// holds reports whether this display contains the point. The right and bottom
// edges are outside: where two screens touch, a point belonging to both makes
// ownership depend on catalogue order.
func (display Display) holds(x, y int) bool {
	return x >= display.X && x < display.X+display.W &&
		y >= display.Y && y < display.Y+display.H
}

// monitorOf answers which display owns this window — one verdict, by centre
// point.
//
// A window across a seam still gets exactly one. Choosing by overlapping area
// moves it between displays on a one-point nudge, and that unsteadiness appears
// in window placement as "it sometimes opens on the other screen". A window on
// no display at all answers nothing rather than zero: that zero would be
// indistinguishable from "it is on the first display".
func monitorOf(frame Frame, displays []Display) *int {
	x, y := centreOf(frame)
	for index := range displays {
		if displays[index].holds(x, y) {
			owner := index
			return &owner
		}
	}
	return nil
}

// cascadeFrom offsets a fresh window from the window that opened it, keeping
// the size the fresh window already has. With no source window there is no
// cascade at all — the caller leaves the frame alone rather than defaulting to
// the origin, which would move every first window to the top-left corner.
func cascadeFrom(source, fresh Frame) Frame {
	return Frame{
		X: source.X + cascadePoints,
		Y: source.Y + cascadePoints,
		W: fresh.W,
		H: fresh.H,
	}
}

// censusRow is one name in the occupancy ledger. Hosts counts how many holders
// have it, so anything above one means an overlap.
type censusRow struct {
	Label   string `json:"label"`
	Hosts   uint64 `json:"hosts"`
	Focused bool   `json:"focused"`
}

// foldCensus merges rows that share a name and counts the holders.
//
// It does not collapse them into a single window, because this is the place
// that counts: "I cannot tell which window this is" and "there is one window"
// are different facts, and only the first means someone must not respawn it.
func foldCensus(rows []censusRow) []censusRow {
	folded := make([]censusRow, 0, len(rows))
	for _, row := range rows {
		merged := false
		for i := range folded {
			if folded[i].Label == row.Label {
				folded[i].Hosts += row.Hosts
				folded[i].Focused = folded[i].Focused || row.Focused
				merged = true
				break
			}
		}
		if !merged {
			folded = append(folded, row)
		}
	}
	return folded
}
