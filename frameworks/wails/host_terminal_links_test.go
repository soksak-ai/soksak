package wails

import (
	"strings"
	"testing"

	terminalsurface "github.com/min-median-max/wails-service-terminal-surface"
)

type refusedByFake struct{}

func (refusedByFake) Error() string { return "refused by the fake" }

// The host's glue builds the session layer from the identity and the injected
// links, and a started pane speaks to its engine first. Start is called
// directly here: driving Apply would need an AppKit runloop (P7), so the
// ObservePanes goroutine glue is verified at the application stage, not here.
func TestTheSessionsSpeakThroughTheInjectedLinks(t *testing.T) {
	var calls []string
	links := terminalsurface.Links{Send: func(unit, command string, _ map[string]any) (map[string]any, error) {
		calls = append(calls, unit+":"+command)
		return nil, refusedByFake{}
	}}
	backend := terminalsurface.NewBackend()
	sessions := wireTerminalSessions(backend, "install-test", links)

	if err := sessions.Input("tab-1.1", "aa"); err == nil ||
		!strings.Contains(err.Error(), "is not running") {
		t.Fatalf("an unstarted pane must refuse by name: %v", err)
	}

	err := sessions.Start(map[string]string{
		"window": "win-1", "pane": "tab-1.1",
		"ptyUnit": "soksak-sidecar-pty", "engineUnit": "soksak-sidecar-terminal-alacritty",
		"pixelW": "100", "pixelH": "100", "scale": "2",
		"fontFamily": "Menlo", "fontPt": "13", "theme": "{}", "shell": "/bin/zsh",
	})
	if err == nil {
		t.Fatal("the fake refuses every call; Start cannot succeed")
	}
	if len(calls) == 0 || calls[0] != "soksak-sidecar-terminal-alacritty:terminal.rehydrate" {
		t.Fatalf("the session did not open with the engine's rehydrate: %v", calls)
	}
}
