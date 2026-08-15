package store

import (
	"strings"
	"testing"
)

// Trim evicts the oldest by created, and the record's search row goes with it —
// a search afterwards must not answer with a ghost hit for a record that is
// gone.
func TestTrimEvictsWholeRecords(t *testing.T) {
	kv := open(t)
	if err := kv.Define("mailbox", "messages", nil, []string{"title"}); err != nil {
		t.Fatalf("defining: %v", err)
	}
	for index, title := range []string{"first record", "second record", "third record"} {
		doc := document(t, `{"title":"`+title+`"}`)
		if _, err := kv.Put("mailbox", "messages", "s", string(rune('a'+index)), doc, int64(10+index)); err != nil {
			t.Fatalf("putting: %v", err)
		}
	}
	deleted, err := kv.Trim("mailbox", "messages", "s", 1)
	if err != nil {
		t.Fatalf("trimming: %v", err)
	}
	if deleted != 2 {
		t.Errorf("deleted = %d, want 2", deleted)
	}
	var indexed int
	if err := kv.db.QueryRow(`SELECT COUNT(*) FROM fts_1`).Scan(&indexed); err != nil {
		t.Fatalf("counting index rows: %v", err)
	}
	if indexed != 1 {
		t.Errorf("%d index rows survived for 1 record", indexed)
	}
	hits, err := kv.Search("mailbox", "messages", "first", nil, nil)
	if err != nil {
		t.Fatalf("searching: %v", err)
	}
	if len(hits) != 0 {
		t.Errorf("an evicted record still answers a search: %v", hits)
	}
}

// FIFO is by created, never by updated. An update moves updated, and evicting
// by it would make the order nondeterministic.
func TestTrimEvictsByCreatedNotUpdated(t *testing.T) {
	kv := open(t)
	if _, err := kv.Put("mailbox", "messages", "s", "old", document(t, `{"n":1}`), 10); err != nil {
		t.Fatalf("putting: %v", err)
	}
	if _, err := kv.Put("mailbox", "messages", "s", "new", document(t, `{"n":2}`), 20); err != nil {
		t.Fatalf("putting: %v", err)
	}
	// Touching the older record moves its updated past the newer one's.
	if _, err := kv.Put("mailbox", "messages", "s", "old", document(t, `{"n":3}`), 30); err != nil {
		t.Fatalf("touching: %v", err)
	}
	if _, err := kv.Trim("mailbox", "messages", "s", 1); err != nil {
		t.Fatalf("trimming: %v", err)
	}
	if _, found, _ := kv.GetDocument("mailbox", "messages", "new", nil); !found {
		t.Error("the later-created record was evicted — the order followed updated")
	}
}

// Trim only sees its own scope: another scope's records are not this cap's to
// evict.
func TestTrimStaysInsideItsScope(t *testing.T) {
	kv := open(t)
	if _, err := kv.Put("mailbox", "messages", "a", "x1", document(t, `{"n":1}`), 10); err != nil {
		t.Fatalf("putting: %v", err)
	}
	if _, err := kv.Put("mailbox", "messages", "b", "x2", document(t, `{"n":2}`), 11); err != nil {
		t.Fatalf("putting: %v", err)
	}
	if _, err := kv.Trim("mailbox", "messages", "a", 0); err != nil {
		t.Fatalf("trimming: %v", err)
	}
	if _, found, _ := kv.GetDocument("mailbox", "messages", "x2", nil); !found {
		t.Error("trimming one scope evicted another's record")
	}
}

// A cap nothing exceeds deletes nothing, and says so.
func TestTrimUnderTheCapDeletesNothing(t *testing.T) {
	kv := open(t)
	if _, err := kv.Put("mailbox", "messages", "s", "x1", document(t, `{"n":1}`), 10); err != nil {
		t.Fatalf("putting: %v", err)
	}
	deleted, err := kv.Trim("mailbox", "messages", "s", 10)
	if err != nil {
		t.Fatalf("trimming: %v", err)
	}
	if deleted != 0 {
		t.Errorf("deleted = %d, want 0", deleted)
	}
}

// Reap is the time axis and is scope-independent: it reaps the collection.
func TestReapCrossesScopesAndTakesWholeRecords(t *testing.T) {
	kv := open(t)
	if err := kv.Define("mailbox", "messages", nil, []string{"title"}); err != nil {
		t.Fatalf("defining: %v", err)
	}
	if _, err := kv.Put("mailbox", "messages", "a", "old", document(t, `{"title":"old record"}`), 10); err != nil {
		t.Fatalf("putting: %v", err)
	}
	if _, err := kv.Put("mailbox", "messages", "b", "new", document(t, `{"title":"new record"}`), 100); err != nil {
		t.Fatalf("putting: %v", err)
	}
	deleted, err := kv.Reap("mailbox", "messages", 50)
	if err != nil {
		t.Fatalf("reaping: %v", err)
	}
	if deleted != 1 {
		t.Errorf("deleted = %d, want 1", deleted)
	}
	if _, found, _ := kv.GetDocument("mailbox", "messages", "old", nil); found {
		t.Error("a record older than the cutoff survived")
	}
	hits, err := kv.Search("mailbox", "messages", "old", nil, nil)
	if err != nil {
		t.Fatalf("searching: %v", err)
	}
	if len(hits) != 0 {
		t.Errorf("a reaped record still answers a search: %v", hits)
	}
}

