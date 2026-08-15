package ai

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/soksak/soksak-core/core/control"
	"github.com/soksak/soksak-core/core/store"
)

func callArgs(t *testing.T, values map[string]any) control.Args {
	t.Helper()
	args := control.Args{}
	for name, value := range values {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("encoding %s: %v", name, err)
		}
		args[name] = encoded
	}
	return args
}

// wire is what the caller actually receives: the transport encodes a handler's
// answer once, and the frontend reads the keys out of that. Asserting on the Go
// value would pass while the page saw a field it does not know.
func wire(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("encoding the answer: %v", err)
	}
	return string(encoded)
}

func servedNames(registry *control.Registry) map[string]control.Owner {
	names := map[string]control.Owner{}
	for _, command := range registry.Describe().Commands {
		names[command.Name] = command.Owner
	}
	return names
}

func refusals(registry *control.Registry) map[string]string {
	reasons := map[string]string{}
	for _, refused := range registry.Describe().Unserved {
		reasons[refused.Name] = refused.BlockedBy
	}
	return reasons
}

// TestThisGroupRegistersItsSixNamesAndNoOthers. The frontend calls exactly
// these; a name that quietly stopped registering is a feature that fails the
// moment a user reaches it.
func TestThisGroupRegistersItsSixNamesAndNoOthers(t *testing.T) {
	registry := control.NewRegistry()
	Register(registry, Deps{UserHome: t.TempDir(), Lineage: openLineage(t)})

	want := []string{
		"ai_session_active", "ai_session_detect", "ai_session_dir",
		"ai_session_find", "ai_session_inspect", "ai_session_lineage",
	}
	served := servedNames(registry)
	if len(served) != len(want) {
		t.Fatalf("registered %v, want exactly %v", served, want)
	}
	for _, name := range want {
		owner, present := served[name]
		if !present {
			t.Errorf("%s did not register", name)
			continue
		}
		// Every one of these answers from files and a store. Owning them as
		// framework commands would make them need a window, and then `sok`
		// could not reach them.
		if owner != control.OwnerCore {
			t.Errorf("%s registered as %q, want %q", name, owner, control.OwnerCore)
		}
	}
	if len(registry.Describe().Unserved) != 0 {
		t.Fatalf("a fully wired process still refuses %v", registry.Describe().Unserved)
	}
}

// TestDetectAnswersAKindOrNull. The frontend types this `string | null` and
// tags a terminal block with whatever comes back; an empty string is an answer
// shaped like a kind and would tag every command as an agent's.
func TestDetectAnswersAKindOrNull(t *testing.T) {
	registry := control.NewRegistry()
	Register(registry, Deps{UserHome: t.TempDir(), Lineage: openLineage(t)})

	result, err := registry.Invoke("ai_session_detect", callArgs(t, map[string]any{"commandLine": "claude --resume"}))
	if err != nil {
		t.Fatalf("ai_session_detect: %v", err)
	}
	if got := wire(t, result); got != `"claude"` {
		t.Fatalf("ai_session_detect = %s, want \"claude\"", got)
	}

	result, err = registry.Invoke("ai_session_detect", callArgs(t, map[string]any{"commandLine": "git status"}))
	if err != nil {
		t.Fatalf("ai_session_detect: %v", err)
	}
	if got := wire(t, result); got != "null" {
		t.Fatalf("ai_session_detect = %s, want null", got)
	}
}

// TestFindAnswersTheSessionOnTheWireTheFrontendReads. The keys are the
// contract: the catalog entry promises sessionId and cwd.
func TestFindAnswersTheSessionOnTheWireTheFrontendReads(t *testing.T) {
	home := t.TempDir()
	const cwd = "<machine-path>/proj"
	directory, err := Directory(home, cwd)
	if err != nil {
		t.Fatalf("Directory: %v", err)
	}
	writeTranscript(t, directory, sessionIDs[0]+".jsonl", claudeBody(sessionIDs[0], cwd), at(1))

	registry := control.NewRegistry()
	Register(registry, Deps{UserHome: home, Lineage: openLineage(t)})

	result, err := registry.Invoke("ai_session_find", callArgs(t, map[string]any{"cwd": cwd}))
	if err != nil {
		t.Fatalf("ai_session_find: %v", err)
	}
	got := wire(t, result)
	for _, fragment := range []string{`"kind":"claude"`, `"sessionId":"` + sessionIDs[0] + `"`, `"cwd":"` + cwd + `"`} {
		if !strings.Contains(got, fragment) {
			t.Fatalf("ai_session_find = %s, want it to carry %s", got, fragment)
		}
	}

	result, err = registry.Invoke("ai_session_find", callArgs(t, map[string]any{"cwd": "<machine-path>/elsewhere"}))
	if err != nil {
		t.Fatalf("ai_session_find: %v", err)
	}
	if got := wire(t, result); got != "null" {
		t.Fatalf("a working directory with no sessions answered %s, want null", got)
	}
}

