package wails

import (
	"encoding/json"
	"log"

	"github.com/soksak-ai/soksak-core/core/control"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// One event delivers every stream's frames. A backend that invented an event per
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
// Output produced before the application exists is delivered to nobody, which is the
// truth rather than a dropped delivery: no window is open to show it.
func NewTerminalSink(bridge *Bridge, traceInput bool) *TerminalSink {
	return &TerminalSink{bridge: bridge, traceInput: traceInput}
}

// EmitStream delivers one frame to the receiver the caller passed.
//
// Nothing here is about terminals: the stream id came from the caller and the
// frame is whatever the backend produced. Any backend that receives a stream
// argument delivers through this.
func (sink *TerminalSink) EmitStream(stream string, frame any) {
	sink.bridge.Emit(control.StreamEvent, control.StreamFrame{Stream: stream, Frame: frame})
}

// Trace writes one diagnostic record where a developer reads it, and names none
// of them (control.TraceSink).
//
// It took the terminal plugin's own Handle and InputTrace to marshal them and
// log them — a host that is meant to know no plugin, holding two of one
// plugin's types for a body that never looks inside either. The record is
// whatever the producer holds now, and the kind is whose it is.
//
// A diagnostic channel, not a delivery path: a record that will not encode is
// dropped rather than surfaced, because a channel that can stop the thing it
// observes is worse than no channel.
func (sink *TerminalSink) Trace(kind string, record any) {
	if !sink.traceInput {
		return
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return
	}
	log.Printf("trace %s %s", kind, encoded)
}
