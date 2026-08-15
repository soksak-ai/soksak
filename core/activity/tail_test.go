package activity

import (
	"encoding/json"
	"testing"
)

func kept(t *testing.T, tail *Tail, kinds ...string) {
	t.Helper()
	for index, kind := range kinds {
		tail.Keep(Entry{Seq: uint64(index + 1), Kind: kind, Source: "renderer"})
	}
}

func TestTheNewestEntryComesFirst(t *testing.T) {
	// The reason anyone reads it is that something just went wrong. Oldest-first
	// would put the answer at the end of whatever they are reading.
	tail := NewTail(0)
	kept(t, tail, "a", "b", "c")

	recent := tail.Recent(nil, 0)
	if len(recent) != 3 {
		t.Fatalf("kept %d entries", len(recent))
	}
	if recent[0].Kind != "c" {
		t.Errorf("the first answer was %q, want the newest", recent[0].Kind)
	}
}

func TestTheOldestIsDroppedRatherThanTheNewest(t *testing.T) {
	// A full buffer that refuses new entries reports the beginning of an
	// incident forever while the current state stays invisible.
	tail := NewTail(3)
	kept(t, tail, "1", "2", "3", "4", "5")

	if tail.Len() != 3 {
		t.Fatalf("held %d entries, want the bound", tail.Len())
	}
	recent := tail.Recent(nil, 0)
	if recent[0].Kind != "5" {
		t.Errorf("newest = %q", recent[0].Kind)
	}
	for _, entry := range recent {
		if entry.Kind == "1" || entry.Kind == "2" {
			t.Errorf("a dropped entry survived: %q", entry.Kind)
		}
	}
}

func TestAsManyEntriesAsAskedFor(t *testing.T) {
	tail := NewTail(0)
	kept(t, tail, "a", "b", "c", "d")

	if recent := tail.Recent(nil, 2); len(recent) != 2 {
		t.Errorf("asked for 2 and received %d", len(recent))
	}
	// Zero is not "none": a caller that omits the limit wants what there is.
	if recent := tail.Recent(nil, 0); len(recent) != 4 {
		t.Errorf("no limit answered %d entries", len(recent))
	}
}

func TestOnlyTheKindsAskedFor(t *testing.T) {
	tail := NewTail(0)
	kept(t, tail, "renderer.error", "command.ran", "renderer.error")

	recent := tail.Recent([]string{"renderer.error"}, 0)
	if len(recent) != 2 {
		t.Fatalf("filtered to %d entries", len(recent))
	}
	for _, entry := range recent {
		if entry.Kind != "renderer.error" {
			t.Errorf("an unasked kind came back: %q", entry.Kind)
		}
	}
	// Filtering to nothing means every kind. A caller who passes an empty list
	// wants everything, and silence would look like nothing had happened.
	if recent := tail.Recent([]string{}, 0); len(recent) != 3 {
		t.Errorf("an empty filter answered %d entries", len(recent))
	}
}

func TestAnAnswerDoesNotChangeUnderTheCaller(t *testing.T) {
	// The buffer keeps moving. A caller handed a view of it would see entries
	// replaced while it read them.
	tail := NewTail(2)
	kept(t, tail, "a", "b")

	recent := tail.Recent(nil, 0)
	kept(t, tail, "c", "d")

	if recent[0].Kind != "b" || recent[1].Kind != "a" {
		t.Errorf("an earlier answer changed: %+v", recent)
	}
}

func TestThePayloadSurvives(t *testing.T) {
	// The message is the whole point: an entry that keeps its kind and drops
	// what it said reports that something failed and never what.
	tail := NewTail(0)
	tail.Keep(Entry{
		Seq:     1,
		Kind:    "renderer.error",
		Payload: json.RawMessage(`{"error":"dialog.openDirectory is not served"}`),
	})

	recent := tail.Recent([]string{"renderer.error"}, 1)
	if len(recent) != 1 {
		t.Fatal("the entry was not kept")
	}
	var payload struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(recent[0].Payload, &payload); err != nil {
		t.Fatalf("decoding the payload: %v", err)
	}
	if payload.Error == "" {
		t.Error("the entry kept its kind and lost what it said")
	}
}
