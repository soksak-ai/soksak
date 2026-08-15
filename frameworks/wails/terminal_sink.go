package wails

import (
	"encoding/json"
	"log"

	terminal "github.com/soksak/soksak-plugin-terminal-xterm"

	"github.com/soksak/soksak-core/core/control"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// One event carries every stream's frames. A backend that invented an event per
// feature would have the frontend refuse each one it never declared, and the
// refusal reads as a broken feature — measured 2026-08-15, the terminal emitted
// terminal:output and the plugin bus refused it by name.
func init() {
	application.RegisterEvent[control.StreamFrame](control.StreamEvent)
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

// EmitStream carries one frame to the receiver the caller passed.
//
// Nothing here is about terminals: the stream id came from the caller and the
// frame is whatever the backend produced. Any backend that receives a stream
// argument delivers through this.
func (sink *TerminalSink) EmitStream(stream string, frame any) {
	sink.bridge.Emit(control.StreamEvent, control.StreamFrame{Stream: stream, Frame: frame})
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
