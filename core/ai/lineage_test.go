package ai

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/soksak/soksak-core/core/store"
)

// The lineage tests run against the real store rather than a stub of it. What
// is being fixed here is a query — a scope, a filter on a declared index, and
// an order — and every one of those is a claim about what the store does.

func openLineage(t *testing.T) *store.KV {
	t.Helper()
	kv, err := store.OpenKV(filepath.Join(t.TempDir(), "soksak.db"))
	if err != nil {
		t.Fatalf("opening the store: %v", err)
	}
	t.Cleanup(func() { _ = kv.Close() })
	// The frontend declares the collection before it writes the first
	// transition; the query only reads what the writer defined.
	if err := kv.Define(lineageNamespace, lineageCollection, []string{"viewId"}, nil); err != nil {
		t.Fatalf("defining the collection: %v", err)
	}
	return kv
}

func putTransition(t *testing.T, kv *store.KV, cwd, id, viewID, from, to string, atMillis int64) {
	t.Helper()
	document := map[string]json.RawMessage{
		"viewId":      json.RawMessage(`"` + viewID + `"`),
		"fromSession": json.RawMessage(`"` + from + `"`),
		"toSession":   json.RawMessage(`"` + to + `"`),
		"kind":        json.RawMessage(`"claude"`),
	}
	if _, err := kv.Put(lineageNamespace, lineageCollection, cwd, id, document, atMillis); err != nil {
		t.Fatalf("writing a transition: %v", err)
	}
}

func toSessions(t *testing.T, rows []json.RawMessage) []string {
	t.Helper()
	sessions := make([]string, 0, len(rows))
	for _, row := range rows {
		var record struct {
			To string `json:"toSession"`
		}
		if err := json.Unmarshal(row, &record); err != nil {
			t.Fatalf("reading a row: %v", err)
		}
		sessions = append(sessions, record.To)
	}
	return sessions
}

// TestLineageIsOldestFirst. The chain from→to in time order is the flow, and a
// flow read backwards is a different story about what happened.
func TestLineageIsOldestFirst(t *testing.T) {
	kv := openLineage(t)
	const cwd = "<machine-path>/proj"
	putTransition(t, kv, cwd, "c", "pane-1", sessionIDs[1], sessionIDs[2], 300)
	putTransition(t, kv, cwd, "a", "pane-1", "", sessionIDs[0], 100)
	putTransition(t, kv, cwd, "b", "pane-2", sessionIDs[0], sessionIDs[1], 200)

	rows, err := Lineage(kv, cwd, "")
	if err != nil {
		t.Fatalf("Lineage: %v", err)
	}
	got := toSessions(t, rows)
	want := []string{sessionIDs[0], sessionIDs[1], sessionIDs[2]}
	if len(got) != len(want) {
		t.Fatalf("Lineage returned %d rows, want %d", len(got), len(want))
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("row %d = %q, want %q", index, got[index], want[index])
		}
	}
}

// TestLineageIsScopedToOneWorkingDirectory. Two projects share one process and
// one collection; a scope that leaked would show another project's forks.
func TestLineageIsScopedToOneWorkingDirectory(t *testing.T) {
	kv := openLineage(t)
	putTransition(t, kv, "<machine-path>/one", "a", "pane-1", "", sessionIDs[0], 100)
	putTransition(t, kv, "<machine-path>/two", "b", "pane-2", "", sessionIDs[1], 200)

	rows, err := Lineage(kv, "<machine-path>/one", "")
	if err != nil {
		t.Fatalf("Lineage: %v", err)
	}
	if got := toSessions(t, rows); len(got) != 1 || got[0] != sessionIDs[0] {
		t.Fatalf("Lineage = %v, want only this directory's transition", got)
	}
}

// TestLineageNarrowsToOneTab when the caller names one, and to all of them when
// it does not.
func TestLineageNarrowsToOneTab(t *testing.T) {
	kv := openLineage(t)
	const cwd = "<machine-path>/proj"
	putTransition(t, kv, cwd, "a", "pane-1", "", sessionIDs[0], 100)
	putTransition(t, kv, cwd, "b", "pane-2", "", sessionIDs[1], 200)

	rows, err := Lineage(kv, cwd, "pane-2")
	if err != nil {
		t.Fatalf("Lineage: %v", err)
	}
	if got := toSessions(t, rows); len(got) != 1 || got[0] != sessionIDs[1] {
		t.Fatalf("Lineage(pane-2) = %v, want only that tab's transition", got)
	}

	rows, err = Lineage(kv, cwd, "")
	if err != nil {
		t.Fatalf("Lineage: %v", err)
	}
	if got := toSessions(t, rows); len(got) != 2 {
		t.Fatalf("Lineage(every tab) = %v, want both", got)
	}
}

// TestAnEmptyLineageIsAListRatherThanNothing. A caller reading `.length` off a
// null takes the whole page down, and "nothing was recorded" must not arrive
// looking like "this build cannot tell you".
func TestAnEmptyLineageIsAListRatherThanNothing(t *testing.T) {
	rows, err := Lineage(openLineage(t), "<machine-path>/never", "")
	if err != nil {
		t.Fatalf("Lineage: %v", err)
	}
	if rows == nil {
		t.Fatal("an empty lineage answered null")
	}
	if len(rows) != 0 {
		t.Fatalf("Lineage = %v, want no rows", rows)
	}
}

// TestLineageRefusesAWorkingDirectoryItCannotHaveRecorded. The scope is the
// same string the tracker was armed with, and that one is checked before any
// agent tree is touched — so a working directory this group would have refused
// to watch cannot have a history here either. Answering an empty list would say
// the agent left no forks behind.
func TestLineageRefusesAWorkingDirectoryItCannotHaveRecorded(t *testing.T) {
	kv := openLineage(t)
	for _, cwd := range []string{"", "proj", "../proj"} {
		if _, err := Lineage(kv, cwd, ""); err == nil {
			t.Errorf("Lineage(%q) answered; want a refusal", cwd)
		}
	}
}
