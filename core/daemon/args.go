package daemon

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/soksak/soksak-core/core/control"
)

// Argument decoding for this group.
//
// Every helper takes the command name, so a refusal names the call as well as
// the field: `missing argument "name"` alone leaves the reader to guess which
// of six commands produced it.
//
// One rule runs through all of them. Absent, null, and empty are three
// different answers and none is promoted to a default — an empty root would
// start a daemon in whatever directory the spawner defaults to, and an empty
// name would take the table row of the daemon that has none.

// isNull is checked before decoding. Go's json leaves a destination untouched
// for null and reports no error, so a null root would arrive as "" — the one
// value that must not be reachable by accident.
func isNull(raw json.RawMessage) bool {
	return strings.TrimSpace(string(raw)) == "null"
}

// namedText reads a string that must arrive and must name something.
func namedText(command string, args control.Args, name string) (string, error) {
	raw, present := args[name]
	if !present {
		return "", fmt.Errorf("%s: missing argument %q", command, name)
	}
	if isNull(raw) {
		return "", fmt.Errorf("%s: argument %q is null; send a value", command, name)
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", fmt.Errorf("%s: argument %q is not text: %w", command, name, err)
	}
	if strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("%s: argument %q is empty — it names nothing", command, name)
	}
	return value, nil
}

// lineCount reads how many recent lines the caller wants.
func lineCount(command string, args control.Args) (int, error) {
	raw, present := args["lines"]
	if !present || isNull(raw) {
		return defaultLines, nil
	}
	var value int
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, fmt.Errorf("%s: argument %q is not a count: %w", command, "lines", err)
	}
	if value < 1 {
		return 0, fmt.Errorf("%s: argument %q is %d — ask for at least one line, or leave it out for %d", command, "lines", value, defaultLines)
	}
	return value, nil
}

// runSeconds reads the deadline a run-once was given.
func runSeconds(command string, args control.Args) (time.Duration, error) {
	raw, present := args["timeoutSecs"]
	if !present || isNull(raw) {
		// No invented default. A command with no deadline is one that can hold
		// the caller forever, and only the caller has how long its
		// build takes.
		return 0, fmt.Errorf("%s: missing argument %q — a run with no deadline never comes back", command, "timeoutSecs")
	}
	var seconds float64
	if err := json.Unmarshal(raw, &seconds); err != nil {
		return 0, fmt.Errorf("%s: argument %q is not a number of seconds: %w", command, "timeoutSecs", err)
	}
	if seconds <= 0 {
		return 0, fmt.Errorf("%s: argument %q is %v — a deadline that has already passed stops the command before it starts", command, "timeoutSecs", seconds)
	}
	return time.Duration(seconds * float64(time.Second)), nil
}

// environmentOverrides reads the entries a run-once adds to a child's
// environment. release.publish sends the GitHub token this way rather than
// writing it into the shell line, where it would be readable in a process list.
func environmentOverrides(command string, args control.Args) (map[string]string, error) {
	raw, present := args["env"]
	if !present || isNull(raw) {
		return nil, nil
	}
	var overrides map[string]string
	if err := json.Unmarshal(raw, &overrides); err != nil {
		return nil, fmt.Errorf("%s: argument %q is not a table of name to value: %w", command, "env", err)
	}
	for name := range overrides {
		if strings.TrimSpace(name) == "" || strings.Contains(name, "=") {
			return nil, fmt.Errorf("%s: argument %q carries the name %q — an environment name is not empty and holds no '='", command, "env", name)
		}
	}
	return overrides, nil
}

// recordedDaemons reads the pids a previous run wrote down.
func recordedDaemons(command string, args control.Args) ([]Recorded, error) {
	raw, present := args["entries"]
	if !present {
		return nil, fmt.Errorf("%s: missing argument %q", command, "entries")
	}
	if isNull(raw) {
		return nil, fmt.Errorf("%s: argument %q is null; send the recorded pairs, or an empty list", command, "entries")
	}
	var records []Recorded
	if err := json.Unmarshal(raw, &records); err != nil {
		return nil, fmt.Errorf("%s: argument %q: %w", command, "entries", err)
	}
	return records, nil
}

// refuseRestartPolicy answers whether the caller asked for something this build
// does not do.
//
// The frontend sends `restart: null`, which is the only shape here. A policy
// that was accepted and never acted on would leave a daemon that exited at 3am
// down until somebody looked, while the caller believed it was being kept up.
func refuseRestartPolicy(command string, args control.Args) error {
	raw, present := args["restart"]
	if !present || isNull(raw) {
		return nil
	}
	return fmt.Errorf("%s: argument %q asks for a restart policy and nothing in this build restarts a daemon — "+
		"its exit code is reported by daemon_status, and starting it again is the caller's call", command, "restart")
}

// optionalText reads a string the caller may leave out. The caller spells
// "not set" as JSON null, which is what the frontend sends (`id: p.id ?? null`,
// `name: name ?? null`).
//
// An empty string is not "not set": it is a variable that never got a value.
// A daemon_stop with one would address every daemon under a project, and a
// schedule registered with one would be minted a name the caller never sees.
func optionalText(command string, args control.Args, name string) (string, error) {
	raw, present := args[name]
	if !present || isNull(raw) {
		return "", nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", fmt.Errorf("%s: argument %q is not text: %w", command, name, err)
	}
	if strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("%s: argument %q is empty — send null to leave it unset", command, name)
	}
	return value, nil
}

// epochMillis reads a moment. It must arrive: a schedule with no time is not a
// schedule, and defaulting to now would fire it immediately.
func epochMillis(command string, args control.Args, name string) (int64, error) {
	raw, present := args[name]
	if !present || isNull(raw) {
		return 0, fmt.Errorf("%s: missing argument %q — a schedule with no moment has none to fire at", command, name)
	}
	var value int64
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, fmt.Errorf("%s: argument %q is not a moment in epoch milliseconds: %w", command, name, err)
	}
	if value <= 0 {
		// Zero is what an unset field decodes to. A schedule at the epoch would
		// fire at once, which is the opposite of what a caller who lost its
		// timestamp wanted.
		return 0, fmt.Errorf("%s: argument %q is %d, which is not a moment — epoch milliseconds are positive", command, name, value)
	}
	return value, nil
}

// commandParams reads the object a scheduled command is fired with.
//
// Absent is an empty object rather than an error: a command that takes no
// parameters is ordinary. It stays encoded, because what the parameters mean is
// the fired command's business and decoding them here would need this package
// to know every command's shape.
func commandParams(command string, args control.Args) (control.Args, error) {
	raw, present := args["params"]
	if !present || isNull(raw) {
		return control.Args{}, nil
	}
	var params map[string]json.RawMessage
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, fmt.Errorf("%s: argument %q is not an object of arguments: %w", command, "params", err)
	}
	return control.Args(params), nil
}
