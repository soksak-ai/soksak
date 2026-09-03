package session

import (
	"strings"
	"testing"
)

// The core records the id an owner issued, never one it made from a coordinate.
//
// A coordinate answers "is there a session here" and the id answers "which session". Measured
// 2026-08-16: a terminal looked up by windowLabel + paneId alone could not be reattached after a
// restore issued new pane ids, while the shell was still running and still holding its scrollback.
// A core that built an id out of the coordinate would put that failure back — the id would change
// whenever the view moved, and every session would be lost by a drag.
//
// So an attachment with no id is refused rather than given one, and what is stored is what the
// owner issued, byte for byte.
func TestTheCoreStoresTheIdTheOwnerIssued(t *testing.T) {
	store := &memoryStore{}
	// An id that looks nothing like a coordinate, and one that looks exactly like one. Both are the
	// owner's to choose, and both come back unchanged.
	for _, issued := range []string{"3606797633324619000", "main|pane-7", "7"} {
		if err := Attach(store, Attachment{
			Session: issued, Owner: "an-owner", ViewID: "v1", WindowLabel: "main",
		}); err != nil {
			t.Fatalf("attaching %q: %v", issued, err)
		}
	}

	index, err := ReadIndex(store)
	if err != nil {
		t.Fatalf("reading the index: %v", err)
	}
	seen := map[string]bool{}
	for _, entry := range index {
		seen[entry.Session] = true
	}
	for _, issued := range []string{"3606797633324619000", "main|pane-7", "7"} {
		if !seen[issued] {
			t.Fatalf("the index holds no session %q: %+v", issued, index)
		}
	}
}

// An attachment naming no session is refused.
//
// Deriving one from the coordinate is the failure above. Refusing is what leaves the caller to say
// which session it meant.
func TestAnAttachmentWithNoSessionIsRefused(t *testing.T) {
	store := &memoryStore{}
	err := Attach(store, Attachment{Owner: "an-owner", ViewID: "v1", WindowLabel: "main"})
	if err == nil {
		t.Fatal("an attachment naming no session was stored")
	}

	index, readErr := ReadIndex(store)
	if readErr != nil {
		t.Fatalf("reading the index: %v", readErr)
	}
	if len(index) != 0 {
		t.Fatalf("the index holds %+v after a refusal", index)
	}
}

// The coordinate is stored beside the id, never in place of it.
//
// A lookup by coordinate that finds nothing falls to the recorded id, so a session whose view moved
// is still addressable. That only works while both are kept.
func TestTheCoordinateIsStoredBesideTheId(t *testing.T) {
	store := &memoryStore{}
	if err := Attach(store, Attachment{
		Session: "7", Owner: "an-owner", ViewID: "v1", WindowLabel: "main",
	}); err != nil {
		t.Fatal(err)
	}
	// The view moved to another window, which is what a restore or a drag does.
	if err := Attach(store, Attachment{
		Session: "7", Owner: "an-owner", ViewID: "v2", WindowLabel: "w-two",
	}); err != nil {
		t.Fatal(err)
	}

	index, err := ReadIndex(store)
	if err != nil {
		t.Fatal(err)
	}
	if len(index) != 1 {
		t.Fatalf("the index holds %d entries, want the one session: %+v", len(index), index)
	}
	if index[0].Session != "7" || index[0].ViewID != "v2" || index[0].WindowLabel != "w-two" {
		t.Fatalf("the moved session reads %+v", index[0])
	}
	// And the id is not built out of the coordinate it now carries.
	if strings.Contains(index[0].Session, index[0].WindowLabel) ||
		strings.Contains(index[0].Session, index[0].ViewID) {
		t.Fatalf("the stored id was derived from the coordinate: %+v", index[0])
	}
}
