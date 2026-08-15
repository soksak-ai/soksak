package wails

import (
	"strings"
	"testing"

	"github.com/soksak/soksak-core/core/control"
)

// Every window serves the same catalogue, so the table holds one entry per name
// and the window is an argument — the shape window_snapshot and
// window_set_background already use.
//
// The alternative, a window segment inside the command name, was measured on
// 2026-08-15: main held 249 names and the second window had 250 refused. Every
// window after the first was unreachable, and `sok ui.measure` — the spelling
// the geometry constitution documents for proving an alignment claim — worked
// in one window only.
func TestOneNameServesEveryWindow(t *testing.T) {
	registry, bridge, _ := bridged(t)

	if err := bridge.Declare("main", []string{"ui.tree"}); err != nil {
		t.Fatalf("main: %v", err)
	}
	if err := bridge.Declare("win-a", []string{"ui.tree"}); err != nil {
		t.Fatalf("win-a: %v", err)
	}

	names := map[string]bool{}
	for _, command := range registry.Describe().Commands {
		names[command.Name] = true
	}
	if !names["ui.tree"] {
		t.Fatal("ui.tree is not on the table")
	}
	for name := range names {
		if strings.HasPrefix(name, "win/") {
			t.Errorf("%s carries a window in its name; the window is an argument", name)
		}
	}
}

// The window reached is the one named, and the caller's own when none is named.
func TestTheWindowArgumentChoosesWhoAnswers(t *testing.T) {
	registry, bridge, document := bridged(t)
	_ = bridge.Declare("main", []string{"ui.tree"})
	_ = bridge.Declare("win-a", []string{"ui.tree"})

	answerOnce(t, registry, document, `{"ok":true}`)
	if _, err := registry.Invoke("ui.tree", callArgs(t, map[string]any{"window": "win-a"})); err != nil {
		t.Fatalf("naming a window: %v", err)
	}
	if reached := document.lastWindow(); reached != "win-a" {
		t.Errorf("the request reached %q, want the window it named", reached)
	}

	answerOnce(t, registry, document, `{"ok":true}`)
	if _, err := registry.InvokeFrom(control.Caller{Window: "main"}, "ui.tree", nil); err != nil {
		t.Fatalf("from a window: %v", err)
	}
	if reached := document.lastWindow(); reached != "main" {
		t.Errorf("an unnamed request reached %q, want the caller's own window", reached)
	}
}

// Neither stamped nor named is a caller that did not choose. Picking one would
// answer about a window nobody asked about, and the answer would look right.
func TestAnUnaimedRequestIsRefusedByName(t *testing.T) {
	registry, bridge, _ := bridged(t)
	_ = bridge.Declare("main", []string{"ui.tree"})
	_ = bridge.Declare("win-a", []string{"ui.tree"})

	_, err := registry.Invoke("ui.tree", nil)
	if err == nil {
		t.Fatal("a request naming no window was answered")
	}
	if !strings.Contains(err.Error(), "main") || !strings.Contains(err.Error(), "win-a") {
		t.Errorf("the refusal did not say which windows there are: %v", err)
	}
}

// A window that does not serve a name is told so, rather than the request
// going somewhere that does.
func TestAWindowThatDoesNotServeItSaysSo(t *testing.T) {
	registry, bridge, _ := bridged(t)
	_ = bridge.Declare("main", []string{"ui.tree"})
	_ = bridge.Declare("win-a", []string{"ui.measure"})

	_, err := registry.Invoke("ui.tree", callArgs(t, map[string]any{"window": "win-a"}))
	if err == nil {
		t.Fatal("a window answered a name it never declared")
	}
	if !strings.Contains(err.Error(), "win-a") || !strings.Contains(err.Error(), "ui.tree") {
		t.Errorf("the refusal named neither the window nor the command: %v", err)
	}
}
