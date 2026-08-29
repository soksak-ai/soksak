package process

import (
	"encoding/json"
	"sort"
	"strings"
	"testing"

	"github.com/soksak-ai/soksak-core/core/control"
)

func args(t *testing.T, pairs map[string]any) control.Args {
	t.Helper()
	decoded := control.Args{}
	for name, value := range pairs {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		decoded[name] = encoded
	}
	return decoded
}

func testRegistry(t *testing.T) (*control.Registry, *Manager, *fakeSpawner, *recordingSink) {
	t.Helper()
	registry := control.NewRegistry()
	spawner := &fakeSpawner{}
	sink := newRecordingSink()
	manager := Register(registry, Deps{Home: "/home", Environment: []string{"PATH=/bin"}, Sink: sink, Spawner: spawner})
	t.Cleanup(func() { _, _ = manager.ReapAll() })
	return registry, manager, spawner, sink
}

// The seven names this package answers, all core-owned: none of them needs this
// host's window, because the window arrives as an argument.
func TestRegisterServesExactlySixCoreCommands(t *testing.T) {
	registry, _, _, _ := testRegistry(t)
	table := registry.Describe()

	served := make([]string, 0, len(table.Commands))
	for _, command := range table.Commands {
		if command.Owner != control.OwnerCore {
			t.Fatalf("%s is owned by %s — a command that needs no window is core's", command.Name, command.Owner)
		}
		served = append(served, command.Name)
	}
	sort.Strings(served)

	want := []string{
		"process_inventory", "process_kill", "process_list", "process_reclaim_by_window",
		"process_spawn", "process_stdin_close", "process_write",
	}
	if strings.Join(served, ",") != strings.Join(want, ",") {
		t.Fatalf("served %v, want %v", served, want)
	}
}

func TestProcessInventoryAggregatesAnInjectedOwner(t *testing.T) {
	source := fakeInventorySource{value: OwnerInventory{Owner: "soksak-sidecar-pty", Revision: 4, Processes: []OwnedProcess{{
		ID: "pty-session-7", Owner: "soksak-sidecar-pty", PID: 123, ParentPID: 99,
		Command: "/bin/zsh -l", State: "running", StartedAtUnixMs: 1700000000000,
	}}}}
	manager := NewManager(Deps{InventorySources: []InventorySource{source}})
	got, err := manager.Inventory()
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Owners) != 1 || got.Owners[0].Owner != source.value.Owner || len(got.Owners[0].Processes) != 1 {
		t.Fatalf("inventory=%+v", got)
	}
}

func TestProcessInventoryRejectsARecordWhoseOwnerDiffersFromItsSource(t *testing.T) {
	source := fakeInventorySource{value: OwnerInventory{Owner: "owner-a", Revision: 1, Processes: []OwnedProcess{{
		ID: "process-1", Owner: "owner-b", PID: 123, Command: "worker", State: "running",
	}}}}
	manager := NewManager(Deps{InventorySources: []InventorySource{source}})
	if _, err := manager.Inventory(); err == nil || !strings.Contains(err.Error(), "owner") {
		t.Fatalf("owner mismatch must be refused, got %v", err)
	}
}

func TestProcessInventoryCommandReturnsTheAggregatedOwnerSnapshot(t *testing.T) {
	source := fakeInventorySource{value: OwnerInventory{Owner: "owner-a", Revision: 2}}
	registry := control.NewRegistry()
	Register(registry, Deps{Home: "/home", Sink: newRecordingSink(), Spawner: &fakeSpawner{}, InventorySources: []InventorySource{source}})
	value, err := registry.Invoke("process_inventory", nil)
	if err != nil {
		t.Fatal(err)
	}
	inventory, ok := value.(Inventory)
	if !ok || len(inventory.Owners) != 1 || inventory.Owners[0].Owner != "owner-a" || inventory.Owners[0].Revision != 2 {
		t.Fatalf("inventory=%#v", value)
	}
}

type fakeInventorySource struct{ value OwnerInventory }

func (source fakeInventorySource) Inventory() (OwnerInventory, error) { return source.value, nil }