// A logical delete does not shrink the file, so the reap returns pages after
// it. The store is born auto_vacuum=INCREMENTAL, which is what makes that
// bounded return possible at all rather than a full rewrite under a lock.
//
// The trim beside it is the control: the same rows, the same delete path, no
// reclaim — its pages stay on the freelist and the file keeps its size. Without
// that half, a store born auto_vacuum=NONE passes this by answering nothing.
func TestReapReturnsPagesAndTrimDoesNot(t *testing.T) {
	filler := strings.Repeat("0123456789", 160)
	fill := func(t *testing.T, kv *KV) {
		t.Helper()
		for index := 0; index < 400; index++ {
			id := string(rune('a'+index%26)) + string(rune('a'+index/26))
			if _, err := kv.Put("mailbox", "messages", "s", id, document(t, `{"filler":"`+filler+`"}`), 10); err != nil {
				t.Fatalf("putting: %v", err)
			}
		}
	}
	pages := func(t *testing.T, kv *KV, pragma string) int {
		t.Helper()
		var count int
		if err := kv.db.QueryRow("PRAGMA " + pragma).Scan(&count); err != nil {
			t.Fatalf("reading %s: %v", pragma, err)
		}
		return count
	}

	reaped := open(t)
	fill(t, reaped)
	before := pages(t, reaped, "page_count")
	if _, err := reaped.Reap("mailbox", "messages", 50); err != nil {
		t.Fatalf("reaping: %v", err)
	}
	after := pages(t, reaped, "page_count")
	if after >= before {
		t.Errorf("the file holds %d pages after the reap and held %d, want fewer", after, before)
	}

	trimmed := open(t)
	fill(t, trimmed)
	held := pages(t, trimmed, "page_count")
	if _, err := trimmed.Trim("mailbox", "messages", "s", 0); err != nil {
		t.Fatalf("trimming: %v", err)
	}
	if pages(t, trimmed, "page_count") != held {
		t.Error("a trim shrank the file, so the reap's reclaim is not what shrinks it")
	}
	if free := pages(t, trimmed, "freelist_count"); free == 0 {
		t.Error("a trim freed no pages, so this control says nothing about the reap")
	}
}

// A trim that asks to keep fewer than no records is refused rather than read.
// The statement takes `count - cap` rows, so -1 empties the scope and answers
// with how many it took — a caller who meant "no limit" loses everything.
func TestATrimAskingToKeepLessThanNothingIsRefused(t *testing.T) {
	kv := open(t)
	for _, id := range []string{"x1", "x2", "x3"} {
		if _, err := kv.Put("mailbox", "messages", "s", id, document(t, `{"n":1}`), 10); err != nil {
			t.Fatalf("putting: %v", err)
		}
	}
	deleted, err := kv.Trim("mailbox", "messages", "s", -1)
	if err == nil {
		t.Fatalf("a cap of -1 was accepted and took %d records", deleted)
	}
	total, err := kv.Count(QueryRequest{Ns: "mailbox", Coll: "messages"})
	if err != nil {
		t.Fatalf("counting: %v", err)
	}
	if total != 3 {
		t.Errorf("records = %d, want the 3 a refused trim leaves", total)
	}
}

// The cutoff is exclusive: a record created at exactly that millisecond is not
// older than it. Both sides of the boundary are pinned because either one alone
// passes with the comparison the other way round.
func TestReapKeepsARecordCreatedAtTheCutoff(t *testing.T) {
	kv := open(t)
	if _, err := kv.Put("mailbox", "messages", "s", "at", document(t, `{"n":1}`), 50); err != nil {
		t.Fatalf("putting: %v", err)
	}
	if _, err := kv.Put("mailbox", "messages", "s", "before", document(t, `{"n":1}`), 49); err != nil {
		t.Fatalf("putting: %v", err)
	}
	deleted, err := kv.Reap("mailbox", "messages", 50)
	if err != nil {
		t.Fatalf("reaping: %v", err)
	}
	if deleted != 1 {
		t.Errorf("deleted = %d, want only the record before the cutoff", deleted)
	}
	if _, found, _ := kv.GetDocument("mailbox", "messages", "at", nil); !found {
		t.Error("the record created at the cutoff was reaped")
	}
}
