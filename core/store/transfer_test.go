package store

import (
	"strings"
	"testing"
)

func seeded(t *testing.T) *KV {
	t.Helper()
	kv := open(t)
	if err := kv.Define("mailbox", "messages", []string{"read"}, []string{"title"}); err != nil {
		t.Fatalf("defining: %v", err)
	}
	if _, err := kv.Put("mailbox", "messages", "p", "x1", document(t, `{"read":true,"title":"Subject"}`), 100); err != nil {
		t.Fatalf("putting: %v", err)
	}
	if err := kv.Set("mailbox", "theme", `"Midnight"`); err != nil {
		t.Fatalf("writing: %v", err)
	}
	return kv
}

// Export then import carries the definition, the record and the key across.
// The stamps are re-made: import is a transfer, not a snapshot — backup and
// restore are the exact pair.
func TestExportAndImportCarryTheStoreAcrossAndRestamp(t *testing.T) {
	source := seeded(t)
	lines, err := source.Export(nil, nil)
	if err != nil {
		t.Fatalf("exporting: %v", err)
	}

	destination := open(t)
	result, err := destination.Import(lines, 999)
	if err != nil {
		t.Fatalf("importing: %v", err)
	}
	if result.Records != 1 || result.KV != 1 {
		t.Errorf("result = %+v", result)
	}
	if _, found, _ := destination.GetDocument("mailbox", "messages", "x1", nil); !found {
		t.Error("the record did not arrive")
	}
	value, found, _ := destination.Get("mailbox", "theme")
	if !found || value != `"Midnight"` {
		t.Errorf("the key arrived as %q found=%v", value, found)
	}
	var created int64
	if err := destination.db.QueryRow(`SELECT created FROM records WHERE id='x1'`).Scan(&created); err != nil {
		t.Fatalf("reading the stamp: %v", err)
	}
	if created != 999 {
		t.Errorf("created = %d, want the importing clock's 999 — import is a transfer, not a snapshot", created)
	}
	// The definition arrived too, which is what makes the search index exist.
	hits, err := destination.Search("mailbox", "messages", "Subject", nil, nil)
	if err != nil {
		t.Fatalf("searching after the import: %v", err)
	}
	if len(hits) != 1 {
		t.Errorf("the imported record is not searchable: %v", hits)
	}
}

// The export names its kinds in an order the import can replay: a definition
// before the records it indexes.
func TestExportOrdersDefinitionsBeforeRecords(t *testing.T) {
	lines, err := seeded(t).Export(nil, nil)
	if err != nil {
		t.Fatalf("exporting: %v", err)
	}
	metaAt := strings.Index(lines, `"kind":"meta"`)
	recordAt := strings.Index(lines, `"kind":"record"`)
	kvAt := strings.Index(lines, `"kind":"kv"`)
	if metaAt < 0 || recordAt < 0 || kvAt < 0 {
		t.Fatalf("a kind is missing:\n%s", lines)
	}
	if !(metaAt < recordAt && recordAt < kvAt) {
		t.Errorf("the kinds are out of order:\n%s", lines)
	}
}

// Keys have no collection, so naming one skips them rather than exporting a
// namespace's keys under a collection they do not belong to.
func TestNamingACollectionSkipsTheKeys(t *testing.T) {
	lines, err := seeded(t).Export(nil, stringPointer("messages"))
	if err != nil {
		t.Fatalf("exporting: %v", err)
	}
	if strings.Contains(lines, `"kind":"kv"`) {
		t.Errorf("keys were exported under a collection:\n%s", lines)
	}
}

// A row that cannot be encoded fails the whole export. An earlier build dropped
// it, and the export then looked complete — the same failure shape as a
// diagnosis that answers `{}` and is read as success.
func TestARowThatCannotBeEncodedFailsTheExport(t *testing.T) {
	kv := open(t)
	if _, err := kv.Put("mailbox", "messages", "p", "x1", document(t, `{"n":1}`), 100); err != nil {
		t.Fatalf("putting: %v", err)
	}
	// A collection with a declared index cannot be corrupted this way at all:
	// the expression index re-evaluates json_extract on every write and SQLite
	// refuses the malformed document. Without one, nothing re-reads it until
	// the export does.
	if _, err := kv.db.Exec(`UPDATE records SET doc='{not json' WHERE id='x1'`); err != nil {
		t.Fatalf("corrupting: %v", err)
	}
	if _, err := kv.Export(nil, nil); err == nil {
		t.Fatal("an unencodable row was skipped and the export looked complete")
	}
}

