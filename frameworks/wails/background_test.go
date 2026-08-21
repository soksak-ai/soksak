package wails

import (
	"strings"
	"testing"

	"github.com/soksak-ai/soksak-core/core/control"
)

// The document paints transparent, so every unpainted region shows the window's
// own colour. A window that cannot colour itself shows the framework's default
// through the whole workspace — measured 2026-08-15: the orchestrator was dark
// and the workspace window's panes were white, with one dark theme selected.
//
// The colour must reach the window that asked. This host had one window
// captured at registration, so a workspace window's theme repainted the
// orchestrator and left itself alone.
func TestEachWindowColoursItself(t *testing.T) {
	host := startedHost(liveWindow(controlPlaneWindow), liveWindow("win-a"))
	registry := control.NewRegistry()
	RegisterBackground(registry, host)

	if _, err := registry.InvokeFrom(
		control.Caller{Window: "win-a"},
		"window_set_background",
		callArgs(t, map[string]any{"color": "#101014"}),
	); err != nil {
		t.Fatalf("window_set_background: %v", err)
	}

	if got := host.background("win-a"); got != "#101014" {
		t.Errorf("win-a is %q, want the colour it asked for", got)
	}
	if got := host.background(controlPlaneWindow); got != "" {
		t.Errorf("the orchestrator was repainted to %q by another window", got)
	}
}

// A caller the transport did not stamp has no window to colour, and colouring
// some other window would be worse than refusing.
func TestAnUnattributedCallerCannotColourAnything(t *testing.T) {
	host := startedHost(liveWindow(controlPlaneWindow))
	registry := control.NewRegistry()
	RegisterBackground(registry, host)

	_, err := registry.Invoke("window_set_background", callArgs(t, map[string]any{"color": "#101014"}))
	if err == nil {
		t.Fatal("a caller with no window coloured something")
	}
	if !strings.Contains(err.Error(), "window") {
		t.Errorf("the refusal did not name what was missing: %v", err)
	}
}

// A window that is gone is named rather than silently skipped: the caller
// believes its theme applied and every unpainted region disagrees.
func TestColouringAWindowThatIsGoneFailsByName(t *testing.T) {
	host := startedHost(liveWindow(controlPlaneWindow))
	registry := control.NewRegistry()
	RegisterBackground(registry, host)

	_, err := registry.InvokeFrom(
		control.Caller{Window: "win-gone"},
		"window_set_background",
		callArgs(t, map[string]any{"color": "#101014"}),
	)
	if err == nil {
		t.Fatal("a vanished window was coloured")
	}
	if !strings.Contains(err.Error(), "win-gone") {
		t.Errorf("the refusal did not name the window: %v", err)
	}
}
