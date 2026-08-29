package wails

import (
	"github.com/soksak-ai/soksak-core/core/control"
)

// HostDeps is everything this framework's command groups need.
//
// The values arrive from Run, where the application and its window exist. A
// test supplies the same shapes without either.
type HostDeps struct {
	// Host answers about the windows this process holds.
	Host WindowHost
	// Clipboard is the framework's native clipboard. Core and plugins never import the framework;
	// they reach it only through clipboard_read and clipboard_write.
	Clipboard ClipboardHost
	// Presentation is the process-wide desktop policy reported through app.environment.
	Presentation PresentationMode
	// NewID mints a window name.
	NewID func() string
	// A field for plugin command groups stood here until 2026-08-20, so a build could hand this host
	// registrations of its own. Nothing can fill it: a plugin is installed rather than compiled
	// (C1a), so no Go package of a plugin's exists to register anything, and the commands a plugin
	// contributes are declared in its manifest and registered by its own entry.
	//
	// It is gone rather than kept empty. A seam with no possible user reads as a shape somebody is
	// meant to use, and the next person wires a plugin package into it.
	// Composition is the applied native inventory the surface commands read.
	Composition CompositionSource
	// Frames delivers stream frames to a receiver the caller passed. Nil sends
	// nothing, which is a build with no event bus rather than a silent drop.
	Frames StreamSink
	// Reaper is what this host takes down before it quits, and Quit ends the
	// process. Both arrive here rather than being registered beside RegisterHost,
	// because a group registered elsewhere is one the coverage gate and the
	// application disagree about.
	Reaper  Reaper
	Release func() error
	Quit    func()
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
	RegisterClipboard(registry, deps.Clipboard)
	RegisterPresentation(registry, deps.Presentation)
	renderer := RegisterRendererCommands(registry, deps.Dispatch)
	Register(registry, Deps{Host: deps.Host, NewID: deps.NewID})
	RegisterCapture(registry, deps.Host, deps.Frames, deps.Presentation)
	RegisterWindowInput(registry, deps.Host)
	RegisterShutdown(registry, ShutdownDeps{Reaper: deps.Reaper, Release: deps.Release, Quit: deps.Quit})
	// The readings over a recording need no window, so they answer in a process
	// with none — a recording outlives the session it was taken in.
	RegisterAnalyze(registry)
	// Each window has its own theme, so the colour goes to the window that
	// requested it rather than to the one this host happened to capture.
	RegisterBackground(registry, deps.Host)
	RegisterSurface(registry, SurfaceDeps{
		Composition:  deps.Composition,
		NativeParent: deps.NativeParent,
	})
	return renderer
}
