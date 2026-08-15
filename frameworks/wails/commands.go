package wails

import (
	"encoding/json"
	"fmt"

	"github.com/soksak/soksak-core/core/control"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// registerWindowCommands adds the commands that only a host with a window can
// answer.
//
// They live here rather than in the core because there is no host-independent
// answer to them: a process with no window has no background to set and no
// pending envelope to resend. The core registry stays answerable headlessly
// precisely because these are not in it.
func registerWindowCommands(registry *control.Registry, app *application.App, window application.Window) {
	registry.MustRegister(control.Command{
		Name:  "window_set_background",
		Owner: control.OwnerFramework,
		Handler: func(args control.Args) (any, error) {
			raw, present := args["color"]
			if !present {
				return nil, fmt.Errorf("missing argument %q", "color")
			}
			var colour string
			if err := json.Unmarshal(raw, &colour); err != nil {
				return nil, fmt.Errorf("argument %q: %w", "color", err)
			}
			// The document paints transparent, so unpainted regions show the
			// window's own colour. It has to follow the theme or the two
			// disagree at every edge.
			//
			// This is our window, not "the current one": Current() answers with
			// whatever holds focus, and a capture or a background theme change
			// happens precisely when focus is elsewhere.
			if window == nil {
				return nil, fmt.Errorf("no window to colour")
			}
			window.SetBackgroundColour(parseColour(colour))
			return nil, nil
		},
	})

	registry.MustRegister(control.Command{
		Name:  "cmd_listener_ready",
		Owner: control.OwnerFramework,
		// A window announces it can receive again. Nothing is pending yet
		// because envelope routing is not built, so the honest answer is zero
		// resent rather than a silent success.
		Handler: func(control.Args) (any, error) { return 0, nil },
	})

	registry.MustRegister(control.Command{
		Name:  "webview_recovery_consume",
		Owner: control.OwnerFramework,
		// Whether this window is resuming from a webview recovery. No recovery
		// has been recorded, so it is not.
		Handler: func(control.Args) (any, error) { return false, nil },
	})

	registry.MustRegister(control.Command{
		Name:  "project_owners",
		Owner: control.OwnerFramework,
		// Which window holds which project root. The ledger is per-process
		// mutable state held by whoever owns windows; with one window and no
		// project opened, nothing is claimed.
		Handler: func(control.Args) (any, error) { return []any{}, nil },
	})

	registry.MustRegister(control.Command{
		Name:  "control_owner_answered",
		Owner: control.OwnerFramework,
		// Which commands this host answers, told to whoever routes to it. There
		// is no external router yet, so the names are accepted and go nowhere —
		// waiting for a reply here would hold boot on a peer that does not exist.
		Handler: func(control.Args) (any, error) { return nil, nil },
	})
}

// parseColour reads #rgb, #rrggbb, or #rrggbbaa. An unreadable colour falls
// back to opaque black rather than failing the command: a wrong background is
// visible and recoverable, a failed boot is not.
func parseColour(value string) application.RGBA {
	rgba := application.RGBA{Alpha: 255}
	if len(value) == 0 || value[0] != '#' {
		return rgba
	}
	digits := value[1:]
	if len(digits) == 3 {
		expanded := make([]byte, 0, 6)
		for i := 0; i < 3; i++ {
			expanded = append(expanded, digits[i], digits[i])
		}
		digits = string(expanded)
	}
	if len(digits) != 6 && len(digits) != 8 {
		return rgba
	}
	var red, green, blue, alpha uint8 = 0, 0, 0, 255
	if _, err := fmt.Sscanf(digits[0:2], "%02x", &red); err != nil {
		return rgba
	}
	if _, err := fmt.Sscanf(digits[2:4], "%02x", &green); err != nil {
		return rgba
	}
	if _, err := fmt.Sscanf(digits[4:6], "%02x", &blue); err != nil {
		return rgba
	}
	if len(digits) == 8 {
		if _, err := fmt.Sscanf(digits[6:8], "%02x", &alpha); err != nil {
			return rgba
		}
	}
	return application.RGBA{Red: red, Green: green, Blue: blue, Alpha: alpha}
}