// Every line's namespace is validated. An earlier build measured an unvalidated
// import planting `plugin:probe-lane`, after which no command could read or
// delete it — every command validates. A path that creates what the rules
// forbid means the rules are not rules.
func TestAnImportLineWithAForbiddenNamespaceIsRefused(t *testing.T) {
	kv := open(t)
	_, err := kv.Import(`{"kind":"kv","ns":"plugin:probe","k":"a","v":1}`, 10)
	if err == nil {
		t.Fatal("a forbidden namespace was imported")
	}
	var rows int
	if err := kv.db.QueryRow(`SELECT COUNT(*) FROM kv`).Scan(&rows); err != nil {
		t.Fatalf("counting: %v", err)
	}
	if rows != 0 {
		t.Error("the refused line still landed")
	}
}

// An unknown kind is refused with its line number rather than skipped: a typo
// or a newer format otherwise disappears while the count still looks right.
func TestAnUnknownKindIsRefusedWithItsLineNumber(t *testing.T) {
	lines := "{\"kind\":\"kv\",\"ns\":\"ui\",\"k\":\"a\",\"v\":1}\n{\"kind\":\"recrod\",\"ns\":\"ui\"}"
	_, err := open(t).Import(lines, 10)
	if err == nil {
		t.Fatal("an unknown kind was skipped")
	}
	if !strings.Contains(err.Error(), "2") || !strings.Contains(err.Error(), "recrod") {
		t.Errorf("error = %v, want one naming the line and the kind", err)
	}
}

// A sealed document cannot be imported as a plain one: this build has no vault,
// and importing it would present ciphertext as data.
func TestASealedDocumentIsRefusedByName(t *testing.T) {
	line := `{"kind":"record","ns":"ui","coll":"t","scope":"","id":"x","doc":{"__enc":1}}`
	_, err := open(t).Import(line, 10)
	if err == nil {
		t.Fatal("a sealed document was imported as a plain one")
	}
	if !strings.Contains(err.Error(), "__enc") {
		t.Errorf("error = %v, want one naming the reserved key", err)
	}
}

// Blank lines are not content, and an unreadable line is a failure rather than
// a skip.
func TestBlankLinesPassAndBrokenLinesFail(t *testing.T) {
	kv := open(t)
	if _, err := kv.Import("\n\n", 10); err != nil {
		t.Fatalf("importing blank lines: %v", err)
	}
	if _, err := kv.Import("{not json", 10); err == nil {
		t.Fatal("an unreadable line was skipped")
	}
}

// Export narrowed to a namespace carries that namespace only.
func TestExportNarrowsToTheNamespaceItIsGiven(t *testing.T) {
	kv := seeded(t)
	if err := kv.Set("other", "k", "1"); err != nil {
		t.Fatalf("writing: %v", err)
	}
	lines, err := kv.Export(stringPointer("mailbox"), nil)
	if err != nil {
		t.Fatalf("exporting: %v", err)
	}
	if strings.Contains(lines, `"other"`) {
		t.Errorf("another namespace came along:\n%s", lines)
	}
}

// An import line whose value is not JSON is refused with its line number.
//
// The read side names an unreadable value and answers the whole namespace with
// an error, so one admitted row makes every neighbouring key unreadable through
// data_kv_entries. This is the same rule as the namespace one above: a path
// that plants what another surface refuses means neither is a rule.
func TestAnImportValueThatIsNotJSONIsRefusedWithItsLineNumber(t *testing.T) {
	kv := open(t)
	result, err := kv.Import(`{"kind":"kv","ns":"mailbox","k":"theme"}`, 100)
	if err == nil {
		t.Fatalf("a line carrying no value was imported as %+v", result)
	}
	if !strings.Contains(err.Error(), "line 1") {
		t.Errorf("error = %v, want it to name the line", err)
	}
	entries, err := kv.Entries("mailbox", nil)
	if err != nil {
		t.Errorf("the namespace no longer reads back: %v", err)
	}
	if len(entries.Entries) != 0 {
		t.Errorf("entries = %+v, want none", entries.Entries)
	}
	// A value that is JSON null is a value. Refusing it would make a key nobody
	// can carry across, and export writes it back out the same way.
	if _, err := kv.Import(`{"kind":"kv","ns":"mailbox","k":"theme","v":null}`, 100); err != nil {
		t.Errorf("a null value was refused: %v", err)
	}
}

// An imported key takes the stamp the import was given. Every other write in
// this package stamps from the clock its caller supplied; a key-value row
// reading the machine clock makes one import two answers.
func TestAnImportedKeyTakesTheStampItWasGiven(t *testing.T) {
	kv := open(t)
	if _, err := kv.Import(`{"kind":"kv","ns":"mailbox","k":"theme","v":"Midnight"}`, 4242); err != nil {
		t.Fatalf("importing: %v", err)
	}
	var updated int64
	if err := kv.db.QueryRow(`SELECT updated FROM kv WHERE ns=? AND k=?`, "mailbox", "theme").Scan(&updated); err != nil {
		t.Fatalf("reading the stamp: %v", err)
	}
	if updated != 4242 {
		t.Errorf("updated = %d, want the 4242 the import was handed", updated)
	}
}
