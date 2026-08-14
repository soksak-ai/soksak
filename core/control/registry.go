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
)

// Owner says who answers. Core commands are host-independent; framework
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
}

func NewRegistry() *Registry {
	return &Registry{served: map[string]Command{}, unserved: map[string]string{}}
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
// declared refusal carries its reason.
func (registry *Registry) Invoke(name string, args Args) (any, error) {
	registry.mu.RLock()
	command, served := registry.served[name]
	reason, declared := registry.unserved[name]
	registry.mu.RUnlock()

	if !served {
		if declared {
			return nil, fmt.Errorf("command %s is not served: %s", name, reason)
		}
		return nil, fmt.Errorf("command %s is not registered", name)
	}
	return command.Handler(args)
}

// Describe answers with the whole table, sorted so two readings compare.
func (registry *Registry) Describe() Table {
	registry.mu.RLock()
	defer registry.mu.RUnlock()

	commands := make([]Served, 0, len(registry.served))
	for _, command := range registry.served {
		commands = append(commands, Served{Name: command.Name, Owner: command.Owner})
	}
	sort.Slice(commands, func(i, j int) bool { return commands[i].Name < commands[j].Name })

	unserved := make([]Unserved, 0, len(registry.unserved))
	for name, blockedBy := range registry.unserved {
		unserved = append(unserved, Unserved{Name: name, BlockedBy: blockedBy})
	}
	sort.Slice(unserved, func(i, j int) bool { return unserved[i].Name < unserved[j].Name })

	return Table{Commands: commands, Unserved: unserved}
}
