package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// A shutdown that does not end the process names what it was told and what it said.
//
// `quit()` sends `app.shutdown.commit`, discards the answer, waits twenty seconds, kills the
// process and fails with a sentence that holds neither. The gate keeps the application's whole
// output for exactly this — the comment beside that capture reads "A refusal names what is missing,
// and so must a death" — and this death names nothing.
//
// Measured 2026-08-20: four gates failed there at once, every one of them after its own body had
// passed, and the failure said only that twenty seconds had gone by. What the command answered,
// what the application printed, and which counters the shutdown reported were all in hand and none
// of them reached the report.
//
// This reads the source rather than a run, because the failure it is about takes twenty seconds to
// reproduce and happens after everything else in a gate has already succeeded.
func TestAShutdownThatDoesNotEndNamesWhatItHeld(t *testing.T) {
	body, err := os.ReadFile("restore_gate_test.go")
	if err != nil {
		t.Fatalf("reading the gate: %v", err)
	}
	source := string(body)

	quit := functionBody(t, source, "func (gate *restoreGate) quit() {")

	// The answer to the command it sent. Discarded with `_, _ =`, a refusal — an unknown command, a
	// window that had already gone — reads exactly like a shutdown that was accepted and ignored.
	if regexp.MustCompile(`_,\s*_\s*=\s*gate\.try\("app\.shutdown\.commit"`).MatchString(quit) {
		t.Error("quit() throws away what app.shutdown.commit answered.\n" +
			"A refused shutdown and an accepted one that did nothing are the same twenty seconds " +
			"from here; the answer is the only thing that separates them.")
	}

	// The application's own output. The gate captures it for this and nothing else reads it here.
	if !strings.Contains(quit, "lastWords()") {
		t.Error("quit() fails without the application's own output.\n" +
			"start() keeps every line the process printed so that a death names its reason. " +
			"Read it into the failure.")
	}
}

// functionBody is the text between a function's opening line and the closing brace in column one.
// Enough for this file: every function here is top level and formatted by gofmt.
func functionBody(t *testing.T, source string, signature string) string {
	t.Helper()
	at := strings.Index(source, signature)
	if at < 0 {
		t.Fatalf("the gate has no %s — this test names a function that moved", signature)
	}
	rest := source[at+len(signature):]
	end := strings.Index(rest, "\n}")
	if end < 0 {
		t.Fatalf("%s has no closing brace in column one", signature)
	}
	return rest[:end]
}
