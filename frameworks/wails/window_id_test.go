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

func TestGeneratedWindowIDsDoNotRepeat(t *testing.T) {
	// A counter reset to zero each launch would pass every other test in this
	// package and still hand two windows the same name across a restart.
	seen := map[string]bool{}
	for range 4096 {
		id := newWindowID()
		if seen[id] {
			t.Fatalf("generated %q twice", id)
		}
		seen[id] = true
	}
}
