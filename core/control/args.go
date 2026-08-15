package control

import (
	"encoding/json"
	"fmt"
)

// Arg decodes one named argument.
//
// The registry is typed per command rather than at the transport boundary, so
// each handler decodes what it needs. A missing argument is named: a caller
// that receives a zero value cannot tell it apart from one that was sent.
func Arg[T any](args Args, name string) (T, error) {
	var value T
	raw, present := args[name]
	if !present {
		return value, fmt.Errorf("missing argument %q", name)
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return value, fmt.Errorf("argument %q: %w", name, err)
	}
	return value, nil
}

// OptionalArg decodes an argument that may be absent, answering the fallback
// when it is. Absence and an explicit null both yield the fallback: a caller
// omitting a field and a caller sending null mean the same thing here.
func OptionalArg[T any](args Args, name string, fallback T) (T, error) {
	raw, present := args[name]
	if !present || string(raw) == "null" {
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
func RawArg(args Args, name string) (json.RawMessage, error) {
	raw, present := args[name]
	if !present {
		return nil, fmt.Errorf("missing argument %q", name)
	}
	return raw, nil
}
