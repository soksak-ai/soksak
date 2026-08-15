package store

import (
	"encoding/json"
	"strings"
	"testing"
)

func document(t *testing.T, text string) map[string]json.RawMessage {
	t.Helper()
	var doc map[string]json.RawMessage
	if err := json.Unmarshal([]byte(text), &doc); err != nil {
		t.Fatalf("reading the document: %v", err)
	}
	return doc
}

func fieldOf(t *testing.T, doc json.RawMessage, field string) string {
	t.Helper()
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(doc, &decoded); err != nil {
		t.Fatalf("reading a stored document: %v", err)
	}
	return string(decoded[field])
}

// A record and its search index are one unit. A measurement found that
// writing them in separate autocommits left, after a crash between them, a
// record present with a stale index — which shows up as a wrong search result,
// never as an error.
func TestAFailedIndexWriteLeavesNoRecord(t *testing.T) {
	kv := open(t)
	if err := kv.Define("mailbox", "messages", nil, []string{"title"}); err != nil {
		t.Fatalf("defining: %v", err)
	}
	// Take the index table away underneath the write.
	if _, err := kv.db.Exec(`DROP TABLE fts_1`); err != nil {
		t.Fatalf("dropping the index table: %v", err)
	}
	_, err := kv.Put("mailbox", "messages", "", "x1", document(t, `{"title":"a title"}`), 10)
	if err == nil {
		t.Fatal("a put with no index table succeeded")
	}
	if !strings.Contains(err.Error(), "fts_1") {
		t.Errorf("error = %v, want one naming the stage that failed", err)
	}
	doc, found, err := kv.GetDocument("mailbox", "messages", "x1", nil)
	if err != nil {
		t.Fatalf("reading back: %v", err)
	}
	if found {
		t.Errorf("the record survived a failed index write: %s", doc)
	}
}

// The canonical id is written into the document, so doc.id always equals the
// record id and a caller cannot end up addressing one by the other.
func TestThePutDocumentCarriesTheRecordId(t *testing.T) {
	kv := open(t)
	id, err := kv.Put("mailbox", "messages", "", "x1", document(t, `{"title":"a","id":"lie"}`), 10)
	if err != nil {
		t.Fatalf("putting: %v", err)
	}
	doc, found, err := kv.GetDocument("mailbox", "messages", id, nil)
	if err != nil || !found {
		t.Fatalf("reading back: found=%v err=%v", found, err)
	}
	if fieldOf(t, doc, "id") != `"x1"` {
		t.Errorf("doc.id = %s, want the record id", fieldOf(t, doc, "id"))
	}
}

// An update keeps created and moves updated. Retention evicts by created, so an
// update that moved it would make the eviction order nondeterministic.
func TestAnUpdateKeepsCreatedAndMovesUpdated(t *testing.T) {
	kv := open(t)
	if _, err := kv.Put("mailbox", "messages", "", "x1", document(t, `{"n":1}`), 100); err != nil {
		t.Fatalf("first put: %v", err)
	}
	if _, err := kv.Put("mailbox", "messages", "", "x1", document(t, `{"n":2}`), 200); err != nil {
		t.Fatalf("second put: %v", err)
	}
	var created, updated int64
	err := kv.db.QueryRow(`SELECT created, updated FROM records WHERE id='x1'`).Scan(&created, &updated)
	if err != nil {
		t.Fatalf("reading the stamps: %v", err)
	}
	if created != 100 || updated != 200 {
		t.Errorf("created=%d updated=%d, want 100 and 200", created, updated)
	}
}

// A record that was never written is absence, not failure.
func TestAMissingRecordIsAbsenceNotFailure(t *testing.T) {
	doc, found, err := open(t).GetDocument("mailbox", "messages", "never", nil)
	if err != nil {
		t.Fatalf("reading a missing record: %v", err)
	}
	if found {
		t.Errorf("found = true for a record never written: %s", doc)
	}
}

// Deleting what is not there converges on the same state, so the answer is
// false rather than an error and repeating it is safe.
func TestDeletingWhatIsNotThereAnswersFalse(t *testing.T) {
	removed, err := open(t).DeleteDocument("mailbox", "messages", "never", nil)
	if err != nil {
		t.Fatalf("deleting a missing record: %v", err)
	}
	if removed {
		t.Error("removed = true for a record never written")
	}
}

