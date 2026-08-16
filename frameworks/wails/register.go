package wails

import (
	terminalcmd "github.com/soksak/soksak-plugin-terminal-xterm/command"

	"github.com/soksak/soksak-core/core/control"
)

// HostDeps is everything this framework's command groups need.
//
// The values arrive from Run, where the application and its window exist. A
// test supplies the same shapes without either.
type HostDeps struct {
	// Host answers about the windows this process holds.
	Host WindowHost
	// NewID mints a window name.
	NewID func() string
	// Sessions is the terminal owner. The terminal is a plugin: it registers
	// its own command group, and this is the owner the group routes to.
	Sessions terminalcmd.Sessions
	// Composition is the applied native inventory the surface commands read.
	Composition CompositionSource
	// Surfaces is where a capture gets the pixels of content that draws outside this process.
	// Absent, a capture is the window layer alone and a native pane comes back flat.
	Surfaces SurfaceImages
	// Frames delivers stream frames to a receiver the caller passed. Nil sends
	// nothing, which is a build with no event bus rather than a silent drop.
	Frames StreamSink
	// NativeParent reports whether the named window's native container exists
	// right now.
	NativeParent func(window string) bool
	// Dispatch delivers one request to one window's page.
	Dispatch func(target, event string, payload any) error
}

// RegisterHost puts every command this framework owns on the registry.
//
// One function, called by Run and by the coverage gate. Two lists drift in both
// directions at once and neither side reports it: measured 2026-08-15, the gate
// registered the surface group the application never did, and the application
// registered capture and background the gate never did. The gate then read
// window_snapshot as unserved while the running process answered it, and read
// the surface commands as served while the running process answered "unknown
// command".
//
// Registering is separate from Run because a registration needs only these
// values, and a test that had to start an application to see the table would be
// measuring the framework's startup rather than the table.
func RegisterHost(registry *control.Registry, deps HostDeps) *RendererCommands {
	renderer := RegisterRendererCommands(registry, deps.Dispatch)
	terminalcmd.Register(registry, terminalcmd.Deps{Sessions: deps.Sessions})
	Register(registry, Deps{Host: deps.Host, NewID: deps.NewID})
	RegisterCapture(registry, deps.Host, deps.Surfaces, deps.Frames)
	// Each window has its own theme, so the colour goes to the window that
	// requested it rather than to the one this host happened to capture.
	RegisterBackground(registry, deps.Host)
	RegisterSurface(registry, SurfaceDeps{
		Composition:  deps.Composition,
		NativeParent: deps.NativeParent,
	})
	return renderer
}
