package control

import (
	"encoding/json"
	"strings"
	"testing"
)

func args(t *testing.T, pairs map[string]string) Args {
	t.Helper()
	out := Args{}
	for name, raw := range pairs {
		out[name] = json.RawMessage(raw)
	}
	return out
}

func TestArgDecodesWhatWasSent(t *testing.T) {
	given := args(t, map[string]string{"ns": `"ui"`, "count": `7`, "on": `true`})

	if got, err := Arg[string](given, "ns"); err != nil || got != "ui" {
		t.Errorf("string = %q, %v", got, err)
	}
	if got, err := Arg[float64](given, "count"); err != nil || got != 7 {
		t.Errorf("number = %v, %v", got, err)
	}
	if got, err := Arg[bool](given, "on"); err != nil || !got {
		t.Errorf("bool = %v, %v", got, err)
	}
}

func TestArgNamesAMissingArgument(t *testing.T) {
	if _, err := Arg[string](args(t, nil), "ns"); err == nil || !strings.Contains(err.Error(), "ns") {
		t.Fatalf("error = %v, want it to name the argument", err)
	}
}

func TestArgRefusesAnExplicitNull(t *testing.T) {
	// Go's json package treats null as a no-op for most types: the destination
	// keeps its zero and no error is returned. So `{"x": null}` decoded into a
	// number answers 0 with success, and a handler cannot tell that from a
	// caller who sent 0.
	//
	// Found 2026-08-15 by the window group: window_place with "x": null placed
	// the window at x=0 and reported success. A required argument that is
	// present-but-null is a caller error, not a zero.
	for name, raw := range map[string]string{
		"number": `null`,
		"string": `null`,
		"bool":   `null`,
		"object": `null`,
	} {
		if _, err := Arg[float64](args(t, map[string]string{name: raw}), name); err == nil {
			t.Errorf("%s: null was accepted", name)
		}
	}
}

func TestArgRefusesTheWrongType(t *testing.T) {
	if _, err := Arg[float64](args(t, map[string]string{"count": `"seven"`}), "count"); err == nil {
		t.Fatal("a string was accepted where a number was required")
	}
}

func TestOptionalArgTreatsAbsenceAndNullAlike(t *testing.T) {
	// A caller omitting a field and a caller sending null mean the same thing
	// for an optional argument: they did not choose.
	if got, err := OptionalArg(args(t, nil), "depth", 12); err != nil || got != 12 {
		t.Errorf("absent = %v, %v", got, err)
	}
	if got, err := OptionalArg(args(t, map[string]string{"depth": `null`}), "depth", 12); err != nil || got != 12 {
		t.Errorf("null = %v, %v", got, err)
	}
	if got, err := OptionalArg(args(t, map[string]string{"depth": `3`}), "depth", 12); err != nil || got != 3 {
		t.Errorf("present = %v, %v", got, err)
	}
}

func TestOptionalArgStillRefusesTheWrongType(t *testing.T) {
	// Optional means "you may leave it out", never "send anything".
	if _, err := OptionalArg(args(t, map[string]string{"depth": `"three"`}), "depth", 12); err == nil {
		t.Fatal("a string was accepted where a number was optional")
	}
}

func TestRawArgPassesTheDocumentThrough(t *testing.T) {
	got, err := RawArg(args(t, map[string]string{"ledger": `{"bindings":[]}`}), "ledger")
	if err != nil {
		t.Fatalf("raw: %v", err)
	}
	if string(got) != `{"bindings":[]}` {
		t.Errorf("raw = %s", got)
	}
}

func TestRawArgRefusesNull(t *testing.T) {
	// A handler that passes a document through would write the four bytes
	// "null" in place of a document.
	if _, err := RawArg(args(t, map[string]string{"ledger": `null`}), "ledger"); err == nil {
		t.Fatal("null was accepted as a document")
	}
}

func TestRawArgNamesAMissingArgument(t *testing.T) {
	if _, err := RawArg(args(t, nil), "ledger"); err == nil || !strings.Contains(err.Error(), "ledger") {
		t.Fatalf("error = %v, want it to name the argument", err)
	}
}
