package wails

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/soksak-ai/soksak-core/core/boot"
	"github.com/soksak-ai/soksak-core/core/control"
	"github.com/soksak-ai/soksak-core/core/files"
	"github.com/soksak-ai/soksak-core/core/identity"
	"github.com/soksak-ai/soksak-core/core/process"
	"github.com/soksak-ai/soksak-core/core/sidecar"
	"github.com/soksak-ai/soksak-core/core/store"
)

// invokeCall finds the backend commands the frontend calls by name.
var invokeCall = regexp.MustCompile(`invoke(?:Command)?[A-Za-z]*<?[^>(]*>?\(\s*"([a-z][a-z0-9_]*)"`)

// TestEveryFrontendCallIsAccountedFor keeps the two halves of the application
// from drifting apart about which commands exist.
//
// One registry stops two implementations of one command from disagreeing about
// arguments. It does not cover a command that is called and never registered —
// that gap is invisible until a user opens the feature, and then it reads as a
// broken application rather than an unbuilt one.
func TestEveryFrontendCallIsAccountedFor(t *testing.T) {
	called := frontendCalls(t)
	if len(called) == 0 {
		// A scan that finds nothing reports no violations and enforces nothing.
		t.Fatal("no invoke calls were found; the scan root is wrong")
	}

	// The whole command surface, assembled the way the running process
	// assembles it. This gate is beside the framework rather than beside the
	// core because this is the only package that can import both, and a gate
	// that reads a hand-written list of what the other half serves measures the
	// list instead of the build.
	registry := control.NewRegistry()
	// A store is opened because several groups refuse by name without one, and
	// a refusal is not registration — the gate would then read a served command
	// as missing.
	home := t.TempDir()
	kv, err := store.OpenKV(filepath.Join(home, "soksak.db"))
	if err != nil {
		t.Fatalf("opening the store: %v", err)
	}
	t.Cleanup(func() { _ = kv.Close() })

	boot.RegisterCore(registry, boot.Boot{
		Identity: identity.Resolve("com.soksak.dev", identity.Environment{Home: home}),
		KV:       kv,
		UserHome: t.TempDir(),
		Now:      func() int64 { return 0 },
		PidAlive: func(int) bool { return false },
		Run:      files.SystemRunner{},
		Spawner:  process.OSSpawner{},
		// A spawner with nowhere to deliver is refused, so the gate supplies a
		// consumer that reads and drops. It measures which commands register,
		// never what they emit.
		ProcessSink: discardProcessOutput{},
		OS:          "darwin",
		Arch:        "arm64",
	})
	// The units group, wired the way Run wires it. A build with no sink declares the two stream
	// names unserved rather than leaving them off the table, and this gate is what would catch the
	// difference between the two lists.
	sidecar.Register(registry, sidecar.Registration{
		Host: sidecar.NewHost(sidecar.Deps{Home: home, Spawner: process.OSSpawner{}}),
		Resolve: func(sidecar.Consumer, sidecar.ReleaseReference) (sidecar.Resolved, error) {
			return sidecar.Resolved{Name: "fixture", Version: "0.0.1", Path: "/fixture"}, nil
		},
		Sink: discardSidecarOutput{},
	})
	// The same call Run makes. A second list here drifts from that one in both
	// directions at once and neither side reports it: measured 2026-08-15, this
	// gate registered the surface group the application never did, and the
	// application registered capture and background this gate never did. Which
	// names register depends on the dependencies being present, never on what
	// they answer, so stubs are enough.
	RegisterHost(registry, HostDeps{
		Host:  startedHost(),
		NewID: counter("1"),
		// The plugin groups this build composes, named here because this gate's
		// subject is the build and not the package: the frontend calls a
		Composition:  stubComposition{},
		NativeParent: func(string) bool { return false },
		Dispatch:     func(string, string, any) error { return nil },
		Reaper:       idleReaper{},
		Release:      func() error { return nil },
		Quit:         func() {},
	})

	served := map[string]bool{}
	for _, command := range registry.Describe().Commands {
		served[command.Name] = true
	}
	// What this cannot see: whether the launcher actually supplies each of those
	// dependencies. It proves the groups register what they claim; main.go
	// handing them a real store, spawner and session owner is a separate fact,
	// and the only witness to it is starting the process.
	//
	// The residue: commands whose handlers close over the vendor's App and
	// Window directly, so there is no seam to hand a stub. Every name here is a
	// command this gate cannot prove — shrinking the list means giving those
	// handlers a host interface, the way the window group has one.
	for _, name := range []string{
		"window_set_background", "cmd_listener_ready", "webview_recovery_consume",
		"control_owner_answered",
	} {
		served[name] = true
	}

	// What this build refuses by name, read from the registry rather than from a
	// second list here. A list in the test can agree with the test while the
	// running process answers "unknown command" for the same name.
	refused := map[string]string{}
	for _, entry := range registry.Describe().Unserved {
		refused[entry.Name] = entry.BlockedBy
	}

	var undeclared []string
	for _, name := range called {
		if served[name] {
			continue
		}
		if _, declared := refused[name]; !declared {
			undeclared = append(undeclared, name)
		}
	}
	sort.Strings(undeclared)

	if len(undeclared) > 0 {
		t.Errorf("the frontend calls commands this backend neither serves nor declares unserved: %v\n"+
			"Serve them, or declare them unserved with a reason in the group that owns them.", undeclared)
	}

	// A declared refusal that nobody calls is not a gap. The caller was removed
	// and the declaration outlived it, so the next reader plans work for a
	// feature with no consumer.
	callers := map[string]bool{}
	for _, name := range called {
		callers[name] = true
	}
	var uncalled []string
	for name := range refused {
		if !callers[name] {
			uncalled = append(uncalled, name)
		}
	}
	sort.Strings(uncalled)
	if len(uncalled) > 0 {
		t.Errorf("these are declared unserved but the frontend no longer calls them: %v\n"+
			"Remove the declaration; it describes the gap, not the history.", uncalled)
	}

	// Every refusal states a reason. "unknown command" and "not built" are
	// different answers, and only the second one ends the search.
	var mute []string
	for name, because := range refused {
		if strings.TrimSpace(because) == "" {
			mute = append(mute, name)
		}
	}
	sort.Strings(mute)
	if len(mute) > 0 {
		t.Errorf("these are refused with no reason: %v", mute)
	}
}

