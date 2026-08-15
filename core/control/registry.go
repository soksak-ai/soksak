// Package control is the command registry.
//
// Commands are registered once and reached through every transport. A caller
// cannot tell whether it arrived from the frontend, a socket, or an agent, and
// none of them may bypass the registry — a second path drifts from the first,
// and the drift stays quiet until the two give different answers.
package control

import (
	"encoding/json"
	"fmt"
	"sort"
	"sync"

	"github.com/soksak/soksak-core/core/i18n"
)

// Owner names who answers. Core commands are host-independent; framework
// commands need this host's window.
type Owner string

const (
	OwnerCore      Owner = "core"
	OwnerFramework Owner = "framework"
	OwnerPlugin    Owner = "plugin"
)

// Args are the caller's parameters. Values a process holds — identity, home,
// database path — are boot state and never arrive here.
type Args map[string]json.RawMessage

// Handler answers one command.
type Handler func(Args) (any, error)

// Command is one registered entry.
type Command struct {
	Name    string
	Owner   Owner
	Handler Handler
}

// Served describes a command this build answers.
type Served struct {
	Name  string `json:"name"`
	Owner Owner  `json:"owner"`
}

// Unserved describes a command this build refuses, and why.
type Unserved struct {
	Name string `json:"name"`
	// BlockedBy separates "not written yet" from "impossible here". A caller
	// that receives only "unknown command" re-investigates settled ground, or
	// imitates the command.
	BlockedBy string `json:"blockedBy"`
}

// Table is what this build serves and what it refuses, together.
type Table struct {
	Commands []Served   `json:"commands"`
	Unserved []Unserved `json:"unserved"`
}

// Registry holds every command in this process.
type Registry struct {
	mu       sync.RWMutex
	served   map[string]Command
	unserved map[string]string
	// delegated is what something else answers — a renderer, a sidecar. Held
	// beside served rather than inside it so a delegation can never shadow a
	// command this process is responsible for.
	delegated map[string]delegation
	sources   map[string][]string
}

func NewRegistry() *Registry {
	return &Registry{
		served:    map[string]Command{},
		unserved:  map[string]string{},
		delegated: map[string]delegation{},
		sources:   map[string][]string{},
	}
}

// Register adds a command. Two owners for one name is a conflict rather than a
// reload: silently replacing would let a later registration answer in an
// earlier one's place.
func (registry *Registry) Register(command Command) error {
	if command.Name == "" {
		return fmt.Errorf("control: a command needs a name")
	}
	if command.Handler == nil {
		return fmt.Errorf("control: command %s has no handler", command.Name)
	}
	registry.mu.Lock()
	defer registry.mu.Unlock()
	if _, exists := registry.served[command.Name]; exists {
		return fmt.Errorf("control: command %s is already registered", command.Name)
	}
	if elsewhere, delegated := registry.delegated[command.Name]; delegated {
		return fmt.Errorf("control: command %s is delegated to %s", command.Name, elsewhere.source)
	}
	if command.Owner == "" {
		command.Owner = OwnerCore
	}
	registry.served[command.Name] = command
	delete(registry.unserved, command.Name)
	return nil
}

// MustRegister panics on conflict. Boot-time registration is a programming
// fact, not a runtime condition.
func (registry *Registry) MustRegister(command Command) {
	if err := registry.Register(command); err != nil {
		panic(err)
	}
}

// DeclareUnserved records a command this build cannot answer, and why.
func (registry *Registry) DeclareUnserved(name, blockedBy string) error {
	if blockedBy == "" {
		return fmt.Errorf("control: command %s must declare why it is unserved", name)
	}
	registry.mu.Lock()
	defer registry.mu.Unlock()
	registry.unserved[name] = blockedBy
	return nil
}

// Invoke runs a command. An unknown name fails carrying that name, and a
// declared refusal states its reason.
func (registry *Registry) Invoke(name string, args Args) (any, error) {
	registry.mu.RLock()
	command, served := registry.served[name]
	elsewhere, delegated := registry.delegated[name]
	reason, declared := registry.unserved[name]
	registry.mu.RUnlock()

	if !served {
		if delegated {
			// Answered somewhere else in this process. The caller is told
			// nothing about that: one table, and where a command runs is not
			// the caller's business.
			return elsewhere.forward(name, args)
		}
		if declared {
			return nil, i18n.Errorf("control.invoke.unserved", map[string]string{"name": name, "reason": reason})
		}
		return nil, i18n.Errorf("control.invoke.unknown", map[string]string{"name": name})
	}
	return command.Handler(args)
}

// Describe answers with the whole table, sorted so two readings compare.
func (registry *Registry) Describe() Table {
	registry.mu.RLock()
	defer registry.mu.RUnlock()

	commands := make([]Served, 0, len(registry.served)+len(registry.delegated))
	for _, command := range registry.served {
		commands = append(commands, Served{Name: command.Name, Owner: command.Owner})
	}
	// Delegated names are served. A table that listed only what this process
	// runs itself would tell a caller a command does not exist while another
	// transport answers it.
	for name, elsewhere := range registry.delegated {
		commands = append(commands, Served{Name: name, Owner: elsewhere.owner})
	}
	sort.Slice(commands, func(i, j int) bool { return commands[i].Name < commands[j].Name })

	unserved := make([]Unserved, 0, len(registry.unserved))
	for name, blockedBy := range registry.unserved {
		unserved = append(unserved, Unserved{Name: name, BlockedBy: blockedBy})
	}
	sort.Slice(unserved, func(i, j int) bool { return unserved[i].Name < unserved[j].Name })

	return Table{Commands: commands, Unserved: unserved}
}

// CallerWindowArgument is where a transport stamps the window a call came from.
//
// It is an argument rather than a separate channel so a handler reads it the
// way it reads everything else. The rule that makes it trustworthy is that the
// transport overwrites it: a caller may send this name and will never be
// believed.
const CallerWindowArgument = "window"

// Caller is what the transport has about who is calling.
//
// The frontend transport has it because the framework stamps which window made
// the call. The socket has it because whoever holds a 0600 socket may already do
// anything the application can, so naming a window there is a statement rather
// than a claim to check.
type Caller struct {
	// Window is the window this call is made on behalf of. Empty means the
	// caller named none, and a command that needs one refuses by name.
	Window string
}

// InvokeFrom runs a command with the caller stamped onto its arguments.
//
// Every transport uses this. Invoke remains for callers that are the process
// itself, where there is no window to attribute the call to.
func (registry *Registry) InvokeFrom(caller Caller, name string, args Args) (any, error) {
	stamped := make(Args, len(args)+1)
	for key, value := range args {
		stamped[key] = value
	}
	if caller.Window == "" {
		// Removed rather than left as sent. A caller who supplies it and is not
		// contradicted would otherwise be believed by omission.
		delete(stamped, CallerWindowArgument)
	} else {
		encoded, err := json.Marshal(caller.Window)
		if err != nil {
			return nil, err
		}
		stamped[CallerWindowArgument] = encoded
	}
	return registry.Invoke(name, stamped)
}
