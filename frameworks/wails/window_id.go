package wails

import (
	"crypto/rand"
)

// windowIDLength is the body of an N1 identifier: six characters.
//
// docs/tech/NAMING.md N1 fixes one format for every identifier in this product.
// The host issues this one — a window outlives the document inside it, and the
// name is the key of window/<name> in the snapshot store — but issuing it is not
// licence to spell it differently. It produced sixteen hex characters until
// 2026-08-16, so the product had two identifier laws and the table in
// frontend/src/state/ids.ts listed this kind under a format it did not follow.
const windowIDLength = 6

// windowIDAlphabet is RFC 4648 lowercase base32.
//
// The digits 0 and 1 are outside it, so no value is read back as o or l. Hex
// supplies neither of those look-alikes and is therefore not interchangeable
// with it, whatever the length.
const windowIDAlphabet = "abcdefghijklmnopqrstuvwxyz234567"

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
	// The alphabet is 32 characters, so five bits fill one of them and a byte
	// masked to five bits is uniform across it. A modulo of the whole byte
	// would favour the first 8 characters, which is a bias in the one value
	// that has to spread evenly.
	raw := make([]byte, windowIDLength)
	if _, err := rand.Read(raw); err != nil {
		// crypto/rand.Read only fails if the operating system's entropy source
		// is unavailable, which is not a condition a window name can paper
		// over: any fallback here would be the repeating sequence this exists
		// to avoid.
		panic("wails: no entropy for a window name: " + err.Error())
	}
	id := make([]byte, windowIDLength)
	for index, value := range raw {
		id[index] = windowIDAlphabet[value&0x1f]
	}
	return string(id)
}
