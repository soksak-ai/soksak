package wails

import (
	"strings"
	"testing"

	"github.com/soksak-ai/soksak-core/core/control"
)

// The window's own inspector, opened by name.
//
// Every rule about a rectangle in this build is checked against a number, and every one of those
// numbers agreed on 2026-08-17 while the screen did not: the surface's declared rect equalled the
// element that declared it to the tenth of a point, the compositor's drift was zero on every
// surface, and a person watching still saw the page sitting off its pane. When the readings agree
// and the screen disagrees, the next question is about the document itself, and nothing in this
// build could open it.
//
// So it is a command like any other: named, refused by name when the window is gone, and reachable
// from outside without a keyboard shortcut nobody can send over a socket.
func TestTheInspectorOpensByWindowName(t *testing.T) {
	host := startedHost(liveWindow("main"))
	registry := control.NewRegistry()
	Register(registry, Deps{Host: host, NewID: func() string { return "a1b2c3" }})

	if _, err := registry.Invoke("window_devtools", control.Args{"label": jsonString("main")}); err != nil {
		t.Fatalf("window_devtools: %v", err)
	}
	if !strings.Contains(strings.Join(host.calls, "\n"), "devtools main") {
		t.Errorf("the inspector was not opened for main; the host saw %v", host.calls)
	}

	if _, err := registry.Invoke("window_devtools", control.Args{"label": jsonString("win-gone")}); err == nil {
		t.Error("a window that is not there answered as though its inspector opened")
	}
}