// TestDirAnswersThePathTheWatcherIsPointedAt. The frontend hands this straight
// to watch_dir, so it has to be the same directory the tracker reads.
func TestDirAnswersThePathTheWatcherIsPointedAt(t *testing.T) {
	home := t.TempDir()
	registry := control.NewRegistry()
	Register(registry, Deps{UserHome: home, Lineage: openLineage(t)})

	result, err := registry.Invoke("ai_session_dir", callArgs(t, map[string]any{"cwd": "<machine-path>/proj"}))
	if err != nil {
		t.Fatalf("ai_session_dir: %v", err)
	}
	want := filepath.Join(home, ".claude", "projects", "-Users-max-proj")
	if result != want {
		t.Fatalf("ai_session_dir = %v, want %q", result, want)
	}
}

// TestInspectAnswersOverTheRegistry, and refuses a path outside the agents'
// trees from the same door.
func TestInspectAnswersOverTheRegistry(t *testing.T) {
	home := t.TempDir()
	path := writeTranscript(t,
		filepath.Join(home, ".claude", "projects", "-Users-max-proj"),
		sessionIDs[0]+".jsonl", claudeBody(sessionIDs[0], "<machine-path>/proj"), at(1))

	registry := control.NewRegistry()
	Register(registry, Deps{UserHome: home, Lineage: openLineage(t)})

	result, err := registry.Invoke("ai_session_inspect", callArgs(t, map[string]any{"path": path}))
	if err != nil {
		t.Fatalf("ai_session_inspect: %v", err)
	}
	if !strings.Contains(wire(t, result), sessionIDs[0]) {
		t.Fatalf("ai_session_inspect = %s", wire(t, result))
	}

	if _, err := registry.Invoke("ai_session_inspect", callArgs(t, map[string]any{"path": "/etc/passwd"})); err == nil {
		t.Fatal("an arbitrary file was read through the registry")
	}
}

// TestActiveAnswersASessionOnceAndThenNull over the registry, which is how the
// frontend tells a transition from a change it does not care about.
func TestActiveAnswersASessionOnceAndThenNull(t *testing.T) {
	directory := t.TempDir()
	writeTranscript(t, directory, sessionIDs[0]+".jsonl", "", at(1))

	registry := control.NewRegistry()
	Register(registry, Deps{UserHome: t.TempDir(), Lineage: openLineage(t)})

	result, err := registry.Invoke("ai_session_active", callArgs(t, map[string]any{"dir": directory}))
	if err != nil {
		t.Fatalf("ai_session_active: %v", err)
	}
	if got := wire(t, result); got != `"`+sessionIDs[0]+`"` {
		t.Fatalf("ai_session_active = %s, want the transcript that was just written", got)
	}

	result, err = registry.Invoke("ai_session_active", callArgs(t, map[string]any{"dir": directory}))
	if err != nil {
		t.Fatalf("ai_session_active: %v", err)
	}
	if got := wire(t, result); got != "null" {
		t.Fatalf("a second look answered %s, want null", got)
	}
}

// TestTheTrackerIsOneLedgerPerProcess. Registering builds it; two would each
// hold their own idea of "last look" and answer the same question differently.
func TestTheTrackerIsOneLedgerPerProcess(t *testing.T) {
	directory := t.TempDir()
	writeTranscript(t, directory, sessionIDs[0]+".jsonl", "", at(1))

	first := control.NewRegistry()
	Register(first, Deps{UserHome: t.TempDir(), Lineage: openLineage(t)})
	second := control.NewRegistry()
	Register(second, Deps{UserHome: t.TempDir(), Lineage: openLineage(t)})

	if _, err := first.Invoke("ai_session_active", callArgs(t, map[string]any{"dir": directory})); err != nil {
		t.Fatalf("ai_session_active: %v", err)
	}
	// A second registration has never looked, so it still reports the write.
	// This is the fact that makes one ledger per process a requirement rather
	// than a preference.
	result, err := second.Invoke("ai_session_active", callArgs(t, map[string]any{"dir": directory}))
	if err != nil {
		t.Fatalf("ai_session_active: %v", err)
	}
	if got := wire(t, result); got == "null" {
		t.Fatal("a separate registration shared the first one's memory")
	}
}