// cleanup_stale is not a process command. It removes stale install artifacts
// under a caller-supplied allowlist of roots and never touches a child. Its
// filesystem rules — permit a symlink at the leaf, refuse one in every
// component above it — belong beside a filesystem contract, not beside SIGKILL.
func TestCleanupStaleIsNotAProcessCommand(t *testing.T) {
	registry, _, _, _ := testRegistry(t)
	if _, err := registry.Invoke("cleanup_stale", nil); err == nil {
		t.Fatal("cleanup_stale answered from the process package")
	}
}

// Two registrations of one name is a conflict, not a reload.
func TestRegisteringTwicePanics(t *testing.T) {
	defer func() {
		if recovered := recover(); recovered == nil {
			t.Fatal("a second registration must panic rather than answer in the first one's place")
		}
	}()
	registry := control.NewRegistry()
	deps := Deps{Home: "/home", Sink: newRecordingSink(), Spawner: &fakeSpawner{}}
	Register(registry, deps)
	Register(registry, deps)
}

// A host that cannot spawn declares every name unserved with its reason, so
// "cannot reap here" and "nothing to reap" stay different answers.
func TestAHostWithNoSpawnerDeclaresEveryNameUnserved(t *testing.T) {
	registry := control.NewRegistry()
	Register(registry, Deps{Home: "/home"})

	table := registry.Describe()
	if len(table.Commands) != 0 {
		t.Fatalf("a host with no spawner served %v", table.Commands)
	}
	declared := map[string]string{}
	for _, entry := range table.Unserved {
		declared[entry.Name] = entry.BlockedBy
	}
	for _, name := range []string{
		"process_spawn", "process_kill", "process_list",
		"process_write", "process_stdin_close", "process_reclaim_by_window",
	} {
		if declared[name] == "" {
			t.Fatalf("%s is neither served nor declared unserved", name)
		}
		_, err := registry.Invoke(name, nil)
		if err == nil {
			t.Fatalf("%s answered on a host that cannot spawn", name)
		}
		if !strings.Contains(err.Error(), declared[name]) {
			t.Fatalf("invoking %s said %q, which does not carry the declared reason %q", name, err, declared[name])
		}
	}
}

// ── process_spawn ────────────────────────────────────────────────────────────

// The frontend's stream objects arrive here as {} — this framework's
// createStream is a no-op — so accepting them starts a child whose output
// is delivered to nobody while the caller believes it subscribed.
func TestSpawnRefusesCallbackArgumentsAndNamesTheEvent(t *testing.T) {
	registry, _, spawner, _ := testRegistry(t)
	for _, name := range []string{"onStdout", "onStderr", "onExit"} {
		_, err := registry.Invoke("process_spawn", args(t, map[string]any{
			"cmd": "/bin/sh", "args": []string{}, name: map[string]any{},
		}))
		if err == nil {
			t.Fatalf("%s must be refused", name)
		}
		if !strings.Contains(err.Error(), name) {
			t.Fatalf("error %q must name the argument it refuses", err)
		}
		if !strings.Contains(err.Error(), "process:output") || !strings.Contains(err.Error(), "process:exit") {
			t.Fatalf("error %q must name the events to subscribe to instead", err)
		}
	}
	if spawner.starts() != 0 {
		t.Fatalf("the spawner ran %d times for refused requests", spawner.starts())
	}
}

func TestSpawnNeedsACommandAndArguments(t *testing.T) {
	registry, _, spawner, _ := testRegistry(t)
	for _, missing := range []map[string]any{
		{"args": []string{}},
		{"cmd": "/bin/sh"},
	} {
		if _, err := registry.Invoke("process_spawn", args(t, missing)); err == nil {
			t.Fatalf("%v must be refused: both cmd and args are required", missing)
		}
	}
	if spawner.starts() != 0 {
		t.Fatalf("the spawner ran %d times for refused requests", spawner.starts())
	}
}

