package control

import (
	"encoding/base64"
	"encoding/json"
	"fmt"

	"github.com/soksak/soksak-core/core/i18n"
)

// A stream is a receiver the caller creates and passes as a command argument.
//
// Some commands produce frames rather than one answer: a shell's bytes, a
// child process's stdout, a sidecar's events. The caller cannot poll for them —
// there is no end to poll toward — and a reply value cannot carry them, because
// they arrive after the reply.
//
// The caller passes {"__stream": "<id>"} where the argument goes. Frames come
// back as events named StreamEvent, each carrying that id. One event name for
// every stream is what keeps a backend from inventing an event per feature: an
// event nobody declared is one the frontend refuses, and the refusal reads as a
// broken feature rather than a missing declaration (measured 2026-08-15, the
// terminal emitted terminal:output and the plugin bus refused it by name).
const (
	// StreamEvent is the one event every stream frame arrives on.
	StreamEvent = "stream"
	// streamKey is the argument field naming a stream id.
	streamKey = "__stream"
)

// StreamFrame is one frame on its way to a receiver.
type StreamFrame struct {
	// Stream is the id the caller minted. A receiver reads only its own.
	Stream string `json:"stream"`
	// Frame is the value. Bytes travel as StreamBytes; anything else is the
	// value itself.
	Frame any `json:"frame"`
}

// StreamBytes is a binary frame.
//
// JSON has no byte string, so bytes travel base64 under a field named for it.
// Sending them as a bare string would make a receiver guess whether a text
// frame is text or base64, and it would guess wrong for either one.
type StreamBytes struct {
	Bytes string `json:"bytes"`
}

// Bytes builds a binary frame.
func Bytes(data []byte) StreamBytes {
	return StreamBytes{Bytes: base64.StdEncoding.EncodeToString(data)}
}

// StreamArg reads the stream id a caller passed under name.
//
// An argument that is present but not a stream reference is refused rather than
// treated as absent: the caller meant to receive frames, and a silent absence
// makes a stream that never delivers look like a backend that produces nothing.
func StreamArg(args Args, name string) (string, error) {
	raw, present := args[name]
	if !present {
		return "", i18n.Errorf("control.stream.missing", map[string]string{"name": name, "key": streamKey})
	}
	var reference struct {
		ID string `json:"__stream"`
	}
	if err := json.Unmarshal(raw, &reference); err != nil {
		return "", fmt.Errorf("argument %q is not a stream receiver: %w", name, err)
	}
	if reference.ID == "" {
		return "", i18n.Errorf("control.stream.noID", map[string]string{"name": name, "key": streamKey})
	}
	return reference.ID, nil
}

// OptionalStreamArg reads a stream id that the caller may omit.
//
// Absence is a caller that wants no frames. A malformed reference is still a
// refusal — it is an attempt to receive, not a decision not to.
func OptionalStreamArg(args Args, name string) (string, bool, error) {
	raw, present := args[name]
	if !present || string(raw) == "null" {
		return "", false, nil
	}
	id, err := StreamArg(args, name)
	if err != nil {
		return "", false, err
	}
	return id, true, nil
}
