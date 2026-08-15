package control

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// Go's json package treats null as a no-op for most destinations: the value
// keeps its zero and no error comes back. So a required argument sent as null
// decodes to 0, "", or false and a handler cannot tell that from a caller who
// meant it.
//
// Found 2026-08-15: window_place with "x": null placed the window at x=0 and
// reported success. Present-but-null is a caller error, not a value.
func isNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// Arg decodes one required argument.
//
// The registry is typed per command rather than at the transport boundary, so
// each handler decodes what it needs. A missing or null argument is named: a
// caller that receives a zero value cannot tell it apart from one it sent.
func Arg[T any](args Args, name string) (T, error) {
	var value T
	raw, present := args[name]
	if !present {
		return value, fmt.Errorf("missing argument %q", name)
	}
	if isNull(raw) {
		return value, fmt.Errorf("argument %q is null; omit it or send a value", name)
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return value, fmt.Errorf("argument %q: %w", name, err)
	}
	return value, nil
}

// OptionalArg decodes an argument that may be absent, answering the fallback
// when it is.
//
// Absence and null are the same answer here — the caller did not choose. A
// wrong type is still refused: optional means "you may leave it out", never
// "send anything".
func OptionalArg[T any](args Args, name string, fallback T) (T, error) {
	raw, present := args[name]
	if !present || isNull(raw) {
		return fallback, nil
	}
	var value T
	if err := json.Unmarshal(raw, &value); err != nil {
		return fallback, fmt.Errorf("argument %q: %w", name, err)
	}
	return value, nil
}

// RawArg returns an argument still encoded, for handlers that pass a document
// through rather than reading into it.
//
// Null is refused: a handler passing the document on would write the four bytes
// "null" in place of a document.
func RawArg(args Args, name string) (json.RawMessage, error) {
	raw, present := args[name]
	if !present {
		return nil, fmt.Errorf("missing argument %q", name)
	}
	if isNull(raw) {
		return nil, fmt.Errorf("argument %q is null; omit it or send a document", name)
	}
	return raw, nil
}