// The frontend sends cwd, env, ns and secretEnv as JSON null. Null is absence,
// not a decoding failure.
func TestSpawnAcceptsTheNullsTheCallerSends(t *testing.T) {
	registry, _, spawner, _ := testRegistry(t)
	handle, err := registry.Invoke("process_spawn", args(t, map[string]any{
		"cmd": "/bin/sh", "args": []string{"-c", "true"},
		"cwd": nil, "env": nil, "envRemove": nil, "ns": nil, "secretEnv": nil,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if handle != uint32(1) {
		t.Fatalf("handle %v, want 1", handle)
	}
	if spawner.starts() != 1 {
		t.Fatalf("the spawner ran %d times", spawner.starts())
	}
}

// A window label that is present and empty names nothing. Accepting it would
// let a caller that does not know its label spawn into a bucket that a reclaim
// can never name.
func TestSpawnRefusesAnEmptyWindowLabel(t *testing.T) {
	registry, _, spawner, _ := testRegistry(t)
	if _, err := registry.Invoke("process_spawn", args(t, map[string]any{
		"cmd": "/bin/sh", "args": []string{}, "window": "",
	})); err == nil {
		t.Fatal("an empty window label must be refused rather than stamped")
	}
	if spawner.starts() != 0 {
		t.Fatal("the spawner ran for a refused request")
	}
}

// ── process_kill ─────────────────────────────────────────────────────────────

// Nothing to reap comes back as a receipt saying so, never as a bare null that
// reads the same as a reaping.
func TestKillAnswersWhetherAnythingWasReaped(t *testing.T) {
	registry, _, _, _ := testRegistry(t)
	answer, err := registry.Invoke("process_kill", args(t, map[string]any{"id": 99}))
	if err != nil {
		t.Fatalf("killing an already-finished handle stays idempotent: %v", err)
	}
	encoded, err := json.Marshal(answer)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"reaped":false}` {
		t.Fatalf("kill answered %s, want {\"reaped\":false}", encoded)
	}

	if _, err := registry.Invoke("process_spawn", args(t, map[string]any{"cmd": "/bin/sh", "args": []string{}})); err != nil {
		t.Fatal(err)
	}
	answer, err = registry.Invoke("process_kill", args(t, map[string]any{"id": 1}))
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ = json.Marshal(answer)
	if string(encoded) != `{"reaped":true}` {
		t.Fatalf("kill answered %s for a live child", encoded)
	}
}

// ── process_list ─────────────────────────────────────────────────────────────

// An empty ledger is [], not null. A nil slice marshals to null, which reads as
// "no answer" rather than "nothing is running".
func TestListMarshalsEmptyAsAnArray(t *testing.T) {
	registry, _, _, _ := testRegistry(t)
	answer, err := registry.Invoke("process_list", nil)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(answer)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != "[]" {
		t.Fatalf("list answered %s, want []", encoded)
	}
}

func TestInventoryPreservesCoreChildWorkingDirectory(t *testing.T) {
	registry, _, _, _ := testRegistry(t)
	if _, err := registry.Invoke("process_spawn", args(t, map[string]any{
		"cmd": "/bin/sh", "args": []string{"-c", "sleep 2"}, "cwd": "/workspace/project",
	})); err != nil {
		t.Fatal(err)
	}
	value, err := registry.Invoke("process_inventory", nil)
	if err != nil {
		t.Fatal(err)
	}
	inventory := value.(Inventory)
	if len(inventory.Owners) != 1 || len(inventory.Owners[0].Processes) != 1 || inventory.Owners[0].Processes[0].CWD != "/workspace/project" {
		t.Fatalf("inventory=%+v", inventory)
	}
}

// An unowned child has a null window rather than "", which the consumer
// filters on by comparing to a label.
func TestListCarriesTheTagsTheConsumerFiltersOn(t *testing.T) {
	registry, _, _, _ := testRegistry(t)
	if _, err := registry.Invoke("process_spawn", args(t, map[string]any{
		"cmd": "/bin/sh", "args": []string{"-c", "true"}, "window": "w-a",
	})); err != nil {
		t.Fatal(err)
	}
	if _, err := registry.Invoke("process_spawn", args(t, map[string]any{
		"cmd": "/bin/sh", "args": []string{},
	})); err != nil {
		t.Fatal(err)
	}
	answer, err := registry.Invoke("process_list", nil)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(answer)
	if err != nil {
		t.Fatal(err)
	}
	var listed []map[string]any
	if err := json.Unmarshal(encoded, &listed); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"id", "pid", "window", "cmd", "group", "alive"} {
		if _, carried := listed[0][field]; !carried {
			t.Fatalf("the listed entry has no %s: %v", field, listed[0])
		}
	}
	if listed[0]["window"] != "w-a" {
		t.Fatalf("entry one carries window %v", listed[0]["window"])
	}
	if listed[1]["window"] != nil {
		t.Fatalf("an unowned child carries window %v rather than null", listed[1]["window"])
	}
}

// ── process_write and process_stdin_close ────────────────────────────────────

func TestWriteAndStdinCloseNeedTheirArguments(t *testing.T) {
	registry, _, _, _ := testRegistry(t)
	if _, err := registry.Invoke("process_write", args(t, map[string]any{"id": 1})); err == nil {
		t.Fatal("a write with no data must be refused")
	}
	if _, err := registry.Invoke("process_write", args(t, map[string]any{"data": "x"})); err == nil {
		t.Fatal("a write with no handle must be refused")
	}
	if _, err := registry.Invoke("process_stdin_close", nil); err == nil {
		t.Fatal("closing stdin with no handle must be refused")
	}
}

// Unknown handles part company here: a kill is idempotent because the plugin
// API kills on unload, while a stdin close is not, because the child it meant
// to release will wait for an EOF nobody sent.
func TestAnUnknownHandleFailsForStdinCloseAndNotForKill(t *testing.T) {
	registry, _, _, _ := testRegistry(t)
	if _, err := registry.Invoke("process_kill", args(t, map[string]any{"id": 42})); err != nil {
		t.Fatalf("kill on an unknown handle: %v", err)
	}
	if _, err := registry.Invoke("process_stdin_close", args(t, map[string]any{"id": 42})); err == nil {
		t.Fatal("closing stdin on a handle that names nothing must fail")
	}
}

// ── process_reclaim_by_window ────────────────────────────────────────────────

func TestReclaimByWindowAnswersACount(t *testing.T) {
	registry, _, _, _ := testRegistry(t)
	for _, label := range []string{"w-a", "w-b", "w-a"} {
		if _, err := registry.Invoke("process_spawn", args(t, map[string]any{
			"cmd": "/bin/sh", "args": []string{}, "window": label,
		})); err != nil {
			t.Fatal(err)
		}
	}
	answer, err := registry.Invoke("process_reclaim_by_window", args(t, map[string]any{"window": "w-a"}))
	if err != nil {
		t.Fatal(err)
	}
	if answer != 2 {
		t.Fatalf("reclaim answered %v, want 2", answer)
	}
}

func TestReclaimByWindowNeedsALabel(t *testing.T) {
	registry, _, _, _ := testRegistry(t)
	if _, err := registry.Invoke("process_reclaim_by_window", nil); err == nil {
		t.Fatal("reclaim with no window argument must be refused")
	}
	if _, err := registry.Invoke("process_reclaim_by_window", args(t, map[string]any{"window": ""})); err == nil {
		t.Fatal("reclaim with an empty label must be refused")
	}
}

// ── a required argument sent as null ─────────────────────────────────────────

// Go's json package treats null as a no-op: the destination keeps its zero and
// no error comes back. A required argument that took that zero would answer as
// if the caller had sent a value — cmd null starting the empty program, data
// null reporting a write that put no bytes anywhere, id null reading as the
// handle that names nothing. Found 2026-08-15.
func TestARequiredArgumentSentAsNullIsRefused(t *testing.T) {
	registry, manager, spawner, _ := testRegistry(t)

	for _, refused := range []struct {
		command   string
		arguments map[string]any
	}{
		{"process_spawn", map[string]any{"cmd": nil, "args": []string{}}},
		{"process_spawn", map[string]any{"cmd": "/bin/sh", "args": nil}},
		{"process_kill", map[string]any{"id": nil}},
		{"process_stdin_close", map[string]any{"id": nil}},
		{"process_reclaim_by_window", map[string]any{"window": nil}},
	} {
		_, err := registry.Invoke(refused.command, args(t, refused.arguments))
		if err == nil {
			t.Errorf("%s %v answered rather than naming the null argument", refused.command, refused.arguments)
			continue
		}
		if !strings.Contains(err.Error(), "null") {
			t.Errorf("%s said %q; a caller that did send the field learns nothing from \"missing\"", refused.command, err)
		}
	}

	// A write is the one that would otherwise report success for nothing done,
	// so it is asked of a handle that really exists.
	id, err := manager.Spawn(Request{Cmd: "/bin/sh"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := registry.Invoke("process_write", args(t, map[string]any{"id": id, "data": nil})); err == nil {
		t.Error("a write with data null reported success having written nothing")
	}
	if spawner.starts() != 1 {
		t.Fatalf("the spawner ran %d times, want only the one this test started", spawner.starts())
	}
}
