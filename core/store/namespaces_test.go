package store

import (
	"strings"
	"testing"
)

// Removing a namespace removes everything that namespace made and nothing
// else. Never touching another namespace is the only safety this deletion has.
func TestRemovingANamespaceLeavesItsNeighbourUntouched(t *testing.T) {
	kv := open(t)
	if err := kv.Define("plugin-probe", "t", []string{"issue"}, []string{"title"}); err != nil {
		t.Fatalf("defining: %v", err)
	}
	if err := kv.Define("plugin-keeper", "t", []string{"issue"}, nil); err != nil {
		t.Fatalf("defining: %v", err)
	}
	if _, err := kv.Put("plugin-probe", "t", "s", "x1", document(t, `{"issue":"i-1","title":"probe"}`), 10); err != nil {
		t.Fatalf("putting: %v", err)
	}
	if _, err := kv.Put("plugin-keeper", "t", "s", "y1", document(t, `{"issue":"i-2"}`), 10); err != nil {
		t.Fatalf("putting: %v", err)
	}
	if err := kv.Set("plugin-probe", "k", "1"); err != nil {
		t.Fatalf("writing: %v", err)
	}
	if err := kv.Set("plugin-keeper", "k", "1"); err != nil {
		t.Fatalf("writing: %v", err)
	}

	removal, err := kv.RemoveNamespace("plugin-probe")
	if err != nil {
		t.Fatalf("removing: %v", err)
	}
	if removal.Ns != "plugin-probe" || removal.Collections != 1 || removal.Records != 1 || removal.KV != 1 {
		t.Errorf("removal = %+v", removal)
	}
	for _, name := range []string{"fts_1", "idx_1_issue"} {
		var count int
		err := kv.db.QueryRow(
			`SELECT COUNT(*) FROM sqlite_master WHERE name=?`, name).Scan(&count)
		if err != nil {
			t.Fatalf("looking for %s: %v", name, err)
		}
		if count != 0 {
			t.Errorf("%s survived the removal", name)
		}
	}
	var kept int
	if err := kv.db.QueryRow(
		`SELECT COUNT(*) FROM sqlite_master WHERE name='idx_2_issue'`).Scan(&kept); err != nil {
		t.Fatalf("looking for the neighbour's index: %v", err)
	}
	if kept != 1 {
		t.Error("the neighbouring namespace's index was removed with it")
	}
	if _, found, _ := kv.GetDocument("plugin-keeper", "t", "y1", nil); !found {
		t.Error("the neighbouring namespace's record was removed with it")
	}
}

// Deletion does not check the syntax of the name. A measurement found a
// namespace that an unvalidated import planted and the delete surface then
// refused as invalid — a name that got in and could not get out. Deletion only
// removes what exists, so the syntax rule protects nothing here.
func TestANamespaceTheRulesForbidCanStillBeRemoved(t *testing.T) {
	kv := open(t)
	if _, err := kv.db.Exec(
		`INSERT INTO kv(ns,k,v,updated) VALUES('plugin:probe-lane','k','1',0)`); err != nil {
		t.Fatalf("planting: %v", err)
	}
	removal, err := kv.RemoveNamespace("plugin:probe-lane")
	if err != nil {
		t.Fatalf("removing a name the rules forbid: %v", err)
	}
	if removal.KV != 1 {
		t.Errorf("removal = %+v, want the planted row counted", removal)
	}
}

// A namespace with nothing in it is zeros, not an error — twice over.
func TestRemovingNothingIsNotAFailure(t *testing.T) {
	kv := open(t)
	for attempt := 0; attempt < 2; attempt++ {
		removal, err := kv.RemoveNamespace("plugin-absent")
		if err != nil {
			t.Fatalf("removal %d: %v", attempt, err)
		}
		if removal.Collections != 0 || removal.Records != 0 || removal.KV != 0 {
			t.Errorf("removal = %+v, want zeros", removal)
		}
	}
}

