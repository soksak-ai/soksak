package wails

import (
	"fmt"

	"github.com/soksak-ai/soksak-core/core/control"
)

// RegisterBackground lets a window colour itself.
//
// The document paints transparent, so the window's own colour is what shows
// through every region no component painted. The theme therefore has to reach
// the window, and it has to reach the window that asked: this host held one
// window captured at registration, so a workspace window's theme repainted the
// orchestrator and left its own panes the framework's default. Measured
// 2026-08-15 — one dark theme selected, a dark orchestrator, and white panes in
// the workspace window.
func RegisterBackground(registry *control.Registry, host WindowHost) {
	if host == nil {
		panic("wails: the background command needs a WindowHost")
	}

	registry.MustRegister(control.Command{
		Name:  "window_set_background",
		Owner: control.OwnerFramework,
		Handler: func(args control.Args) (any, error) {
			colour, err := control.Arg[string](args, "color")
			if err != nil {
				return nil, err
			}
			// Stamped by the transport, never sent by the caller: a window that
			// could name another one could repaint it, and the two themes would
			// then depend on which window rendered last.
			window, err := control.Arg[string](args, control.CallerWindowArgument)
			if err != nil {
				return nil, fmt.Errorf("window_set_background: %w", err)
			}
			return nil, host.SetBackground(window, colour)
		},
	})
}
