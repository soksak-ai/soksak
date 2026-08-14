package wails

import (
	"encoding/json"
	"log"

	terminal "github.com/soksak/soksak-plugin-terminal-xterm"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// The terminal plugin owns PTY bytes and knows nothing about how they reach a
// window. This sink is the framework half of that contract.
func init() {
	application.RegisterEvent[terminal.Output]("terminal:output")
}

type terminalEventSink struct {
	app        *application.App
	traceInput bool
}

func (sink *terminalEventSink) EmitTerminalOutput(output terminal.Output) {
	if sink.app == nil {
		return
	}
	sink.app.Event.Emit("terminal:output", output)
}

// EmitTerminalInputTrace logs one line per keystroke when tracing is on. It is a
// diagnostic channel, not a delivery path, so a marshalling failure is dropped
// rather than surfaced — the terminal itself is unaffected either way.
func (sink *terminalEventSink) EmitTerminalInputTrace(handle terminal.Handle, event terminal.InputTrace) {
	if !sink.traceInput {
		return
	}
	encoded, err := json.Marshal(struct {
		Handle terminal.Handle     `json:"handle"`
		Event  terminal.InputTrace `json:"event"`
	}{Handle: handle, Event: event})
	if err != nil {
		return
	}
	log.Printf("terminal-input-trace %s", encoded)
}