// Migration re-points the rows and leaves the source empty, so calling it again
// answers source-empty rather than moving anything twice.
func TestMigrationMovesEverythingAndIsIdempotent(t *testing.T) {
	kv := open(t)
	if err := kv.Define("plugin-old", "t", []string{"issue"}, nil); err != nil {
		t.Fatalf("defining: %v", err)
	}
	if _, err := kv.Put("plugin-old", "t", "s", "x1", document(t, `{"issue":"i-1"}`), 10); err != nil {
		t.Fatalf("putting: %v", err)
	}
	if err := kv.Set("plugin-old", "k", "1"); err != nil {
		t.Fatalf("writing: %v", err)
	}

	outcome, err := kv.MigrateNamespace("plugin-old", "plugin-new")
	if err != nil {
		t.Fatalf("migrating: %v", err)
	}
	if !outcome.Migrated || outcome.Reason != "moved" {
		t.Fatalf("outcome = %+v", outcome)
	}
	if _, found, _ := kv.GetDocument("plugin-new", "t", "x1", nil); !found {
		t.Error("the record is not visible under the new namespace")
	}
	if _, found, _ := kv.Get("plugin-new", "k"); !found {
		t.Error("the key is not visible under the new namespace")
	}
	if _, found, _ := kv.GetDocument("plugin-old", "t", "x1", nil); found {
		t.Error("the record is still visible under the old namespace")
	}

	// The expression index is on records, whose ns the migration updated, so
	// a filtered query under the new name still rides it.
	docs, err := kv.Query(QueryRequest{
		Ns: "plugin-new", Coll: "t", Filter: filterOf(t, `{"issue":"i-1"}`), Desc: true})
	if err != nil {
		t.Fatalf("querying after the migration: %v", err)
	}
	if len(docs) != 1 {
		t.Errorf("the migrated record does not answer a filtered query: %v", docs)
	}

	again, err := kv.MigrateNamespace("plugin-old", "plugin-new")
	if err != nil {
		t.Fatalf("migrating again: %v", err)
	}
	if again.Migrated || again.Reason != "source-empty" {
		t.Errorf("outcome = %+v, want source-empty", again)
	}
}

// Data on both sides cannot be merged safely, and a silent loss is not an
// option — so it is an error rather than a choice made for the caller.
func TestMigrationRefusesToMerge(t *testing.T) {
	kv := open(t)
	if err := kv.Set("plugin-old", "k", "1"); err != nil {
		t.Fatalf("writing: %v", err)
	}
	if err := kv.Set("plugin-new", "k", "2"); err != nil {
		t.Fatalf("writing: %v", err)
	}
	_, err := kv.MigrateNamespace("plugin-old", "plugin-new")
	if err == nil {
		t.Fatal("a merge was performed")
	}
	if !strings.Contains(err.Error(), "plugin-old") || !strings.Contains(err.Error(), "plugin-new") {
		t.Errorf("error = %v, want one naming both sides", err)
	}
	if value, _, _ := kv.Get("plugin-new", "k"); value != "2" {
		t.Errorf("the destination's value changed to %q", value)
	}
}

// Migrating a namespace onto itself is a no-op with a name, not an error.
func TestMigratingOntoItselfIsNamedNotRefused(t *testing.T) {
	outcome, err := open(t).MigrateNamespace("plugin-old", "plugin-old")
	if err != nil {
		t.Fatalf("migrating onto itself: %v", err)
	}
	if outcome.Migrated || outcome.Reason != "same-ns" {
		t.Errorf("outcome = %+v", outcome)
	}
}

// Both sides of a migration are validated: this path creates a namespace, and a
// path that creates what the rules forbid means the rules are not rules.
func TestMigrationValidatesBothNames(t *testing.T) {
	kv := open(t)
	if _, err := kv.MigrateNamespace("plugin:old", "plugin-new"); err == nil {
		t.Error("an invalid source was accepted")
	}
	if _, err := kv.MigrateNamespace("plugin-old", "plugin:new"); err == nil {
		t.Error("an invalid destination was accepted")
	}
}

// Removing a namespace leaves a double-digit neighbour's indexes alone.
//
// The neighbour above shares no name prefix with the namespace being removed.
// This one does: collection 11's index name begins with collection 1's, and a
// prefix compared as a LIKE pattern took the whole namespace's indexes with it.
func TestRemovingANamespaceLeavesADoubleDigitNeighboursIndexes(t *testing.T) {
	kv := open(t)
	for index := 1; index <= 10; index++ {
		coll := "c" + strings.Repeat("x", index)
		if err := kv.Define("plugin-probe", coll, []string{"issue"}, nil); err != nil {
			t.Fatalf("defining %s: %v", coll, err)
		}
	}
	// The eleventh collection is the neighbour's.
	if err := kv.Define("plugin-keeper", "t", []string{"issue"}, nil); err != nil {
		t.Fatalf("defining: %v", err)
	}
	if _, err := kv.RemoveNamespace("plugin-probe"); err != nil {
		t.Fatalf("removing: %v", err)
	}
	var kept int
	err := kv.db.QueryRow(
		`SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?`, indexName(11, "issue")).Scan(&kept)
	if err != nil {
		t.Fatalf("looking for the index: %v", err)
	}
	if kept != 1 {
		t.Errorf("%s is gone: removing one namespace dropped another's index", indexName(11, "issue"))
	}
}
