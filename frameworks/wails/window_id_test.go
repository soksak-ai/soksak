package wails

import (
	"regexp"
	"testing"
)

// N1 identifier body: six characters of RFC 4648 lowercase base32. The digits 0
// and 1 are outside that alphabet, so no value is read back as o or l. The
// frontend issues its half under the same expression
// (frontend/src/state/ids.ts), and a shape that differs between the two halves
// makes one product with two identifier laws.
var windowIDBody = regexp.MustCompile(`^[a-z2-7]{6}$`)

// N1 identifier: three letters, a dash, then the body.
var windowIDName = regexp.MustCompile(`^[a-z]{3}-[a-z2-7]{6}$`)

// The host issues the window identifier because a window outlives the document
// inside it, and the name is the key of window/<name> in the snapshot store.
func TestAWindowIDIsSixBase32Characters(t *testing.T) {
	for range 256 {
		id := newWindowID()
		if !windowIDBody.MatchString(id) {
			t.Fatalf("newWindowID produced %q; N1 is six characters of a-z2-7", id)
		}
	}
}

// The name is what the control plane and the frontend both address, so the
// prefix is part of the format the gate judges, not a separate concern.
func TestAWindowIDBecomesAnN1Name(t *testing.T) {
	for range 256 {
		name := workspaceName(newWindowID())
		if !windowIDName.MatchString(name) {
			t.Fatalf("workspaceName produced %q; N1 is three letters, a dash, and six a-z2-7", name)
		}
	}
}

// 0 and 1 are the two characters base32 leaves out, and hex supplies neither of
// their look-alikes. A body drawn from hex passes a length check and fails
// this one, which is the difference the two alphabets are chosen for.
func TestAWindowIDUsesNoCharacterOutsideBase32(t *testing.T) {
	seen := map[rune]bool{}
	for range 4096 {
		for _, r := range newWindowID() {
			seen[r] = true
		}
	}
	for _, r := range "0189" {
		if seen[r] {
			t.Fatalf("%q appeared in a window id; base32 does not hold it", r)
		}
	}
	if len(seen) != 32 {
		t.Fatalf("%d distinct characters over 4096 ids, want the whole 32-character alphabet", len(seen))
	}
}

func TestAGeneratedWindowIDMakesAnAddressableName(t *testing.T) {
	// The generator and the name rule are separate, so a change to either could
	// start producing names the address parser refuses.
	for range 64 {
		name := workspaceName(newWindowID())
		if !validWindowName(name) {
			t.Fatalf("generated %q, which is not an addressable window name", name)
		}
	}
}

func TestAWindowIDIsDrawnFromASpaceTooLargeToCollideIn(t *testing.T) {
	// The size of the space, not a sample of it. Six characters of a 32-character alphabet is
	// 32**6, and that number is the whole guarantee: shortening either one is what makes two
	// windows share a name, and it is checkable exactly.
	//
	// This replaces a draw of 4096 that refused any repeat. Over 32**6 that draw collides about
	// 0.78% of the time by construction — one run in a hundred and twenty-eight failed on
	// arithmetic rather than on a defect, and measured 2026-08-18 one did. A gate that passes 99%
	// of the time is passing by luck.
	space := 1
	for range windowIDLength {
		space *= len(windowIDAlphabet)
	}
	if space < 1<<30 {
		t.Errorf("a window id is drawn from %d values, which two windows can share.\n"+
			"Six characters of a 32-character alphabet is 2**30; lengthening the id or the "+
			"alphabet is what widens it.", space)
	}
}

func TestAWindowIDIsNotASequence(t *testing.T) {
	// A counter reset to zero each launch would pass every other test in this package and still
	// hand two windows the same name across a restart. What that looks like is a generator whose
	// draws collapse onto a small set — so this refuses that, at a bound the arithmetic above
	// cannot reach: 4096 draws over 2**30 are expected to repeat 0.008 times, and three repeats is
	// something other than chance by a factor of hundreds.
	const draws = 4096
	const allowed = 2
	seen := map[string]int{}
	repeats := 0
	for range draws {
		id := newWindowID()
		seen[id]++
		if seen[id] > 1 {
			repeats++
		}
	}
	if repeats > allowed {
		t.Errorf("%d of %d draws repeated, where chance accounts for 0.008.\n"+
			"That is a generator drawing from a smaller set than its alphabet and length say — a "+
			"counter, a seeded sequence, or an entropy source answering the same bytes.",
			repeats, draws)
	}
}