// TestLineageAnswersAListOverTheRegistry.
func TestLineageAnswersAListOverTheRegistry(t *testing.T) {
	kv := openLineage(t)
	const cwd = "<machine-path>/proj"
	putTransition(t, kv, cwd, "a", "pane-1", "", sessionIDs[0], 100)

	registry := control.NewRegistry()
	Register(registry, Deps{UserHome: t.TempDir(), Lineage: kv})

	// The frontend sends viewId explicitly as null when it wants every tab.
	result, err := registry.Invoke("ai_session_lineage", callArgs(t, map[string]any{"cwd": cwd, "viewId": nil}))
	if err != nil {
		t.Fatalf("ai_session_lineage: %v", err)
	}
	if got := wire(t, result); !strings.Contains(got, sessionIDs[0]) {
		t.Fatalf("ai_session_lineage = %s", got)
	}

	result, err = registry.Invoke("ai_session_lineage", callArgs(t, map[string]any{"cwd": "<machine-path>/never", "viewId": nil}))
	if err != nil {
		t.Fatalf("ai_session_lineage: %v", err)
	}
	if got := wire(t, result); got != "[]" {
		t.Fatalf("an empty lineage answered %s, want []", got)
	}
}

// TestAMissingArgumentIsNamed. A handler that read a zero value would answer
// about the empty working directory and call it a result.
func TestAMissingArgumentIsNamed(t *testing.T) {
	registry := control.NewRegistry()
	Register(registry, Deps{UserHome: t.TempDir(), Lineage: openLineage(t)})

	for name, argument := range map[string]string{
		"ai_session_detect":  "commandLine",
		"ai_session_dir":     "cwd",
		"ai_session_find":    "cwd",
		"ai_session_inspect": "path",
		"ai_session_active":  "dir",
		"ai_session_lineage": "cwd",
	} {
		_, err := registry.Invoke(name, control.Args{})
		if err == nil {
			t.Errorf("%s answered with no arguments", name)
			continue
		}
		if !strings.Contains(err.Error(), argument) {
			t.Errorf("%s did not name %q: %v", name, argument, err)
		}
	}
}

// TestAProcessWithNoHomeRefusesByNameRatherThanAnswering.
//
// Both commands that need the user's home are useless without it, and that is
// known when the process is assembled — so the table says so, and a caller can
// tell "this build cannot" from "not written yet" without making a call.
func TestAProcessWithNoHomeRefusesByNameRatherThanAnswering(t *testing.T) {
	registry := control.NewRegistry()
	Register(registry, Deps{Lineage: openLineage(t)})

	served := servedNames(registry)
	for _, name := range []string{"ai_session_dir", "ai_session_find"} {
		if _, present := served[name]; present {
			t.Errorf("%s registered with no home to read", name)
		}
	}
	reasons := refusals(registry)
	for _, name := range []string{"ai_session_dir", "ai_session_find"} {
		if !strings.Contains(reasons[name], "ai.Deps.UserHome") {
			t.Errorf("%s is refused as %q, which does not name the field to set", name, reasons[name])
		}
	}

	// The refusal travels with the call, so a caller that invokes anyway is
	// told why rather than "unknown command".
	_, err := registry.Invoke("ai_session_find", callArgs(t, map[string]any{"cwd": "/w"}))
	if err == nil {
		t.Fatal("ai_session_find answered with no home")
	}
	if !strings.Contains(err.Error(), "ai.Deps.UserHome") {
		t.Fatalf("the failed call does not carry the reason: %v", err)
	}

	// The commands that need no home keep working. One missing dependency
	// disables what depends on it and nothing else.
	for _, name := range []string{"ai_session_detect", "ai_session_inspect", "ai_session_active"} {
		if _, present := served[name]; !present {
			t.Errorf("%s stopped registering because of an unrelated dependency", name)
		}
	}
}

// TestAProcessWithNoStoreRefusesLineageByName. An empty list from a process
// that holds no history reads as "this directory has no forks", and that is a
// different fact from "this build cannot answer".
func TestAProcessWithNoStoreRefusesLineageByName(t *testing.T) {
	registry := control.NewRegistry()
	Register(registry, Deps{UserHome: t.TempDir()})

	if _, present := servedNames(registry)["ai_session_lineage"]; present {
		t.Fatal("ai_session_lineage registered with no store to read")
	}
	if reason := refusals(registry)["ai_session_lineage"]; !strings.Contains(reason, "ai.Deps.Lineage") {
		t.Fatalf("ai_session_lineage is refused as %q, which does not name the field to set", reason)
	}
}

// TestARealStoreSatisfiesTheLineageSeam. The interface exists so this group can
// be exercised without a database; it is worth nothing if the store the
// launcher holds does not fit it.
func TestARealStoreSatisfiesTheLineageSeam(t *testing.T) {
	var _ LineageStore = (*store.KV)(nil)
}
