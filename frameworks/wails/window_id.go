package wails

import (
	"crypto/rand"
	"encoding/hex"
)

// windowIDBytes is the entropy behind one workspace window name. Sixteen hex
// characters, which is more than a desktop session can exhaust and short enough
// to read back from a log.
const windowIDBytes = 8

// newWindowID supplies the opaque half of a workspace window name.
//
// Random rather than counted, because a counter restarts at the same value
// every launch and the names are what the frontend and the control plane both
// address windows by. Two launches would then disagree about which window a
// saved address means.
//
// crypto/rand rather than math/rand for the same reason a counter is wrong: a
// seeded generator repeats its sequence, and a repeat here is two windows the
// host distinguishes by map order.
//
// A collision would still be caught rather than believed — createName refuses a
// generated name that is already held — so this owes uniqueness in practice,
// not a proof.
func newWindowID() string {
	id := make([]byte, windowIDBytes)
	if _, err := rand.Read(id); err != nil {
		// crypto/rand.Read only fails if the operating system's entropy source
		// is unavailable, which is not a condition a window name can paper
		// over: any fallback here would be the repeating sequence this exists
		// to avoid.
		panic("wails: no entropy for a window name: " + err.Error())
	}
	return hex.EncodeToString(id)
}
