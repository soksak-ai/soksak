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

// TerminalSink is the framework half of that contract. The launcher builds it,
// because the session owner it feeds is the launcher's to construct: a PTY
// needs no window, and a host that owned it would make terminals a thing only a
// windowed process can have.
type TerminalSink struct {
	bridge     *Bridge
	traceInput bool
}

// NewTerminalSink builds the sink over a bridge that Run has not filled yet.
// Output produced before the application exists reaches nobody, which is the
// truth rather than a dropped delivery: no window is open to show it.
func NewTerminalSink(bridge *Bridge, traceInput bool) *TerminalSink {
	return &TerminalSink{bridge: bridge, traceInput: traceInput}
}

func (sink *TerminalSink) EmitTerminalOutput(output terminal.Output) {
	sink.bridge.Emit("terminal:output", output)
}

// EmitTerminalInputTrace logs one line per keystroke when tracing is on. It is a
// diagnostic channel, not a delivery path, so a marshalling failure is dropped
// rather than surfaced — the terminal itself is unaffected either way.
func (sink *TerminalSink) EmitTerminalInputTrace(handle terminal.Handle, event terminal.InputTrace) {
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
