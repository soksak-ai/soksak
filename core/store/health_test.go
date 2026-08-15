package store

import (
	"path/filepath"
	"strings"
	"testing"
)

// A healthy store reports no problems. SQLite answers a clean check with the
// single row "ok", which is not a problem.
func TestAHealthyStoreReportsNothing(t *testing.T) {
	problems := seeded(t).Verify()
	if len(problems) != 0 {
		t.Errorf("problems = %v, want none", problems)
	}
}

// A diagnosis that cannot finish returns a list naming the failure, never an
// error. Throwing it makes "the store is sick" read as "the command failed" —
// that misreading was measured exactly.
func TestADiagnosisThatCannotFinishStillAnswersWithAList(t *testing.T) {
	kv, err := OpenKV(filepath.Join(t.TempDir(), "soksak.db"))
	if err != nil {
		t.Fatalf("opening: %v", err)
	}
	if err := kv.Close(); err != nil {
		t.Fatalf("closing: %v", err)
	}
	problems := kv.Verify()
	if len(problems) == 0 {
		t.Fatal("a store that cannot be read reported nothing wrong")
	}
	if !strings.Contains(problems[0], "diagnosis failed") {
		t.Errorf("problems = %v, want the first to name the failure", problems)
	}
}

// Verify reads and nothing else.
func TestVerifyChangesNothing(t *testing.T) {
	kv := seeded(t)
	before := rowCounts(t, kv)
	kv.Verify()
	if after := rowCounts(t, kv); after != before {
		t.Errorf("counts moved from %v to %v", before, after)
	}
}

// Repair never creates or deletes rows: it rebuilds indexes from the tables.
func TestRepairCreatesAndDeletesNoRows(t *testing.T) {
	kv := seeded(t)
	before := rowCounts(t, kv)
	outcome, err := kv.Repair()
	if err != nil {
		t.Fatalf("repairing: %v", err)
	}
	if after := rowCounts(t, kv); after != before {
		t.Errorf("counts moved from %v to %v", before, after)
	}
	if len(outcome.After) != 0 {
		t.Errorf("after = %v, want none on a healthy store", outcome.After)
	}
	if outcome.ReindexError != nil {
		t.Errorf("reindexError = %v, want none on a store that needed no reindex", *outcome.ReindexError)
	}
}

// Repair shows what is left rather than claiming a heal. On a store nothing can
// be done to, the answer is the failure, not silence.
func TestRepairOnAStoreItCannotReachAnswersByName(t *testing.T) {
	kv, err := OpenKV(filepath.Join(t.TempDir(), "soksak.db"))
	if err != nil {
		t.Fatalf("opening: %v", err)
	}
	if err := kv.Close(); err != nil {
		t.Fatalf("closing: %v", err)
	}
	outcome, err := kv.Repair()
	if err != nil {
		t.Fatalf("repairing: %v", err)
	}
	if len(outcome.Before) == 0 || len(outcome.After) == 0 {
		t.Errorf("outcome = %+v, want the remaining problems carried", outcome)
	}
}

type counts struct{ records, keys, definitions int }

func rowCounts(t *testing.T, kv *KV) counts {
	t.Helper()
	var found counts
	for statement, into := range map[string]*int{
		`SELECT COUNT(*) FROM records`:          &found.records,
		`SELECT COUNT(*) FROM kv`:               &found.keys,
		`SELECT COUNT(*) FROM meta_collections`: &found.definitions,
	} {
		if err := kv.db.QueryRow(statement).Scan(into); err != nil {
			t.Fatalf("counting: %v", err)
		}
	}
	return found
}

// Damage is planted and measured, not waited for. A gate that only ever sees a
// healthy store cannot be told apart from a gate with its eyes shut.
//
// The shape planted is the one measured (2026-07-13): a logical
// disagreement between an index and the table it indexes, not a broken page.
// The pages are fine, so quick_check passes — and that is why the diagnosis
// here is the full check. This test asserts both halves, because the cheaper
// pragma looks identical on a healthy store.
func desyncOneIndex(t *testing.T, kv *KV) string {
	t.Helper()
	if err := kv.Define("mailbox", "messages", []string{"issue"}, nil); err != nil {
		t.Fatalf("defining: %v", err)
	}
	for index := 0; index < 100; index++ {
		id := string(rune('a'+index%26)) + string(rune('a'+index/26))
		doc := document(t, `{"issue":"i-`+id+`","other":"o-`+id+`"}`)
		if _, err := kv.Put("mailbox", "messages", "s", id, doc, 10); err != nil {
			t.Fatalf("putting: %v", err)
		}
	}
	// The entries stay as they were written; only the declaration moves to
	// another field, so every one of them is now in the wrong place.
	damaged := indexName(1, "issue")
	if _, err := kv.db.Exec(`PRAGMA writable_schema=ON`); err != nil {
		t.Fatalf("planting: %v", err)
	}
	_, err := kv.db.Exec(`UPDATE sqlite_schema SET sql=? WHERE name=?`,
		`CREATE INDEX `+damaged+` ON records(ns, coll, json_extract(doc, '$.other'))`, damaged)
	if err != nil {
		t.Fatalf("planting: %v", err)
	}
	if _, err := kv.db.Exec(`PRAGMA writable_schema=OFF`); err != nil {
		t.Fatalf("planting: %v", err)
	}
	return damaged
}

func TestPlantedDamageIsInvisibleToTheCheapCheckAndNamedByVerify(t *testing.T) {
	kv := open(t)
	damaged := desyncOneIndex(t, kv)
	// The schema is reparsed on a fresh handle.
	path := kv.Path()
	if err := kv.Close(); err != nil {
		t.Fatalf("closing: %v", err)
	}
	reopened, err := OpenKV(path)
	if err != nil {
		t.Fatalf("reopening: %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })

	var quick string
	if err := reopened.db.QueryRow(`PRAGMA quick_check`).Scan(&quick); err != nil {
		t.Fatalf("checking: %v", err)
	}
	if quick != "ok" {
		t.Errorf("quick_check = %q; if it sees this shape, the reason for the full check is gone", quick)
	}
	problems := reopened.Verify()
	if len(problems) == 0 {
		t.Fatal("verify reported nothing about a store whose index no longer matches its table")
	}
	if !strings.Contains(problems[0], damaged) {
		t.Errorf("problems[0] = %q, want it to name %s", problems[0], damaged)
	}
}

// Repair rebuilds the index and says so by showing nothing left, and the
// records are all still there: it rebuilds from the table, it does not discard.
func TestRepairRebuildsADesyncedIndex(t *testing.T) {
	kv := open(t)
	desyncOneIndex(t, kv)
	path := kv.Path()
	if err := kv.Close(); err != nil {
		t.Fatalf("closing: %v", err)
	}
	reopened, err := OpenKV(path)
	if err != nil {
		t.Fatalf("reopening: %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })

	outcome, err := reopened.Repair()
	if err != nil {
		t.Fatalf("repairing: %v", err)
	}
	if len(outcome.Before) == 0 {
		t.Error("before = none, want the damage the repair was called on")
	}
	if len(outcome.After) != 0 {
		t.Errorf("after = %v, want nothing left", outcome.After)
	}
	total, err := reopened.Count(QueryRequest{Ns: "mailbox", Coll: "messages"})
	if err != nil {
		t.Fatalf("counting: %v", err)
	}
	if total != 100 {
		t.Errorf("records = %d, want the 100 that were there: a repair discards nothing", total)
	}
}
