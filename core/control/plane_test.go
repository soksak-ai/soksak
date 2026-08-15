package control

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// argsOf encodes a caller's arguments the way a transport does, so a test
// exercises the same decoding a socket or a window would.
func argsOf(t *testing.T, values map[string]any) Args {
	t.Helper()
	args := make(Args, len(values))
	for name, value := range values {
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("encoding argument %q: %v", name, err)
		}
		args[name] = raw
	}
	return args
}

// fullDeps is a process that was given everything this group asks for.
func fullDeps(t *testing.T) Deps {
	t.Helper()
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "sok"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("writing the client binary: %v", err)
	}
	return Deps{
		Socket:            filepath.Join(directory, "com.soksak.test.sock"),
		CLIDir:            directory,
		CLIName:           "sok",
		Notify:            &recordingNotifier{},
		ReleaseGeneration: func() (Generation, error) { return Generation{}, nil },
	}
}

func TestRegisterServesEveryNameItWasGivenFor(t *testing.T) {
	registry := NewRegistry()
	Register(registry, fullDeps(t))

	served := map[string]bool{}
	for _, command := range registry.Describe().Commands {
		served[command.Name] = true
	}
	for _, name := range CommandNames() {
		if !served[name] {
			t.Errorf("%s is not served by a process that was given everything it needs", name)
		}
	}
}

func TestEveryCommandIsHostIndependent(t *testing.T) {
	// The whole group must answer `sok` against a process that has drawn
	// nothing. An OwnerFramework entry here would be one that quietly needs a
	// window, and the headless boundary would move without anyone deciding it.
	registry := NewRegistry()
	Register(registry, fullDeps(t))

	for _, command := range registry.Describe().Commands {
		if command.Owner != OwnerCore {
			t.Errorf("%s is owned by %q; every command in this group answers with no window",
				command.Name, command.Owner)
		}
	}
}

func TestEveryCommandAnswersOverTheSocketWithNoWindow(t *testing.T) {
	// Answer is what the socket calls, so this is the path `sok` takes. A
	// command that only worked through the frontend transport would be one that
	// cannot be verified from outside the application, and a feature that can
	// only be clicked is a feature that is not finished.
	registry := NewRegistry()
	Register(registry, fullDeps(t))

	for _, name := range CommandNames() {
		response := Answer(registry, "com.soksak.test", Request{ID: "1", Command: name})
		if response.ID != "1" {
			t.Errorf("%s answered id %q", name, response.ID)
		}
		// Arguments are missing here on purpose: what is being measured is that
		// the name resolves and the handler runs, not that it liked the call.
		if !response.Ok && strings.Contains(response.Error, "is not registered") {
			t.Errorf("%s is unreachable over the socket: %s", name, response.Error)
		}
	}
}

func TestAMissingDependencyIsRefusedByNameRatherThanUnknown(t *testing.T) {
	// A caller that hears only "not registered" cannot tell a command this
	// build forgot from one it was never given the means to answer, so it
	// re-investigates settled ground or imitates the command.
	registry := NewRegistry()
	Register(registry, Deps{})

	refused := map[string]string{}
	for _, entry := range registry.Describe().Unserved {
		refused[entry.Name] = entry.BlockedBy
	}

	// The datagram commands need nothing from the process: they are served
	// even by a build that was handed an empty Deps.
	needsNothing := map[string]bool{commandDatagramSend: true, commandDatagramRequest: true}
	var missing []string
	for _, name := range CommandNames() {
		if needsNothing[name] {
			continue
		}
		reason, declared := refused[name]
		if !declared {
			missing = append(missing, name)
			continue
		}
		if !strings.Contains(reason, "this process was") {
			t.Errorf("%s refuses with %q, which does not say what this process was not given",
				name, reason)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Errorf("these fail as unknown rather than refused by name: %v", missing)
	}

	for name := range needsNothing {
		if _, err := registry.Invoke(name, Args{}); err != nil && strings.Contains(err.Error(), "is not registered") {
			t.Errorf("%s needs nothing from the process and must still be served: %v", name, err)
		}
	}
}

func TestARefusalCarriesItsReasonToTheCaller(t *testing.T) {
	registry := NewRegistry()
	Register(registry, Deps{})

	_, err := registry.Invoke(commandShutdownPrepare, Args{})
	if err == nil {
		t.Fatal("a process that cannot release what it started must not answer a receipt")
	}
	if !strings.Contains(err.Error(), "no way to release what it started") {
		t.Errorf("the refusal reads %q, which does not tell the caller what to wire", err)
	}
}
