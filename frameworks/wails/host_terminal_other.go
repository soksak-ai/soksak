//go:build !darwin

package wails

import (
	"log"

	terminalsurface "github.com/min-median-max/wails-service-terminal-surface"
)

// This platform has no surface channel; the refusal is logged by name once at
// boot (SPEC §2) and the terminal backend serves its inventory without pixels.
func wireTerminalChannel(_ *terminalsurface.Backend, _ *terminalsurface.Sessions, identity string, _ func(event string, payload any)) {
	_, err := terminalsurface.OpenChannel(identity)
	log.Printf("terminal surface channel: %v", err)
}