func frontendCalls(t *testing.T) []string {
	t.Helper()
	root := filepath.Join("..", "..", "frontend", "src")

	seen := map[string]bool{}
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() || !strings.HasSuffix(path, ".ts") && !strings.HasSuffix(path, ".tsx") {
			return nil
		}
		// Tests name commands they mock, which is not evidence of what the
		// running application calls.
		if strings.Contains(path, ".test.") {
			return nil
		}
		source, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, match := range invokeCall.FindAllStringSubmatch(string(source), -1) {
			seen[match[1]] = true
		}
		return nil
	})
	if err != nil {
		t.Fatalf("scanning the frontend: %v", err)
	}

	names := make([]string, 0, len(seen))
	for name := range seen {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// discardProcessOutput is a consumer that is always there and never looks. It
// exists so this gate can register the spawning commands; nothing here asserts
// on delivery.
type discardProcessOutput struct{}

func (discardProcessOutput) EmitProcessOutput(process.Output) process.Delivery {
	return process.Delivered
}
func (discardProcessOutput) EmitProcessExit(process.Exit) process.Delivery {
	return process.Delivered
}

// idleReaper is a host with nothing to take down. Which names register depends
// on the dependencies being present, never on what they answer.
type idleReaper struct{}

func (idleReaper) ReleaseShells() (int, int) { return 0, 0 }

func (idleReaper) DrainSurfaces() (int, int, error) { return 0, 0, nil }
func (idleReaper) DrainInputMonitors() int          { return 0 }

// discardSidecarOutput reads a unit's stream and drops it. The gate measures which commands
// register, never what they carry.
type discardSidecarOutput struct{}

func (discardSidecarOutput) EmitSidecarBytes(sidecar.Bytes) sidecar.Delivery {
	return sidecar.Delivered
}
func (discardSidecarOutput) EmitSidecarEnd(sidecar.End) sidecar.Delivery { return sidecar.Delivered }
