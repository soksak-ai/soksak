package process

import (
	"sort"
	"strings"
)

// AISessionEnv is the canonical list of AI session context variables.
//
// A child that inherits these (claude and friends) recognises itself as an
// agent inside an agent, and its session identification goes wrong: transcript
// attribution and the nesting guard both key off them.
var AISessionEnv = [...]string{
	"CLAUDECODE",
	"CLAUDE_CODE_SESSION_ID",
	"CLAUDE_CODE_ENTRYPOINT",
	"CLAUDE_CODE_CHILD_SESSION",
	"CLAUDE_CODE_VERSION",
	"CLAUDE_CODE_EXECPATH",
	"CODEX_COMPANION_SESSION_ID",
	"AI_AGENT",
}

// soksakChildAllow is the SOKSAK_* interface a child is entitled to — the
// handles it talks back to the app through. Every other SOKSAK_* is internal
// (vault master key, secret payloads, isolated vault paths, test hooks) and is
// stripped, so a new internal name is blocked by default.
//
// An earlier build also carried SOKSAK_PANE, annotated "the transitional old
// name — removal condition: every session replaced". This build starts with no
// sessions, so the condition is already met.
var soksakChildAllow = [...]string{
	"SOKSAK_HOME",
	"SOKSAK_SOCKET",
	"SOKSAK_CALLER_TAB",
	"SOKSAK_WINDOW",
	"SOKSAK_PARENT",
	"SOKSAK_CLI_DIR",
}

// environmentRequest is everything the environment rules read. All of it is a
// value the caller passed; none of it is read from this process.
type environmentRequest struct {
	// Inherited is the environment the launcher read, as "NAME=value".
	//
	// An earlier build passed names only, because a Rust Command inherits and
	// env_remove subtracts. Go has no "inherit minus these": a non-nil Env
	// replaces everything and a nil one makes os/exec read the ambient. So the
	// values travel too, and the load-bearing half of the rule survives intact
	// — this package never calls os.Environ.
	Inherited []string
	Home      string
	Set       map[string]string
	Remove    []string
	ScrubAI   bool
	// Secrets are resolved plaintext, appended last so a secret beats a plain
	// entry of the same name.
	Secrets [][2]string
}

// childEnvironment applies the environment rules in an earlier build's order:
// inherited minus internal SOKSAK_*, then the injected home, then the caller's
// entries, then the removals, then the secrets.
func childEnvironment(request environmentRequest) []string {
	entries := newEnvironmentList(len(request.Inherited) + len(request.Set) + len(request.Secrets) + 1)

	for _, entry := range request.Inherited {
		name, value, _ := strings.Cut(entry, "=")
		if isInternalSoksak(name) {
			continue
		}
		entries.set(name, value)
	}

	// The app propagates its own single truth to the child; the child knowing
	// the home is legitimate. The value comes from what was passed in, so a
	// second spawning process cannot quietly hand down a different home.
	entries.set("SOKSAK_HOME", request.Home)

	for _, name := range sortedNames(request.Set) {
		entries.set(name, request.Set[name])
	}
	// Removal runs after Set, as it did in an earlier build: one spelling of
	// "unset this" always wins, whatever else asked for the name.
	for _, name := range request.Remove {
		entries.remove(name)
	}
	if request.ScrubAI {
		for _, name := range AISessionEnv {
			entries.remove(name)
		}
	}
	for _, secret := range request.Secrets {
		entries.set(secret[0], secret[1])
	}

	return entries.render()
}

func isInternalSoksak(name string) bool {
	if !strings.HasPrefix(name, "SOKSAK_") {
		return false
	}
	for _, allowed := range soksakChildAllow {
		if name == allowed {
			return false
		}
	}
	return true
}

func sortedNames(values map[string]string) []string {
	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	// Sorted so two spawns of the same request produce byte-identical
	// environments; map order would make a diff of two children noise.
	sort.Strings(names)
	return names
}

// environmentList keeps insertion order while allowing overwrite and removal,
// so the rendered environment is stable across runs.
type environmentList struct {
	order []string
	seen  map[string]bool
	value map[string]string
}

func newEnvironmentList(capacity int) *environmentList {
	return &environmentList{
		order: make([]string, 0, capacity),
		seen:  make(map[string]bool, capacity),
		value: make(map[string]string, capacity),
	}
}

func (list *environmentList) set(name, value string) {
	if !list.seen[name] {
		list.seen[name] = true
		list.order = append(list.order, name)
	}
	list.value[name] = value
}

func (list *environmentList) remove(name string) { delete(list.value, name) }

func (list *environmentList) render() []string {
	entries := make([]string, 0, len(list.value))
	for _, name := range list.order {
		if value, present := list.value[name]; present {
			entries = append(entries, name+"="+value)
		}
	}
	return entries
}

// ChildEnvironment builds the environment for a process this application
// starts, for a caller outside this package.
//
// The rule has one owner. A daemon starts children too, and a second copy of
// this would drift the moment either changed — and the way it drifts is that an
// internal SOKSAK_* stops being stripped, so a vault master key reaches a child
// and nobody notices until it is in someone's log.
//
// The full request shape stays private: secrets, scrubbing and removals belong
// to the spawn path that has them. This is the plain case — inherit, strip,
// override — which is what a supervisor starting a long-lived child needs.
// home is taken rather than inherited: the application propagates its own
// single truth to every child, so a second spawning process cannot quietly hand
// down a different one.
func ChildEnvironment(inherited []string, home string, overrides map[string]string) []string {
	return childEnvironment(environmentRequest{Inherited: inherited, Home: home, Set: overrides})
}
