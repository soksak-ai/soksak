package wails

import "testing"

func TestAGeneratedNameIsAddressable(t *testing.T) {
	// The generator and the name rule are separate, so a change to either could
	// start producing names the address parser refuses.
	for range 64 {
		name := workspaceName(newWindowID())
		if !validWindowName(name) {
			t.Fatalf("generated %q, which is not an addressable window name", name)
		}
	}
}

func TestGeneratedNamesDoNotRepeat(t *testing.T) {
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