// Delete takes the index row with it: a search for deleted text must not return
// a hit for a record that is gone.
func TestDeleteTakesTheIndexRowWithIt(t *testing.T) {
	kv := open(t)
	if err := kv.Define("mailbox", "messages", nil, []string{"title"}); err != nil {
		t.Fatalf("defining: %v", err)
	}
	if _, err := kv.Put("mailbox", "messages", "", "x1", document(t, `{"title":"storage story"}`), 10); err != nil {
		t.Fatalf("putting: %v", err)
	}
	if removed, err := kv.DeleteDocument("mailbox", "messages", "x1", nil); err != nil || !removed {
		t.Fatalf("deleting: removed=%v err=%v", removed, err)
	}
	hits, err := kv.Search("mailbox", "messages", "storage", nil, nil)
	if err != nil {
		t.Fatalf("searching: %v", err)
	}
	if len(hits) != 0 {
		t.Errorf("a deleted record still answers a search: %v", hits)
	}
}

// This pins that the cgo-free driver ships FTS5 with the trigram tokenizer. If
// a driver bump drops it, define fails at runtime in a way that otherwise reads
// as "search found nothing".
func TestTrigramMatchesACJKSubstring(t *testing.T) {
	kv := open(t)
	if err := kv.Define("mailbox", "messages", nil, []string{"title"}); err != nil {
		t.Fatalf("defining: %v", err)
	}
	if _, err := kv.Put("mailbox", "messages", "", "x1", document(t, `{"title":"이것은 저장소다"}`), 10); err != nil {
		t.Fatalf("putting: %v", err)
	}
	hits, err := kv.Search("mailbox", "messages", "storage", nil, nil)
	if err != nil {
		t.Fatalf("searching: %v", err)
	}
	if len(hits) != 1 {
		t.Fatalf("a three-codepoint substring found %d records", len(hits))
	}
}

// Below three codepoints the trigram index matches nothing at all, so the query
// falls back to a scan. Letting MATCH answer would be silence presented as an
// empty result.
func TestATwoCodepointQueryStillFinds(t *testing.T) {
	kv := open(t)
	if err := kv.Define("mailbox", "messages", nil, []string{"title"}); err != nil {
		t.Fatalf("defining: %v", err)
	}
	if _, err := kv.Put("mailbox", "messages", "", "x1", document(t, `{"title":"이것은 저장소다"}`), 10); err != nil {
		t.Fatalf("putting: %v", err)
	}
	hits, err := kv.Search("mailbox", "messages", "저장", nil, nil)
	if err != nil {
		t.Fatalf("searching: %v", err)
	}
	if len(hits) != 1 {
		t.Fatalf("a two-codepoint query found %d records, want the fallback to find it", len(hits))
	}
}

// A quote in the query is part of the text being searched for, not syntax.
func TestAQuotedQueryIsSearchedForLiterally(t *testing.T) {
	kv := open(t)
	if err := kv.Define("mailbox", "messages", nil, []string{"title"}); err != nil {
		t.Fatalf("defining: %v", err)
	}
	if _, err := kv.Put("mailbox", "messages", "", "x1", document(t, `{"title":"a \"quoted\" title"}`), 10); err != nil {
		t.Fatalf("putting: %v", err)
	}
	if _, err := kv.Search("mailbox", "messages", `"quoted"`, nil, nil); err != nil {
		t.Fatalf("searching for a quoted phrase: %v", err)
	}
}

// Redefining with fewer index fields drops the indexes the collection no longer
// declares. Leaving them is what a namespace removal has to state a reason for
// that is wrong: an index left behind keeps making another namespace's writes
// heavy.
func TestRedefiningDropsTheIndexesNoLongerDeclared(t *testing.T) {
	kv := open(t)
	if err := kv.Define("mailbox", "messages", []string{"read", "kind"}, nil); err != nil {
		t.Fatalf("defining: %v", err)
	}
	if err := kv.Define("mailbox", "messages", []string{"read"}, nil); err != nil {
		t.Fatalf("redefining: %v", err)
	}
	var count int
	err := kv.db.QueryRow(
		`SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_1_kind'`).Scan(&count)
	if err != nil {
		t.Fatalf("counting indexes: %v", err)
	}
	if count != 0 {
		t.Error("an index for an undeclared field survived a redefine")
	}
}

