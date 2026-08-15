package control

import "github.com/soksak/soksak-core/core/i18n"

// A delegated command is answered somewhere this process can reach but does not
// run: a renderer, a sidecar, a window.
//
// It exists because the alternative was worse. The renderer owns the DOM, the
// layout tree and the view registry, and it registered those commands only
// inside its own page — so the one door that could reach them was a second
// application instance with a debugging server compiled in. That is not a
// control plane; it is another window.
//
// Delegated names are on the same table as everything else. A caller cannot
// tell where a command runs, which is the point: `sok ui.tree` and a button
// click resolve the same entry.
type delegation struct {
	source  string
	owner   Owner
	forward func(name string, args Args) (any, error)
}

// Delegate hands a set of names to a source that answers them elsewhere.
//
// Declaring again replaces that source's whole set rather than adding to it: a
// renderer that reloads has a new catalogue, and names it no longer serves must
// stop being answerable — otherwise a reload leaves entries pointing at a page
// that is gone.
//
// A name this process serves itself is refused rather than shadowed. Two
// answers under one name is the drift the single registry exists to prevent,
// and the local one is the one with a test.
func (registry *Registry) Delegate(source string, owner Owner, names []string, forward func(name string, args Args) (any, error)) error {
	if source == "" {
		return i18n.Errorf("control.delegate.noSource", nil)
	}
	if forward == nil {
		return i18n.Errorf("control.delegate.noForwarder", map[string]string{"source": source})
	}

	registry.mu.Lock()
	defer registry.mu.Unlock()

	for _, name := range names {
		if name == "" {
			return i18n.Errorf("control.delegate.emptyCommand", map[string]string{"source": source})
		}
		if _, local := registry.served[name]; local {
			return i18n.Errorf("control.delegate.servedLocally", map[string]string{"source": source, "command": name})
		}
		if existing, taken := registry.delegated[name]; taken && existing.source != source {
			return i18n.Errorf("control.delegate.alreadyDelegated", map[string]string{"source": source, "command": name, "holder": existing.source})
		}
	}

	for _, name := range registry.sources[source] {
		delete(registry.delegated, name)
	}
	held := make([]string, 0, len(names))
	for _, name := range names {
		registry.delegated[name] = delegation{source: source, owner: owner, forward: forward}
		held = append(held, name)
	}
	registry.sources[source] = held
	return nil
}

// Withdraw removes a source's names.
//
// A window that closed answers nothing, and leaving its names on the table
// makes the next caller wait for a reply that cannot come. "This build has no
// such command" is the truth once the source is gone.
func (registry *Registry) Withdraw(source string) {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	for _, name := range registry.sources[source] {
		delete(registry.delegated, name)
	}
	delete(registry.sources, source)
}

// Delegated answers which names a source currently holds, in the order it
// declared them.
func (registry *Registry) Delegated(source string) []string {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	held := registry.sources[source]
	out := make([]string, len(held))
	copy(out, held)
	return out
}

// ServedLocally reports that this process answers the name itself, rather than passing
// it on. A delegation asking for it would be refused, and the source deserves
// to hear which name rather than a verdict about the whole set.
func (registry *Registry) ServedLocally(name string) bool {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	_, local := registry.served[name]
	return local
}
