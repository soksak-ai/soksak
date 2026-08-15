package store

import (
	"encoding/json"
	"strings"
	"testing"
)

func filterOf(t *testing.T, text string) map[string]json.RawMessage {
	t.Helper()
	var filter map[string]json.RawMessage
	if err := json.Unmarshal([]byte(text), &filter); err != nil {
		t.Fatalf("reading the filter: %v", err)
	}
	return filter
}

// Go randomises map iteration, so an unsorted builder compiles the same filter
// into a different statement every call. An ordered map iterated
// map and got this for free. Without it two identical queries are two
// statements: the prepared-statement cache never hits, and no test can assert
// on what was built.
func TestTheSameFilterCompilesToTheSameStatement(t *testing.T) {
	filter := filterOf(t, `{"tag":"a","kind":"b","seen":false,"rank":3}`)
	allowed := []string{"tag", "kind", "seen", "rank"}

	first, _, err := buildWhere(filter, allowed)
	if err != nil {
		t.Fatalf("building: %v", err)
	}
	for attempt := 0; attempt < 20; attempt++ {
		again, _, err := buildWhere(filter, allowed)
		if err != nil {
			t.Fatalf("building: %v", err)
		}
		if again != first {
			t.Fatalf("attempt %d built %q, first built %q", attempt, again, first)
		}
	}
	if !strings.Contains(first, "json_extract(doc, '$.kind')") {
		t.Errorf("a declared field is not read from the document: %q", first)
	}
}

// A field that was never declared as an index would mean a full scan of
// records, and an identifier interpolated into SQL that no rule vetted.
func TestAnUndeclaredFilterFieldIsRefusedByName(t *testing.T) {
	_, _, err := buildWhere(filterOf(t, `{"secret":"x"}`), []string{"tag"})
	if err == nil || !strings.Contains(err.Error(), "secret") {
		t.Fatalf("error = %v, want one naming the field", err)
	}
}

// The built-in fields are real columns, so they need no declaration.
func TestBuiltInFieldsNeedNoDeclaration(t *testing.T) {
	clause, params, err := buildWhere(filterOf(t, `{"created":{"op":"gte","value":10}}`), nil)
	if err != nil {
		t.Fatalf("building: %v", err)
	}
	if !strings.Contains(clause, "created >= ?") {
		t.Errorf("clause = %q", clause)
	}
	if len(params) != 1 {
		t.Fatalf("params = %v", params)
	}
}

// The name is refused before a statement exists, not escaped inside one.
func TestAnInjectingFieldNameIsRefusedBeforeAnySQLIsBuilt(t *testing.T) {
	clause, _, err := buildWhere(
		filterOf(t, `{"a'); DROP TABLE records;--":"x"}`), []string{"a'); DROP TABLE records;--"})
	if err == nil {
		t.Fatalf("the name was accepted, clause %q", clause)
	}
	if clause != "" {
		t.Errorf("a refused filter still produced %q", clause)
	}
}

// An empty `in` matches nothing. Compiling it to "no filter" would turn "match
// nothing" into "match everything", which is the widest possible wrong answer.
func TestAnEmptyInMatchesNothing(t *testing.T) {
	clause, params, err := buildWhere(filterOf(t, `{"tag":{"op":"in","value":[]}}`), []string{"tag"})
	if err != nil {
		t.Fatalf("building: %v", err)
	}
	if !strings.Contains(clause, " 0") {
		t.Errorf("clause = %q, want the constant false", clause)
	}
	if len(params) != 0 {
		t.Errorf("params = %v, want none", params)
	}
}

func TestInBindsEveryMember(t *testing.T) {
	clause, params, err := buildWhere(filterOf(t, `{"tag":{"op":"in","value":["a","b"]}}`), []string{"tag"})
	if err != nil {
		t.Fatalf("building: %v", err)
	}
	if !strings.Contains(clause, "IN (?,?)") {
		t.Errorf("clause = %q", clause)
	}
	if len(params) != 2 {
		t.Errorf("params = %v", params)
	}
}

func TestAnUnknownOperatorIsRefusedByName(t *testing.T) {
	_, _, err := buildWhere(filterOf(t, `{"tag":{"op":"regex","value":"x"}}`), []string{"tag"})
	if err == nil || !strings.Contains(err.Error(), "regex") {
		t.Fatalf("error = %v, want one naming the operator", err)
	}
}

func TestInWithoutAnArrayIsRefused(t *testing.T) {
	if _, _, err := buildWhere(filterOf(t, `{"tag":{"op":"in","value":"a"}}`), []string{"tag"}); err == nil {
		t.Fatal("a non-array `in` was accepted")
	}
}

// Every comparison value is bound, never spliced — including the ones that
// arrive as a JSON object.
func TestEveryComparisonValueIsBound(t *testing.T) {
	clause, params, err := buildWhere(
		filterOf(t, `{"tag":"it's","seen":true,"rank":2,"note":null}`),
		[]string{"tag", "seen", "rank", "note"})
	if err != nil {
		t.Fatalf("building: %v", err)
	}
	if strings.Contains(clause, "it's") {
		t.Errorf("a value reached the statement: %q", clause)
	}
	if len(params) != 4 {
		t.Fatalf("params = %v", params)
	}
	// Sorted by field name: note, rank, seen, tag.
	if params[0] != nil {
		t.Errorf("null bound as %#v, want NULL", params[0])
	}
	if params[1] != int64(2) {
		t.Errorf("a number bound as %#v", params[1])
	}
	if params[2] != int64(1) {
		t.Errorf("true bound as %#v, want 1 — json_extract answers booleans as 1/0", params[2])
	}
	if params[3] != "it's" {
		t.Errorf("params = %v, want the string bound as itself", params)
	}
}