func TestDefineIsIdempotent(t *testing.T) {
	kv := open(t)
	for attempt := 0; attempt < 3; attempt++ {
		if err := kv.Define("mailbox", "messages", []string{"read"}, []string{"title"}); err != nil {
			t.Fatalf("define %d: %v", attempt, err)
		}
	}
}

// The query rules: a declared field filters, an undeclared one is refused, and
// the clamps hold.
func TestQueryRefusesAnUndeclaredOrderField(t *testing.T) {
	kv := open(t)
	if err := kv.Define("mailbox", "messages", []string{"read"}, nil); err != nil {
		t.Fatalf("defining: %v", err)
	}
	_, err := kv.Query(QueryRequest{Ns: "mailbox", Coll: "messages", Order: "secret", Desc: true})
	if err == nil || !strings.Contains(err.Error(), "secret") {
		t.Fatalf("error = %v, want one naming the order field", err)
	}
}

func TestQueryClampsTheWindow(t *testing.T) {
	kv := open(t)
	for _, id := range []string{"a", "b", "c"} {
		if _, err := kv.Put("mailbox", "messages", "", id, document(t, `{"n":1}`), 10); err != nil {
			t.Fatalf("putting: %v", err)
		}
	}
	request := QueryRequest{
		Ns: "mailbox", Coll: "messages", Desc: true,
		Limit: int64Pointer(99999), Offset: int64Pointer(-3)}
	docs, err := kv.Query(request)
	if err != nil {
		t.Fatalf("querying: %v", err)
	}
	if len(docs) != 3 {
		t.Errorf("got %d records, want all three back from a clamped window", len(docs))
	}
	// What arrived is not what is bound. Three records come back either way, so
	// the statement is where the clamp is visible.
	_, params, err := kv.queryStatement(request)
	if err != nil {
		t.Fatalf("compiling: %v", err)
	}
	limit, offset := params[len(params)-2], params[len(params)-1]
	if limit != int64(queryLimitCeiling) {
		t.Errorf("limit bound as %v, want the ceiling %d", limit, queryLimitCeiling)
	}
	if offset != int64(0) {
		t.Errorf("offset bound as %v, want 0", offset)
	}
}

// Count and query share one builder, so a count cannot disagree with the list
// it counts.
func TestCountAgreesWithTheListItCounts(t *testing.T) {
	kv := open(t)
	if err := kv.Define("mailbox", "messages", []string{"read"}, nil); err != nil {
		t.Fatalf("defining: %v", err)
	}
	for index, read := range []string{"true", "false", "true"} {
		doc := document(t, `{"read":`+read+`}`)
		if _, err := kv.Put("mailbox", "messages", "", string(rune('a'+index)), doc, 10); err != nil {
			t.Fatalf("putting: %v", err)
		}
	}
	filter := filterOf(t, `{"read":true}`)
	request := QueryRequest{Ns: "mailbox", Coll: "messages", Filter: filter, Desc: true}
	docs, err := kv.Query(request)
	if err != nil {
		t.Fatalf("querying: %v", err)
	}
	count, err := kv.Count(request)
	if err != nil {
		t.Fatalf("counting: %v", err)
	}
	if int64(len(docs)) != count || count != 2 {
		t.Errorf("query returned %d and count answered %d", len(docs), count)
	}
}

// Scope narrows when it is given and matches every scope when it is not. An
// absent scope is a wildcard on read; on write it is the empty scope, which is
// a real scope rather than a wildcard.
func TestScopeNarrowsOnlyWhenGiven(t *testing.T) {
	kv := open(t)
	if _, err := kv.Put("mailbox", "messages", "project-a", "x1", document(t, `{"n":1}`), 10); err != nil {
		t.Fatalf("putting: %v", err)
	}
	if _, found, _ := kv.GetDocument("mailbox", "messages", "x1", stringPointer("project-b")); found {
		t.Error("a record answered under another scope")
	}
	if _, found, _ := kv.GetDocument("mailbox", "messages", "x1", nil); !found {
		t.Error("a record did not answer with no scope given")
	}
}

