// Package process owns the child processes this application starts.
//
// It starts them, streams their output, and reaps them. Nothing here reads the
// environment, the working directory, or the operating system at run time: the
// home, the inherited environment, the vault, the sink, and the spawner all
// arrive as values, so the same rules answer the same way in a window, in a
// headless server, and in a test. Platform difference is a build tag, never a
// branch.
package process

import (
	"bytes"
	"encoding/json"
	"fmt"

	"github.com/soksak/soksak-core/core/control"
)

// Deps is what the surrounding process supplies. Everything in it is injected;
// none of it is discovered.
type Deps struct {
	// Home is where SOKSAK_HOME and sidecar resolution come from.
	Home string
	// Environment is the inherited environment the launcher read, as "K=V".
	//
	// Names only: a child that inherits and
	// env_remove subtracts. Go has no such subtraction — a non-nil Env replaces
	// everything and a nil one makes os/exec read the ambient — so the values
	// travel with the names. The load-bearing half of the rule is untouched:
	// this package never calls os.Environ.
	Environment []string
	// Sink is where a child's output and exit reach a consumer.
	Sink Sink
	// Spawner nil means this host starts no children, and says so rather than
	// answering as if it had.
	Spawner Spawner
	// Secrets nil means this host holds no vault. A spawn that asks for none
	// still works; one that asks for a secret is refused by name.
	Secrets SecretSource
}

// The names this package answers to.
const (
	commandSpawn      = "process_spawn"
	commandKill       = "process_kill"
	commandList       = "process_list"
	commandWrite      = "process_write"
	commandStdinClose = "process_stdin_close"
	commandReclaim    = "process_reclaim_by_window"
)

var commandNames = []string{
	commandSpawn, commandKill, commandList,
	commandWrite, commandStdinClose, commandReclaim,
}

// The event ids a consumer subscribes to for a child's bytes and its ending.
const (
	eventOutput = "process:output"
	eventExit   = "process:exit"
)

// Reaping is what a kill answers.
//
// A bare null would read the same whether a child was reaped or there was
// never one to reap, and those are different facts.
type Reaping struct {
	Reaped bool `json:"reaped"`
}

// Register wires this package's commands and answers with the manager.
//
// The manager comes back because nothing in the six commands ends the
// application's children. A package that can be registered and never told to
// stop leaves every child alive past the app, and shutdown must not depend on
// a frontend remembering to call a seventh command.
func Register(registry *control.Registry, deps Deps) *Manager {
	manager := NewManager(deps)

	if deps.Spawner == nil {
		// Declared rather than left unknown: a caller that only hears "unknown
		// command" re-investigates settled ground, or imitates the command.
		for _, name := range commandNames {
			if err := registry.DeclareUnserved(name, "this host was given no spawner and owns no children"); err != nil {
				panic(err)
			}
		}
		return manager
	}

	registry.MustRegister(control.Command{
		Name:  commandSpawn,
		Owner: control.OwnerCore,
		Handler: func(arguments control.Args) (any, error) {
			request, err := spawnRequest(arguments)
			if err != nil {
				return nil, err
			}
			return manager.Spawn(request)
		},
	})

	registry.MustRegister(control.Command{
		Name:  commandWrite,
		Owner: control.OwnerCore,
		Handler: func(arguments control.Args) (any, error) {
			id, err := required[uint32](arguments, "id")
			if err != nil {
				return nil, err
			}
			data, err := required[string](arguments, "data")
			if err != nil {
				return nil, err
			}
			return nil, manager.Write(id, []byte(data))
		},
	})

	registry.MustRegister(control.Command{
		Name:  commandStdinClose,
		Owner: control.OwnerCore,
		Handler: func(arguments control.Args) (any, error) {
			id, err := required[uint32](arguments, "id")
			if err != nil {
				return nil, err
			}
			return nil, manager.CloseStdin(id)
		},
	})

	registry.MustRegister(control.Command{
		Name:  commandKill,
		Owner: control.OwnerCore,
		Handler: func(arguments control.Args) (any, error) {
			id, err := required[uint32](arguments, "id")
			if err != nil {
				return nil, err
			}
			reaped, err := manager.Kill(id)
			if err != nil {
				return nil, err
			}
			return Reaping{Reaped: reaped}, nil
		},
	})

	registry.MustRegister(control.Command{
		Name:    commandList,
		Owner:   control.OwnerCore,
		Handler: func(control.Args) (any, error) { return manager.List(), nil },
	})

	registry.MustRegister(control.Command{
		Name:  commandReclaim,
		Owner: control.OwnerCore,
		Handler: func(arguments control.Args) (any, error) {
			label, err := required[string](arguments, "window")
			if err != nil {
				return nil, err
			}
			return manager.ReclaimByWindow(label)
		},
	})

	return manager
}

