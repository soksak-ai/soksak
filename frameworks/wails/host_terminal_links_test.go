package wails

import (
	"reflect"
	"strings"
	"testing"

	terminalsurface "github.com/min-median-max/wails-service-terminal-surface"
)

func TestTerminalUnitGenerationEventsAreInjectedIntoTheHost(t *testing.T) {
	field, found := reflect.TypeOf(Options{}).FieldByName("TerminalUnitStarts")
	if !found || field.Type.Kind() != reflect.Func {
		t.Fatal("Wails host has no event input for selected terminal unit generations")
	}
}

type refusedByFake struct{}

func (refusedByFake) Error() string { return "refused by the fake" }

type recordedUnitRestarter struct {
	units []string
}

func (restarter *recordedUnitRestarter) RestartUnit(unit string) error {
	restarter.units = append(restarter.units, unit)
	return nil
}

func TestTerminalUnitGenerationEventCallsTheSessionOwner(t *testing.T) {
	var listener func(string)
	restarter := &recordedUnitRestarter{}
	observeTerminalUnitStarts(restarter, func(selected func(string)) func() {
		listener = selected
		return func() {}
	})
	listener("soksak-sidecar-terminal-shitty")
	if len(restarter.units) != 1 || restarter.units[0] != "soksak-sidecar-terminal-shitty" {
		t.Fatalf("restarted units=%v", restarter.units)
	}
}

// The host's glue builds the session layer from the identity and the injected
// links, and a started pane speaks to its engine first. Start is called
// directly here: driving Apply would need an AppKit runloop (P7), so the
// ObservePanes goroutine glue is verified at the application stage, not here.
func TestTheSessionsSpeakThroughTheInjectedLinks(t *testing.T) {
	var starts []string
	var calls []string
	links := terminalsurface.Links{Start: func(unit string) error {
		starts = append(starts, unit)
		return nil
	}, Send: func(unit, command string, _ map[string]any) (map[string]any, error) {
		calls = append(calls, unit+":"+command)
		return nil, refusedByFake{}
	}}
	backend := terminalsurface.NewBackend()
	sessions := wireTerminalSessions(backend, "install-test", links, nil)

	if err := sessions.Input("tab-1.1", "aa"); err == nil ||
		!strings.Contains(err.Error(), "is not running") {
		t.Fatalf("an unstarted pane must refuse by name: %v", err)
	}

	err := sessions.Start(map[string]string{
		"window": "win-1", "pane": "tab-1.1",
		"ptyUnit": "soksak-sidecar-pty", "engineUnit": "soksak-sidecar-terminal-alacritty",
		"pixelW": "100", "pixelH": "100", "scale": "2",
		"fontFamily": "Menlo", "fontPt": "13", "theme": "{}", "shell": "/bin/zsh",
	}, 1)
	if err == nil {
		t.Fatal("the fake refuses every call; Start cannot succeed")
	}
	wantStarts := []string{"soksak-sidecar-pty", "soksak-sidecar-terminal-alacritty"}
	if !reflect.DeepEqual(starts, wantStarts) {
		t.Fatalf("started units=%v want=%v", starts, wantStarts)
	}
	if len(calls) == 0 || calls[0] != "soksak-sidecar-terminal-alacritty:terminal.rehydrate" {
		t.Fatalf("the session did not open with the engine's rehydrate: %v", calls)
	}
}