// A document carrying the reserved envelope key is refused. This build has no
// vault, and that key is the one way ciphertext could enter and be served as
// data.
func TestADocumentCarryingTheSealedEnvelopeKeyIsRefused(t *testing.T) {
	_, err := open(t).Put("mailbox", "messages", "", "x1", document(t, `{"__enc":1}`), 10)
	if err == nil || !strings.Contains(err.Error(), "__enc") {
		t.Fatalf("error = %v, want one naming the reserved key", err)
	}
}

func TestANonObjectDocumentIsRefused(t *testing.T) {
	if _, err := open(t).Put("mailbox", "messages", "", "x1", nil, 10); err == nil {
		t.Fatal("a document with no fields was accepted")
	}
}

// The expression index a define created is what a filtered query rides.
func TestAFilteredQueryRidesTheDeclaredIndex(t *testing.T) {
	kv := open(t)
	if err := kv.Define("mailbox", "messages", []string{"read"}, nil); err != nil {
		t.Fatalf("defining: %v", err)
	}
	if _, err := kv.Put("mailbox", "messages", "", "x1", document(t, `{"read":true}`), 10); err != nil {
		t.Fatalf("putting: %v", err)
	}
	statement, params, err := kv.queryStatement(QueryRequest{
		Ns: "mailbox", Coll: "messages", Filter: filterOf(t, `{"read":true}`), Desc: true})
	if err != nil {
		t.Fatalf("building: %v", err)
	}
	var plan strings.Builder
	rows, err := kv.db.Query("EXPLAIN QUERY PLAN "+statement, params...)
	if err != nil {
		t.Fatalf("explaining: %v", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id, parent, notUsed int
		var detail string
		if err := rows.Scan(&id, &parent, &notUsed, &detail); err != nil {
			t.Fatalf("scanning the plan: %v", err)
		}
		plan.WriteString(detail + "\n")
	}
	if !strings.Contains(plan.String(), "idx_1_read") {
		t.Errorf("the plan does not use the declared index:\n%s", plan.String())
	}
}

// Two writers in one process both get through. One connection serialises them;
// it does not make one of them fail, which is what an uncapped pool did on the
// measurement — a process taking `database is locked` from its own connections.
func TestTwoConcurrentWritersBothSucceed(t *testing.T) {
	kv := open(t)
	failures := make(chan error, 2)
	for writer := 0; writer < 2; writer++ {
		go func(writer int) {
			for attempt := 0; attempt < 20; attempt++ {
				id := string(rune('a'+writer)) + string(rune('a'+attempt))
				if _, err := kv.Put("mailbox", "messages", "s", id, document(t, `{"n":1}`), 10); err != nil {
					failures <- err
					return
				}
			}
			failures <- nil
		}(writer)
	}
	for writer := 0; writer < 2; writer++ {
		if err := <-failures; err != nil {
			t.Fatalf("a concurrent write failed: %v", err)
		}
	}
	count, err := kv.Count(QueryRequest{Ns: "mailbox", Coll: "messages"})
	if err != nil {
		t.Fatalf("counting: %v", err)
	}
	if count != 40 {
		t.Errorf("%d records survived 40 concurrent writes", count)
	}
}

// Define creates a namespace, so it validates one. Removal deliberately does
// not, and that asymmetry is the point: what got in must be able to get out.
func TestDefineValidatesTheNamespace(t *testing.T) {
	if err := open(t).Define("plugin:probe", "t", nil, nil); err == nil {
		t.Fatal("a namespace the rules forbid was defined")
	}
}

// Defining one collection leaves every other collection's indexes standing.
//
// The names are found by prefix, and `_` separates the collection id from the
// field. Compared as a LIKE pattern that `_` is a wildcard, so collection 1
// matched — and dropped — collections 10 through 19. Ten collections are what
// it takes to see it: with fewer, nothing shares a prefix.
func TestDefiningOneCollectionLeavesTheOthersIndexesStanding(t *testing.T) {
	kv := open(t)
	for index := 1; index <= 12; index++ {
		coll := "c" + strings.Repeat("x", index)
		if err := kv.Define("mailbox", coll, []string{"issue"}, nil); err != nil {
			t.Fatalf("defining %s: %v", coll, err)
		}
	}
	before := indexCount(t, kv)
	if err := kv.Define("mailbox", "cx", []string{"issue"}, nil); err != nil {
		t.Fatalf("redefining: %v", err)
	}
	if after := indexCount(t, kv); after != before {
		t.Errorf("indexes = %d after redefining one collection, want the %d there were", after, before)
	}
	var kept int
	err := kv.db.QueryRow(
		`SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?`, indexName(12, "issue")).Scan(&kept)
	if err != nil {
		t.Fatalf("looking for the index: %v", err)
	}
	if kept != 1 {
		t.Errorf("%s is gone: defining collection 1 dropped a double-digit collection's index", indexName(12, "issue"))
	}
}

func indexCount(t *testing.T, kv *KV) int {
	t.Helper()
	var count int
	if err := kv.db.QueryRow(
		`SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND substr(name,1,4)='idx_'`).Scan(&count); err != nil {
		t.Fatalf("counting the indexes: %v", err)
	}
	return count
}

// Turning search off and on again answers no document that never held the
// query. While no search field is declared, put and delete leave the search
// table alone; a table kept across that gap describes records that are gone,
// and the rowids they held go to other records.
func TestTurningSearchOffAndOnAgainAnswersNoStaleDocument(t *testing.T) {
	kv := open(t)
	if err := kv.Define("mailbox", "messages", nil, []string{"title"}); err != nil {
		t.Fatalf("defining: %v", err)
	}
	if _, err := kv.Put("mailbox", "messages", "s", "x1", document(t, `{"title":"alphabet"}`), 10); err != nil {
		t.Fatalf("putting: %v", err)
	}
	if err := kv.Define("mailbox", "messages", nil, nil); err != nil {
		t.Fatalf("undeclaring the search fields: %v", err)
	}
	if _, err := kv.DeleteDocument("mailbox", "messages", "x1", nil); err != nil {
		t.Fatalf("deleting: %v", err)
	}
	if _, err := kv.Put("mailbox", "messages", "s", "x2", document(t, `{"title":"bravo"}`), 20); err != nil {
		t.Fatalf("putting: %v", err)
	}
	if err := kv.Define("mailbox", "messages", nil, []string{"title"}); err != nil {
		t.Fatalf("redeclaring the search fields: %v", err)
	}
	hits, err := kv.Search("mailbox", "messages", "alphabet", nil, nil)
	if err != nil {
		t.Fatalf("searching: %v", err)
	}
	for _, hit := range hits {
		t.Errorf("searching the deleted record's words answered %s", hit)
	}
}

// The window is the ceiling and the floor, not the number that arrived. A
// query asking for more than the ceiling takes the ceiling, a negative offset
// starts at the beginning, and no limit at all is the default.
func TestTheWindowIsClamped(t *testing.T) {
	if got := window(nil, queryLimitDefault, queryLimitCeiling); got != queryLimitDefault {
		t.Errorf("no limit = %d, want the default %d", got, queryLimitDefault)
	}
	if got := window(int64Pointer(99999), queryLimitDefault, queryLimitCeiling); got != queryLimitCeiling {
		t.Errorf("limit 99999 = %d, want the ceiling %d", got, queryLimitCeiling)
	}
	if got := window(int64Pointer(-3), queryLimitDefault, queryLimitCeiling); got != 0 {
		t.Errorf("limit -3 = %d, want 0", got)
	}
	if got := window(int64Pointer(0), queryLimitDefault, queryLimitCeiling); got != 0 {
		t.Errorf("limit 0 = %d, want 0 — an explicit zero is an answer", got)
	}
	if got := clamp(-3, 0, 1<<62); got != 0 {
		t.Errorf("offset -3 = %d, want 0", got)
	}
}
