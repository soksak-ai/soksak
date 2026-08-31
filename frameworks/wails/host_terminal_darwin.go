//go:build darwin

package wails

import (
	"log"
	"time"

	terminalsurface "github.com/soksak-ai/soksak-service-terminal-surface"
)

// wireTerminalChannel checks the surface channel in and hands it to the
// backend. A refusal is logged by name at boot and the application runs on —
// every pane simply has no pixels until a channel exists.
func wireTerminalChannel(backend *terminalsurface.Backend, sessions *terminalsurface.Sessions, identity string, emit func(event string, payload any)) {
	channel, err := terminalsurface.OpenChannel(identity)
	if err != nil {
		log.Printf("terminal surface channel: %v", err)
		return
	}
	channel.OnFrame = terminalStateNotifier(sessions.NoteFrame, emit, time.Now)
	backend.UseChannel(channel)
	sessions.UseBinder(channel)
}
