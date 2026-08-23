package application

import (
	"os"
	"strings"
	"testing"
)

// The quit is asked of a window that answers, not of a name that may have been retired.
//
// `main` is the launch-time renderer. Since 2026-08-19 it closes itself once both halves of boot
// are true — every saved window requested, and one workspace renderer with its commands declared —
// so on any run that opens a workspace, `main` is gone before the gate is done with it.
//
// Measured 2026-08-20: four gates failed together, every one after its own body had passed, and the
// application was never told to stop. `app.shutdown.commit` was addressed to `window=main` and
// refused with `window main no longer answers`; the process then ran until the gate killed it at
// twenty seconds.
//
// The retirement is the design and it holds the answer with it: `main` retires only once a
// workspace window is ready, so wherever `main` is gone a workspace window is there to be asked.
//
// Read from the source, because the state this is about takes a full gate run to reach and is over
// by the time anything could be asked about it.
func TestTheQuitIsAskedOfAWindowThatAnswers(t *testing.T) {
	body, err := os.ReadFile("internal/application/restore_gate_test.go")
	if err != nil {
		t.Fatalf("reading the gate: %v", err)
	}
	source := string(body)

	for _, one := range []struct {
		function string
		command  string
		why      string
	}{
		{
			function: "func (gate *restoreGate) quit() {",
			command:  "app.shutdown.commit",
			why:      "the quit runs last, when a workspace window has long since retired main",
		},
		{
			function: "func (gate *restoreGate) openWorkspace() string {",
			command:  "window.open",
			why:      "a second workspace is opened after the first one retired main",
		},
	} {
		block := functionBody(t, source, one.function)
		if strings.Contains(block, `"window=main"`) {
			t.Errorf("%s addresses window=main.\n"+
				"%s, and %s is then refused with `window main no longer answers`.\n"+
				"Ask a window this gate opened; fall back to main only when it has opened none.",
				one.command, one.why, one.command)
		}
	}

	// The fallback is the honest half of the rule: before any workspace exists, main is the only
	// window there is, and a gate that never opened one has nothing else to ask.
	if !strings.Contains(source, "func (gate *restoreGate) answeringWindow() string {") {
		t.Error("the gate has no answeringWindow().\n" +
			"One place decides which window a whole-application command is asked of, so the quit " +
			"and the open cannot disagree about it.")
	}
}