// callbackArguments are the stream handles the transport carries.
//
// On this framework they arrive as {}: createStream answers a no-op object, so
// a child accepted with them streams into nothing while the caller believes it
// subscribed. Refusing names the events that do carry the bytes.
var callbackArguments = []string{"onStdout", "onStderr", "onExit"}

func spawnRequest(arguments control.Args) (Request, error) {
	var request Request

	for _, name := range callbackArguments {
		if _, carried := arguments[name]; carried {
			return request, fmt.Errorf(
				"process_spawn does not accept %s: subscribe to the %s and %s events instead — "+
					"a callback argument arrives here as an empty object, and the child's output would reach nobody",
				name, eventOutput, eventExit)
		}
	}

	command, err := required[string](arguments, "cmd")
	if err != nil {
		return request, err
	}
	list, err := required[[]string](arguments, "args")
	if err != nil {
		return request, err
	}
	request.Cmd, request.Args = command, list

	if request.Cwd, err = optional[string](arguments, "cwd"); err != nil {
		return request, err
	}
	if request.Env, err = optional[map[string]string](arguments, "env"); err != nil {
		return request, err
	}
	if request.EnvRemove, err = optional[[]string](arguments, "envRemove"); err != nil {
		return request, err
	}
	if request.ScrubAIEnv, err = optional[bool](arguments, "scrubAiEnv"); err != nil {
		return request, err
	}
	if request.Group, err = optional[bool](arguments, "group"); err != nil {
		return request, err
	}
	if request.Namespace, err = optional[string](arguments, "ns"); err != nil {
		return request, err
	}
	if request.SecretEnv, err = optional[map[string]string](arguments, "secretEnv"); err != nil {
		return request, err
	}
	if request.Window, err = optional[string](arguments, "window"); err != nil {
		return request, err
	}
	// An absent window stamps the child unowned. A window that is present and
	// empty is a caller naming a label that names nothing, and stamping it
	// would put the child where no reclaim can reach it.
	if supplied(arguments, "window") && request.Window == "" {
		return request, fmt.Errorf("process_spawn: window was given as an empty label — omit it to spawn an unowned child")
	}
	return request, nil
}

// required decodes an argument that must be there. Absence is named, so a
// caller learns which one it forgot rather than watching a default answer.
//
// An explicit null is absence too. json.Unmarshal leaves its destination
// untouched for null and reports no error, so a null that reached the zero
// value would answer as if the argument had been sent: a null cmd would start
// the empty program, and a null data would report a write that put no bytes
// anywhere. The transport refuses both — a null never decoded
// into a non-optional field.
func required[T any](arguments control.Args, name string) (T, error) {
	var value T
	raw, carried := arguments[name]
	if !carried {
		return value, fmt.Errorf("missing argument %q", name)
	}
	if isNull(raw) {
		// Named apart from absence: the caller did send the field, and knowing
		// that is what turns "I forgot it" into "what I put in it was empty".
		return value, fmt.Errorf("argument %q is null; omit it or send a value", name)
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return value, fmt.Errorf("argument %q: %w", name, err)
	}
	return value, nil
}

// optional decodes an argument that may be absent or null. The caller sends
// null for "not set", and null is absence rather than a decoding failure.
func optional[T any](arguments control.Args, name string) (T, error) {
	var value T
	if !supplied(arguments, name) {
		return value, nil
	}
	if err := json.Unmarshal(arguments[name], &value); err != nil {
		return value, fmt.Errorf("argument %q: %w", name, err)
	}
	return value, nil
}

func supplied(arguments control.Args, name string) bool {
	raw, carried := arguments[name]
	return carried && !isNull(raw)
}

// isNull trims first: the caller's encoder chooses the whitespace, and a value
// that reads as absent must not become a value because it arrived padded.
func isNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}
