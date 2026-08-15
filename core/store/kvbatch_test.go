package store

import (
	"strings"
	"testing"
)

// The prefix is a literal prefix, not a LIKE pattern. A key holding `%` or `_`
// otherwise drags its neighbours in, and the caller cannot tell.
func TestThePrefixIsLiteralNotAPattern(t *testing.T) {
	kv := open(t)
	for _, key := range []string{"a_b", "axb", "a%c", "b1"} {
		if err := kv.Set("ui", key, "1"); err != nil {
			t.Fatalf("writing %s: %v", key, err)
		}
	}
	keys, err := kv.Keys("ui", stringPointer("a_"))
	if err != nil {
		t.Fatalf("listing: %v", err)
	}
	if len(keys) != 1 || keys[0] != "a_b" {
		t.Errorf("keys = %v, want only a_b — `_` matched any character", keys)
	}
}

func TestKeysAreSortedAndCompleteWithNoPrefix(t *testing.T) {
	kv := open(t)
	for _, key := range []string{"c", "a", "b"} {
		if err := kv.Set("ui", key, "1"); err != nil {
			t.Fatalf("writing: %v", err)
		}
	}
	keys, err := kv.Keys("ui", nil)
	if err != nil {
		t.Fatalf("listing: %v", err)
	}
	if strings.Join(keys, ",") != "a,b,c" {
		t.Errorf("keys = %v", keys)
	}
}

// A namespace with no keys is an empty list, not a failure.
func TestAnEmptyNamespaceListsNothing(t *testing.T) {
	keys, err := open(t).Keys("ui", nil)
	if err != nil {
		t.Fatalf("listing an untouched namespace: %v", err)
	}
	if len(keys) != 0 {
		t.Errorf("keys = %v", keys)
	}
}

// Keys and values come from one query. A keys-then-N-gets path lets other
// writers interleave, and the caller assembles a state that never existed.
func TestEntriesComeFromOneSnapshot(t *testing.T) {
	kv := open(t)
	if err := kv.Set("ui", "theme", `"Midnight"`); err != nil {
		t.Fatalf("writing: %v", err)
	}
	result, err := kv.Entries("ui", nil)
	if err != nil {
		t.Fatalf("reading entries: %v", err)
	}
	if result.Ns != "ui" || len(result.Entries) != 1 {
		t.Fatalf("entries = %+v", result)
	}
	if result.Entries[0].Key != "theme" || string(result.Entries[0].Value) != `"Midnight"` {
		t.Errorf("entry = %+v", result.Entries[0])
	}
}

// Broken JSON is an error naming where it is. Folding it into absence erases
// the difference from a missing key, and the caller uses a default and never
// sees the damage.
func TestAValueThatIsNotJSONIsNamed(t *testing.T) {
	kv := open(t)
	if err := kv.Set("ui", "theme", `{not json`); err != nil {
		t.Fatalf("writing: %v", err)
	}
	_, err := kv.Entries("ui", nil)
	if err == nil {
		t.Fatal("a corrupted value was returned as a value")
	}
	if !strings.Contains(err.Error(), "ui") || !strings.Contains(err.Error(), "theme") {
		t.Errorf("error = %v, want one naming the namespace and the key", err)
	}
}

// Every key is validated and de-duplicated before the transaction opens, so a
// bad input cannot leave half a batch applied.
func TestABatchWithABadKeyDeletesNothing(t *testing.T) {
	kv := open(t)
	for _, key := range []string{"a", "b", "c", "d", "e"} {
		if err := kv.Set("ui", key, "1"); err != nil {
			t.Fatalf("writing: %v", err)
		}
	}
	if _, err := kv.DeleteMany("ui", []string{"a", "b", "", "d", "e"}); err == nil {
		t.Fatal("a batch holding an empty key was accepted")
	}
	keys, err := kv.Keys("ui", nil)
	if err != nil {
		t.Fatalf("listing: %v", err)
	}
	if len(keys) != 5 {
		t.Errorf("%d keys survived a refused batch, want 5", len(keys))
	}
}

func TestABatchCountsDeduplicatedKeys(t *testing.T) {
	kv := open(t)
	if err := kv.Set("ui", "a", "1"); err != nil {
		t.Fatalf("writing: %v", err)
	}
	result, err := kv.DeleteMany("ui", []string{"a", "a", "b"})
	if err != nil {
		t.Fatalf("deleting: %v", err)
	}
	if result.Requested != 2 || result.Deleted != 1 || result.Absent != 1 {
		t.Errorf("result = %+v, want requested 2, deleted 1, absent 1", result)
	}
}

// The cap is enforced at the store boundary rather than only at a catalogue:
// trusting catalogue validation lets an internal call skip the boundary.
func TestABatchOverTheCapIsRefusedAndDeletesNothing(t *testing.T) {
	kv := open(t)
	if err := kv.Set("ui", "a", "1"); err != nil {
		t.Fatalf("writing: %v", err)
	}
	keys := make([]string, maxBatchKeys+1)
	for index := range keys {
		keys[index] = string(rune('a'+index%26)) + string(rune('a'+index/26))
	}
	keys[0] = "a"
	if _, err := kv.DeleteMany("ui", keys); err == nil {
		t.Fatal("a batch over the cap was accepted")
	}
	if _, found, _ := kv.Get("ui", "a"); !found {
		t.Error("a refused batch still deleted")
	}
}

func TestAnEmptyBatchIsRefused(t *testing.T) {
	if _, err := open(t).DeleteMany("ui", nil); err == nil {
		t.Fatal("an empty batch was accepted")
	}
}

// Deleting one key answers whether it was there. Both answers are ordinary.
func TestDeleteOneAnswersWhetherItWasThere(t *testing.T) {
	kv := open(t)
	if err := kv.Set("ui", "theme", "1"); err != nil {
		t.Fatalf("writing: %v", err)
	}
	removed, err := kv.DeleteKey("ui", "theme")
	if err != nil || !removed {
		t.Fatalf("deleting a present key: removed=%v err=%v", removed, err)
	}
	removed, err = kv.DeleteKey("ui", "theme")
	if err != nil {
		t.Fatalf("deleting again: %v", err)
	}
	if removed {
		t.Error("removed = true for a key that was already gone")
	}
}
