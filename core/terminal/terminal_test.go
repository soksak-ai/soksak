package terminal

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/soksak/soksak-core/core/control"
)

// ── a fake owner ─────────────────────────────────────────────────────────────
//
// It records what crossed the boundary and holds no PTY. The real owner's job
// starts where this one stops, which is the whole reason this package routes
// rather than opens.

type openCall struct {
	key        string
	cols, rows uint16
	cwd, shell string
	placed     bool
}

type writeCall struct {
	handle Handle
	data   string
}

type resizeCall struct {
	handle     Handle
	cols, rows uint16
}

type ackCall struct {
	handle Handle
	bytes  uint64
}

type fakeOwner struct {
	mu         sync.Mutex
	generation uint64
	opens      []openCall
	writes     []writeCall
	resizes    []resizeCall
	closes     []Handle
	acks       []ackCall
	live       map[string]Handle
	openErr    error
	writeErr   error
	resizeErr  error
	closeErr   error
	ackErr     error
	pgid       int
	pgidErr    error
}

func newFakeOwner() *fakeOwner { return &fakeOwner{live: map[string]Handle{}, pgid: 4242} }

func (f *fakeOwner) open(call openCall) (Handle, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.opens = append(f.opens, call)
	if f.openErr != nil {
		return Handle{}, f.openErr
	}
	f.generation++
	handle := Handle{ID: call.key, Generation: f.generation}
	f.live[call.key] = handle
	return handle, nil
}

func (f *fakeOwner) Open(key string, cols, rows uint16) (Handle, error) {
	return f.open(openCall{key: key, cols: cols, rows: rows})
}

func (f *fakeOwner) current(handle Handle) error {
	held, exists := f.live[handle.ID]
	if !exists || held.Generation != handle.Generation {
		return fmt.Errorf("terminal owner does not exist: %s/%d", handle.ID, handle.Generation)
	}
	return nil
}

func (f *fakeOwner) Write(handle Handle, data string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.current(handle); err != nil {
		return err
	}
	if f.writeErr != nil {
		return f.writeErr
	}
	f.writes = append(f.writes, writeCall{handle: handle, data: data})
	return nil
}

func (f *fakeOwner) Resize(handle Handle, cols, rows uint16) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.current(handle); err != nil {
		return err
	}
	if f.resizeErr != nil {
		return f.resizeErr
	}
	f.resizes = append(f.resizes, resizeCall{handle: handle, cols: cols, rows: rows})
	return nil
}

func (f *fakeOwner) Close(handle Handle) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closes = append(f.closes, handle)
	if f.closeErr != nil {
		// A close that failed leaves the shell where it was. The fake keeps it
		// live for the same reason the real owner would: reporting the failure
		// and reaping anyway would make the two halves disagree.
		return f.closeErr
	}
	if held, exists := f.live[handle.ID]; exists && held.Generation == handle.Generation {
		delete(f.live, handle.ID)
	}
	return nil
}

func (f *fakeOwner) liveCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.live)
}

func (f *fakeOwner) openCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.opens)
}

// placingOwner also starts the shell where the caller asked.
type placingOwner struct{ *fakeOwner }

func (p placingOwner) OpenAt(key string, cols, rows uint16, cwd, shell string) (Handle, error) {
	return p.open(openCall{key: key, cols: cols, rows: rows, cwd: cwd, shell: shell, placed: true})
}

// flowingOwner also counts delivered bytes and pauses its reader.
type flowingOwner struct{ *fakeOwner }

func (f flowingOwner) Ack(handle Handle, bytes uint64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.current(handle); err != nil {
		return err
	}
	if f.ackErr != nil {
		return f.ackErr
	}
	f.acks = append(f.acks, ackCall{handle: handle, bytes: bytes})
	return nil
}

// foregroundOwner also exposes the pane's foreground process group.
type foregroundOwner struct{ *fakeOwner }

func (f foregroundOwner) ForegroundGroup(handle Handle) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.current(handle); err != nil {
		return 0, err
	}
	return f.pgid, f.pgidErr
}

// ── helpers ──────────────────────────────────────────────────────────────────

func registered(t *testing.T, owner Sessions) *control.Registry {
	t.Helper()
	registry := control.NewRegistry()
	Register(registry, Deps{Sessions: owner})
	return registry
}

func spawn(t *testing.T, registry *control.Registry, args control.Args) Spawned {
	t.Helper()
	answer, err := registry.Invoke("spawn_terminal", args)
	if err != nil {
		t.Fatalf("spawn_terminal: %v", err)
	}
	spawned, ok := answer.(Spawned)
	if !ok {
		t.Fatalf("spawn_terminal answered %T, want Spawned", answer)
	}
	return spawned
}

// jsonString encodes exactly what the caller typed, so the test's expectation
// and the wire form cannot drift apart by hand-escaping.
func jsonString(t *testing.T, value string) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("encoding %q: %v", value, err)
	}
	return encoded
}

func pane(window, id string, cols, rows int) control.Args {
	return control.Args{
		"cols":        raw(fmt.Sprintf("%d", cols)),
		"rows":        raw(fmt.Sprintf("%d", rows)),
		"paneId":      raw(fmt.Sprintf("%q", id)),
		"windowLabel": raw(fmt.Sprintf("%q", window)),
	}
}

// ── spawn ────────────────────────────────────────────────────────────────────

func TestSpawnRefusesAZeroSizeWithoutOpeningAPty(t *testing.T) {
	// A refusal that had already opened a PTY leaks a shell nobody can reach:
	// the caller received an error, so it holds no id to close it with.
	owner := newFakeOwner()
	registry := registered(t, owner)

	_, err := registry.Invoke("spawn_terminal", control.Args{
		"cols": raw(`0`), "rows": raw(`24`), "paneId": raw(`"v2"`),
	})
	if err == nil || !strings.Contains(err.Error(), `"cols"`) {
		t.Fatalf("error = %v, want a refusal naming cols", err)
	}
	if owner.openCount() != 0 {
		t.Fatalf("the owner was called %d time(s) for a refused spawn", owner.openCount())
	}
}

func TestSpawnRefusesAPaneKeyTwoPanesCouldShare(t *testing.T) {
	owner := newFakeOwner()
	registry := registered(t, owner)

	_, err := registry.Invoke("spawn_terminal", pane("w-1", "a/b", 80, 24))
	if err == nil || !strings.Contains(err.Error(), "paneId") {
		t.Fatalf("error = %v, want a refusal naming paneId", err)
	}
	if owner.openCount() != 0 {
		t.Fatal("a refused key must not open a PTY")
	}
}

func TestAnAbsentPaneIdSpawnsAndAnEmptyOneIsRefused(t *testing.T) {
	// Absence means the caller has no reattach key, which an earlier build
	// served as a quietly local session. Empty means the caller sent a key that
	// names nothing, which is a different answer.
	owner := newFakeOwner()
	registry := registered(t, owner)

	spawned := spawn(t, registry, control.Args{"cols": raw(`80`), "rows": raw(`24`)})
	if spawned.ID == 0 {
		t.Fatal("a session with no pane still needs an id")
	}

	_, err := registry.Invoke("spawn_terminal", pane("w-1", "", 80, 24))
	if err == nil || !strings.Contains(err.Error(), "paneId") {
		t.Fatalf("error = %v, want a refusal naming paneId", err)
	}
}

func TestPlacementIsRefusedByAnOwnerThatCannotPerformIt(t *testing.T) {
	// Ignoring cwd starts the shell in the wrong directory and the caller
	// cannot tell. The refusal names which argument could not be honoured.
	owner := newFakeOwner()
	registry := registered(t, owner)

	for _, testCase := range []struct {
		name  string
		extra string
		value string
	}{
		{"cwd", "cwd", `"<local-evidence>"`},
		{"shell", "shell", `"/bin/bash"`},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			args := pane("w-1", "v2", 80, 24)
			args[testCase.extra] = raw(testCase.value)
			_, err := registry.Invoke("spawn_terminal", args)
			if err == nil || !strings.Contains(err.Error(), testCase.extra) {
				t.Fatalf("error = %v, want a refusal naming %s", err, testCase.extra)
			}
		})
	}

	// A null or absent placement is not a placement, so it spawns.
	args := pane("w-1", "v2", 80, 24)
	args["cwd"] = raw(`null`)
	args["shell"] = raw(`null`)
	spawn(t, registry, args)
}

func TestPlacementReachesAnOwnerThatCanPerformIt(t *testing.T) {
	owner := newFakeOwner()
	registry := registered(t, placingOwner{owner})

	args := pane("w-1", "v2", 80, 24)
	args["cwd"] = raw(`"<local-evidence>"`)
	args["shell"] = raw(`"/bin/bash"`)
	spawn(t, registry, args)

	if len(owner.opens) != 1 || !owner.opens[0].placed {
		t.Fatalf("opens = %+v, want one placed open", owner.opens)
	}
	if owner.opens[0].cwd != "<local-evidence>" || owner.opens[0].shell != "/bin/bash" {
		t.Fatalf("open = %+v, want the placement verbatim", owner.opens[0])
	}
}

func TestSpawnRefusesAReplayThisBuildCannotPerform(t *testing.T) {
	owner := newFakeOwner()
	registry := registered(t, owner)

	args := pane("w-1", "v2", 80, 24)
	args["replay"] = raw(`{"fromSeq":4096}`)
	if _, err := registry.Invoke("spawn_terminal", args); err == nil {
		t.Fatal("a fromSeq replay must be refused rather than answered with an empty tail")
	}
	if owner.openCount() != 0 {
		t.Fatal("a refused replay must not open a PTY")
	}

	args["replay"] = raw(`"none"`)
	spawn(t, registry, args)
}

func TestSpawnAnswersWithTheOwnersHandle(t *testing.T) {
	// The handle is how the caller correlates output events to a pane, so it
	// has to be the owner's, not one this package invented. Its id is the
	// derived key, which is also what the owner keys its session by.
	owner := newFakeOwner()
	registry := registered(t, owner)

	spawned := spawn(t, registry, pane("w-1", "v2", 80, 24))
	if spawned.Handle.ID != "w-1/v2" {
		t.Fatalf("handle id = %q, want the derived key", spawned.Handle.ID)
	}
	if spawned.Handle.Generation != owner.live["w-1/v2"].Generation {
		t.Fatalf("handle = %+v, want the owner's", spawned.Handle)
	}
	if owner.opens[0].cols != 80 || owner.opens[0].rows != 24 {
		t.Fatalf("open = %+v, want the caller's size", owner.opens[0])
	}
}

func TestSpawnDisregardsArgumentsItDoesNotName(t *testing.T) {
	// The frontend sends onOutput, a transport object this command never reads:
	// bytes have never crossed this return value. An unknown field must not
	// turn a working spawn into a decode failure.
	owner := newFakeOwner()
	registry := registered(t, owner)

	args := pane("w-1", "v2", 80, 24)
	args["onOutput"] = raw(`{"__wails_channel":7}`)
	spawn(t, registry, args)
}

func TestSpawnCarriesTheOwnersFailure(t *testing.T) {
	owner := newFakeOwner()
	owner.openErr = errors.New("fork/exec /bin/zsh: no such file")
	registry := registered(t, owner)

	_, err := registry.Invoke("spawn_terminal", pane("w-1", "v2", 80, 24))
	if err == nil || !strings.Contains(err.Error(), "no such file") {
		t.Fatalf("error = %v, want the owner's reason", err)
	}
}

func TestRespawningAPaneRetiresThePreviousId(t *testing.T) {
	// The owner replaces its session for the key and closes the shell the old
	// id named. A write against that id must fail by name rather than land in
	// the replacement's shell.
	owner := newFakeOwner()
	registry := registered(t, owner)

	first := spawn(t, registry, pane("w-1", "v2", 80, 24))
	second := spawn(t, registry, pane("w-1", "v2", 80, 24))
	if first.ID == second.ID {
		t.Fatal("a respawn must mint a new id")
	}

	_, err := registry.Invoke("write_terminal", control.Args{
		"id": raw(fmt.Sprintf("%d", first.ID)), "data": raw(`"ls\r"`),
	})
	if err == nil || !strings.Contains(err.Error(), fmt.Sprintf("%d", first.ID)) {
		t.Fatalf("error = %v, want a refusal naming the retired id", err)
	}
	if len(owner.writes) != 0 {
		t.Fatalf("writes = %+v, want none to reach the owner", owner.writes)
	}
}

// ── write ────────────────────────────────────────────────────────────────────

func TestWriteRefusesAnUnknownIdWithoutReachingTheOwner(t *testing.T) {
	// A write that goes nowhere reads as a hung shell, which sends the reader
	// looking at the shell instead of at the id.
	owner := newFakeOwner()
	registry := registered(t, owner)

	_, err := registry.Invoke("write_terminal", control.Args{"id": raw(`9`), "data": raw(`"x"`)})
	if err == nil || !strings.Contains(err.Error(), "9") {
		t.Fatalf("error = %v, want a refusal naming the id", err)
	}
	if len(owner.writes) != 0 {
		t.Fatal("an unknown id must not reach the owner")
	}
}

func TestWriteForwardsBytesVerbatim(t *testing.T) {
	// The shell interprets the bytes. Translating a newline or trimming a
	// trailing space here would change what the user typed on its way in.
	owner := newFakeOwner()
	registry := registered(t, owner)
	spawned := spawn(t, registry, pane("w-1", "v2", 80, 24))
	id := raw(fmt.Sprintf("%d", spawned.ID))

	for _, want := range []string{"ls\r", "", "\x1b[A", "  trailing  ", "한글"} {
		if _, err := registry.Invoke("write_terminal", control.Args{"id": id, "data": jsonString(t, want)}); err != nil {
			t.Fatalf("write_terminal %q: %v", want, err)
		}
	}

	if len(owner.writes) != 5 {
		t.Fatalf("writes = %d, want 5", len(owner.writes))
	}
	for index, want := range []string{"ls\r", "", "\x1b[A", "  trailing  ", "한글"} {
		if owner.writes[index].data != want {
			t.Fatalf("write %d = %q, want %q", index, owner.writes[index].data, want)
		}
	}
}

// ── resize ───────────────────────────────────────────────────────────────────

func TestResizeRefusesAZeroSizeAndAnUnknownId(t *testing.T) {
	owner := newFakeOwner()
	registry := registered(t, owner)
	spawned := spawn(t, registry, pane("w-1", "v2", 80, 24))
	id := raw(fmt.Sprintf("%d", spawned.ID))

	if _, err := registry.Invoke("resize_terminal", control.Args{
		"id": id, "cols": raw(`80`), "rows": raw(`0`),
	}); err == nil || !strings.Contains(err.Error(), `"rows"`) {
		t.Fatal("a zero row count must be refused naming rows")
	}
	if _, err := registry.Invoke("resize_terminal", control.Args{
		"id": raw(`77`), "cols": raw(`80`), "rows": raw(`24`),
	}); err == nil || !strings.Contains(err.Error(), "77") {
		t.Fatal("an unknown id must be refused naming it")
	}
	if len(owner.resizes) != 0 {
		t.Fatalf("resizes = %+v, want none from a refused call", owner.resizes)
	}

	if _, err := registry.Invoke("resize_terminal", control.Args{
		"id": id, "cols": raw(`120`), "rows": raw(`40`),
	}); err != nil {
		t.Fatalf("resize_terminal: %v", err)
	}
	if len(owner.resizes) != 1 || owner.resizes[0].cols != 120 || owner.resizes[0].rows != 40 {
		t.Fatalf("resizes = %+v, want the caller's size", owner.resizes)
	}
}

// ── close ────────────────────────────────────────────────────────────────────

func TestCloseIsIdempotentAndSpendsNothingOnAnUnknownId(t *testing.T) {
	// The caller's intent is "not running". An id that is already gone has
	// reached that state, so reporting a failure would make an ordinary
	// double-close look like a defect.
	owner := newFakeOwner()
	registry := registered(t, owner)

	if _, err := registry.Invoke("close_terminal", control.Args{"id": raw(`5`)}); err != nil {
		t.Fatalf("close_terminal on an unknown id = %v, want success", err)
	}
	if len(owner.closes) != 0 {
		t.Fatal("an unknown id must not reach the owner")
	}

	spawned := spawn(t, registry, pane("w-1", "v2", 80, 24))
	id := raw(fmt.Sprintf("%d", spawned.ID))
	if _, err := registry.Invoke("close_terminal", control.Args{"id": id}); err != nil {
		t.Fatalf("close_terminal: %v", err)
	}
	if len(owner.closes) != 1 || owner.liveCount() != 0 {
		t.Fatalf("closes = %+v, live = %d", owner.closes, owner.liveCount())
	}
	if _, err := registry.Invoke("close_terminal", control.Args{"id": id}); err != nil {
		t.Fatalf("a second close = %v, want success", err)
	}
	if len(owner.closes) != 1 {
		t.Fatal("a closed id must not reach the owner twice")
	}

	if _, err := registry.Invoke("write_terminal", control.Args{"id": id, "data": raw(`"x"`)}); err == nil {
		t.Fatal("a closed id must not be writable")
	}
}

// ── ack ──────────────────────────────────────────────────────────────────────

func TestAckIsServedOnlyByAnOwnerThatCountsDeliveredBytes(t *testing.T) {
	// The reader that has to pause lives with the owner, and this package never
	// sees the bytes. A counter kept here would account for a stream it does
	// not carry — it could report a pause while the reader kept running.
	owner := newFakeOwner()
	registry := registered(t, owner)

	_, err := registry.Invoke("ack_terminal", control.Args{"id": raw(`1`), "bytes": raw(`4096`)})
	if err == nil || !strings.Contains(err.Error(), "not served") {
		t.Fatalf("error = %v, want a declared refusal", err)
	}
	if !isUnserved(registry, "ack_terminal") {
		t.Fatal("ack_terminal must appear in the table as unserved, not as unknown")
	}
}

func TestAckReachesAnOwnerThatCountsDeliveredBytes(t *testing.T) {
	owner := newFakeOwner()
	registry := registered(t, flowingOwner{owner})
	spawned := spawn(t, registry, pane("w-1", "v2", 80, 24))
	id := raw(fmt.Sprintf("%d", spawned.ID))

	if _, err := registry.Invoke("ack_terminal", control.Args{"id": id, "bytes": raw(`5000`)}); err != nil {
		t.Fatalf("ack_terminal: %v", err)
	}
	if len(owner.acks) != 1 || owner.acks[0].bytes != 5000 {
		t.Fatalf("acks = %+v, want the caller's count", owner.acks)
	}
	if _, err := registry.Invoke("ack_terminal", control.Args{"id": raw(`88`), "bytes": raw(`1`)}); err == nil {
		t.Fatal("an unknown id must be refused")
	}
}

// ── pane observation ─────────────────────────────────────────────────────────

func TestPaneAliveFollowsTheSessionsLife(t *testing.T) {
	// This answers "this process holds a live session for that pane" and
	// nothing more. An earlier build asked a daemon that outlived the app, so a
	// caller reading it as "survives a restart" would skip a spawn it needs.
	owner := newFakeOwner()
	registry := registered(t, owner)

	answer, err := registry.Invoke("pty_pane_alive", control.Args{"paneId": raw(`"v2"`)})
	if err != nil || answer != false {
		t.Fatalf("pty_pane_alive = %v, %v, want false for a pane that never spawned", answer, err)
	}

	spawned := spawn(t, registry, pane("w-1", "v2", 80, 24))
	if answer, err := registry.Invoke("pty_pane_alive", control.Args{"paneId": raw(`"v2"`)}); err != nil || answer != true {
		t.Fatalf("pty_pane_alive = %v, %v, want true", answer, err)
	}

	if _, err := registry.Invoke("close_terminal", control.Args{"id": raw(fmt.Sprintf("%d", spawned.ID))}); err != nil {
		t.Fatalf("close_terminal: %v", err)
	}
	if answer, err := registry.Invoke("pty_pane_alive", control.Args{"paneId": raw(`"v2"`)}); err != nil || answer != false {
		t.Fatalf("pty_pane_alive = %v, %v, want false after close", answer, err)
	}

	if _, err := registry.Invoke("pty_pane_alive", control.Args{"paneId": raw(`""`)}); err == nil {
		t.Fatal("an empty pane id names nothing and must be refused")
	}
}

func TestPanePidIsServedOnlyByAnOwnerThatExposesTheForegroundGroup(t *testing.T) {
	// The answer is the pgid of the command running in the pane right now, read
	// from the PTY master the owner holds. The owner's shell pid is a different
	// process, and answering with it would attach session tracking to the shell
	// instead of to the command it launched.
	registry := registered(t, newFakeOwner())
	if _, err := registry.Invoke("pty_pane_pid", control.Args{"paneId": raw(`"v2"`)}); err == nil ||
		!strings.Contains(err.Error(), "not served") {
		t.Fatal("pty_pane_pid must be a declared refusal over an owner that cannot answer it")
	}
	if !isUnserved(registry, "pty_pane_pid") {
		t.Fatal("pty_pane_pid must appear in the table as unserved")
	}

	owner := newFakeOwner()
	served := registered(t, foregroundOwner{owner})

	answer, err := served.Invoke("pty_pane_pid", control.Args{"paneId": raw(`"v2"`)})
	if err != nil || answer != nil {
		t.Fatalf("pty_pane_pid = %v, %v, want null for a pane with no session", answer, err)
	}

	spawn(t, served, pane("w-1", "v2", 80, 24))
	answer, err = served.Invoke("pty_pane_pid", control.Args{"paneId": raw(`"v2"`)})
	if err != nil || answer != 4242 {
		t.Fatalf("pty_pane_pid = %v, %v, want the foreground group", answer, err)
	}
}

// ── the table this build publishes ───────────────────────────────────────────

func isUnserved(registry *control.Registry, name string) bool {
	for _, entry := range registry.Describe().Unserved {
		if entry.Name == name {
			return entry.BlockedBy != ""
		}
	}
	return false
}

func TestTheAbsentFeaturesAreRefusedWithReasonsRatherThanAnswered(t *testing.T) {
	// Each of these has a subject that does not exist in this generation: a
	// sealing supervisor, a service sidecar, a session daemon. A plausible
	// answer would report an empty store or a downed component, and the caller
	// would act on it — the catalogue builds a "restart the daemon" hint out of
	// exactly that.
	registry := registered(t, newFakeOwner())
	for _, name := range []string{
		"pty_read_sealed_screen", "pty_sidecar_request",
		"pty_daemon_status", "pty_daemon_restart", "pty_daemon_upgrade",
	} {
		t.Run(name, func(t *testing.T) {
			if !isUnserved(registry, name) {
				t.Fatal("must be declared unserved with a reason, not left unknown")
			}
			_, err := registry.Invoke(name, control.Args{})
			if err == nil {
				t.Fatal("must refuse rather than answer")
			}
			if strings.Contains(err.Error(), "is not registered") {
				t.Fatalf("error = %v, want the refusal reason rather than an unknown command", err)
			}
		})
	}
}

func TestEveryCommandInTheGroupIsAnsweredOrRefused(t *testing.T) {
	// "Not built here" and "no such command" must not collapse: a caller that
	// receives only "unknown command" re-investigates settled ground.
	registry := registered(t, newFakeOwner())
	table := registry.Describe()
	known := map[string]bool{}
	for _, command := range table.Commands {
		known[command.Name] = true
	}
	for _, entry := range table.Unserved {
		known[entry.Name] = true
	}

	for _, name := range []string{
		"spawn_terminal", "write_terminal", "resize_terminal", "close_terminal",
		"ack_terminal", "pty_pane_alive", "pty_pane_pid", "pty_read_sealed_screen",
		"pty_sidecar_request", "pty_daemon_status", "pty_daemon_restart", "pty_daemon_upgrade",
	} {
		if !known[name] {
			t.Errorf("%s is neither served nor declared unserved", name)
		}
	}
}

func TestEveryServedCommandAnswersWithNoWindow(t *testing.T) {
	// None of these holds a window: they route to an owner that holds a file
	// descriptor. Marking one framework-owned would make it unanswerable
	// headless for no reason the code carries.
	registry := registered(t, newFakeOwner())
	for _, command := range registry.Describe().Commands {
		if command.Owner != control.OwnerCore {
			t.Errorf("%s is owned by %q, want %q", command.Name, command.Owner, control.OwnerCore)
		}
	}
}

func TestRegisteringOverNoOwnerFailsAtBoot(t *testing.T) {
	// A process that registered these over no owner would nil-dereference on a
	// user's first spawn, inside a pane, rather than while it was starting.
	defer func() {
		recovered := recover()
		if recovered == nil {
			t.Fatal("registering with no session owner must fail at boot")
		}
		if !strings.Contains(fmt.Sprint(recovered), "owner") {
			t.Fatalf("panic = %v, want it to name what is missing", recovered)
		}
	}()
	Register(control.NewRegistry(), Deps{})
}

// ── concurrency ──────────────────────────────────────────────────────────────

func TestConcurrentSpawnAndCloseLeaveNothingBehind(t *testing.T) {
	// Panes open and close from separate goroutines — a window closing while
	// another opens. A torn table would hand two panes one id, and one pane's
	// keystrokes would reach the other's shell.
	owner := newFakeOwner()
	registry := registered(t, owner)

	const panes = 32
	var group sync.WaitGroup
	for index := 0; index < panes; index++ {
		group.Add(1)
		go func(index int) {
			// t.Fatalf belongs to the test goroutine, so failures are recorded
			// and this one returns on its own.
			defer group.Done()
			answer, err := registry.Invoke("spawn_terminal", pane("w-1", fmt.Sprintf("v%d", index), 80, 24))
			if err != nil {
				t.Errorf("spawn_terminal: %v", err)
				return
			}
			spawned, ok := answer.(Spawned)
			if !ok {
				t.Errorf("spawn_terminal answered %T, want Spawned", answer)
				return
			}
			if _, err := registry.Invoke("close_terminal", control.Args{
				"id": raw(fmt.Sprintf("%d", spawned.ID)),
			}); err != nil {
				t.Errorf("close_terminal: %v", err)
			}
		}(index)
	}
	group.Wait()

	if owner.liveCount() != 0 {
		t.Fatalf("the owner still holds %d session(s)", owner.liveCount())
	}
	for index := 0; index < panes; index++ {
		answer, err := registry.Invoke("pty_pane_alive", control.Args{
			"paneId": raw(fmt.Sprintf("%q", fmt.Sprintf("v%d", index))),
		})
		if err != nil || answer != false {
			t.Fatalf("pty_pane_alive(v%d) = %v, %v, want false", index, answer, err)
		}
	}
}

// ── source gates ─────────────────────────────────────────────────────────────

func packageSources(t *testing.T) map[string]string {
	t.Helper()
	items, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("reading the package: %v", err)
	}
	sources := map[string]string{}
	for _, item := range items {
		name := item.Name()
		if item.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		contents, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("reading %s: %v", name, err)
		}
		sources[name] = string(contents)
	}
	if len(sources) == 0 {
		// A gate that finds nothing to inspect enforces nothing.
		t.Fatal("no package sources were found")
	}
	return sources
}

func TestThisPackageReadsNothingAmbient(t *testing.T) {
	// The caller passes what it read. It is what lets one command answer
	// identically in a window, in a headless server, and in a test — and a type
	// cannot stop one function from calling the global again, so the source is
	// what gets checked. An earlier build pinned the same rule by scanning its
	// own file.
	for name, source := range packageSources(t) {
		for _, forbidden := range []string{
			"os.Getenv", "os.LookupEnv", "os.Environ", "os.Getwd", "os.UserHomeDir",
			"os.Executable", "runtime.GOOS",
		} {
			if strings.Contains(source, forbidden) {
				t.Errorf("%s calls %s; the process supplies what it read", name, forbidden)
			}
		}
	}
}

func TestThisPackageNamesNoFrameworkOrPlugin(t *testing.T) {
	// The owner arrives through an interface declared here. Naming the plugin
	// would make the core answer only where that plugin is linked, and the
	// command names would stop being one door.
	for name, source := range packageSources(t) {
		for _, forbidden := range []string{"wailsapp/wails", "soksak-plugin-", "creack/pty"} {
			if strings.Contains(source, forbidden) {
				t.Errorf("%s names %s; the owner is injected, not imported", name, forbidden)
			}
		}
	}
}

func TestPanePidCarriesTheOwnersFailureRatherThanNull(t *testing.T) {
	// A pane that holds no session and a pane whose group could not be read are
	// two different answers. Collapsing the second into null would tell the
	// caller no command is running when the truth is that nobody could look.
	owner := newFakeOwner()
	owner.pgidErr = errors.New("ioctl TIOCGPGRP: inappropriate ioctl for device")
	registry := registered(t, foregroundOwner{owner})
	spawn(t, registry, pane("w-1", "v2", 80, 24))

	answer, err := registry.Invoke("pty_pane_pid", control.Args{"paneId": raw(`"v2"`)})
	if err == nil {
		t.Fatalf("pty_pane_pid = %v, want the owner's failure rather than an answer", answer)
	}
	if !strings.Contains(err.Error(), "v2") || !strings.Contains(err.Error(), "TIOCGPGRP") {
		t.Fatalf("error = %v, want it to name the pane and carry the reason", err)
	}
}

// ── the owner's failures ─────────────────────────────────────────────────────

func TestAnOwnersRefusalIsCarriedRatherThanPassedOffAsDone(t *testing.T) {
	// Every one of these reaches a file descriptor this package does not hold.
	// A handler that answered nil for a write the owner refused would leave the
	// caller believing the keystroke landed, and the pane would look hung with
	// nothing anywhere naming the failure.
	for _, testCase := range []struct {
		name    string
		fail    func(*fakeOwner)
		command string
		args    func(id json.RawMessage) control.Args
		reason  string
	}{
		{
			name:    "write",
			fail:    func(owner *fakeOwner) { owner.writeErr = errors.New("write /dev/ptmx: input/output error") },
			command: "write_terminal",
			args:    func(id json.RawMessage) control.Args { return control.Args{"id": id, "data": raw(`"ls\r"`)} },
			reason:  "input/output error",
		},
		{
			name:    "resize",
			fail:    func(owner *fakeOwner) { owner.resizeErr = errors.New("ioctl TIOCSWINSZ: bad file descriptor") },
			command: "resize_terminal",
			args: func(id json.RawMessage) control.Args {
				return control.Args{"id": id, "cols": raw(`120`), "rows": raw(`40`)}
			},
			reason: "bad file descriptor",
		},
		{
			name:    "close",
			fail:    func(owner *fakeOwner) { owner.closeErr = errors.New("kill 4242: operation not permitted") },
			command: "close_terminal",
			args:    func(id json.RawMessage) control.Args { return control.Args{"id": id} },
			reason:  "operation not permitted",
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			owner := newFakeOwner()
			registry := registered(t, owner)
			spawned := spawn(t, registry, pane("w-1", "v2", 80, 24))
			testCase.fail(owner)

			_, err := registry.Invoke(testCase.command, testCase.args(raw(fmt.Sprintf("%d", spawned.ID))))
			if err == nil {
				t.Fatal("the owner refused and the handler answered as though it had not")
			}
			if !strings.Contains(err.Error(), testCase.reason) {
				t.Fatalf("error = %v, want the owner's reason", err)
			}
			if !strings.Contains(err.Error(), fmt.Sprintf("%d", spawned.ID)) {
				t.Fatalf("error = %v, want it to name the session", err)
			}
		})
	}

	owner := newFakeOwner()
	owner.ackErr = errors.New("session gone")
	registry := registered(t, flowingOwner{owner})
	spawned := spawn(t, registry, pane("w-1", "v2", 80, 24))
	_, err := registry.Invoke("ack_terminal", control.Args{
		"id": raw(fmt.Sprintf("%d", spawned.ID)), "bytes": raw(`4096`),
	})
	if err == nil || !strings.Contains(err.Error(), "session gone") {
		t.Fatalf("error = %v, want the owner's reason", err)
	}
}

func TestACloseTheOwnerCouldNotPerformLeavesTheSessionReachable(t *testing.T) {
	// A failed close is a shell still running. Dropping the id here would make
	// the caller's retry answer "already gone" — a success for work nobody did,
	// and the only handle that could have reaped the shell is gone with it.
	owner := newFakeOwner()
	owner.closeErr = errors.New("kill 4242: operation not permitted")
	registry := registered(t, owner)
	spawned := spawn(t, registry, pane("w-1", "v2", 80, 24))
	id := raw(fmt.Sprintf("%d", spawned.ID))

	if _, err := registry.Invoke("close_terminal", control.Args{"id": id}); err == nil {
		t.Fatal("a close the owner refused must be reported")
	}
	if owner.liveCount() != 1 {
		t.Fatalf("the owner holds %d session(s); the fake must keep a shell it could not reap", owner.liveCount())
	}

	owner.closeErr = nil
	if _, err := registry.Invoke("close_terminal", control.Args{"id": id}); err != nil {
		t.Fatalf("the retry = %v, want it to reach the owner again", err)
	}
	if len(owner.closes) != 2 {
		t.Fatalf("closes = %d, want the retry to have reached the owner", len(owner.closes))
	}
	if owner.liveCount() != 0 {
		t.Fatal("the retry left the shell running")
	}
	if _, err := registry.Invoke("close_terminal", control.Args{"id": id}); err != nil {
		t.Fatalf("a third close = %v, want the ordinary idempotent success", err)
	}
	if len(owner.closes) != 2 {
		t.Fatal("a session already reaped must not reach the owner again")
	}
}

func TestASessionWithNoPaneStillCarriesItsWindowToTheOwner(t *testing.T) {
	// The caller sends a window label whether or not it sends a pane id, and
	// the key is the only thing about the caller the owner receives. Dropping
	// the label for a pane-less session would be the silent disregard this
	// command refuses cwd and shell for.
	owner := newFakeOwner()
	registry := registered(t, owner)

	spawned := spawn(t, registry, control.Args{
		"cols": raw(`80`), "rows": raw(`24`), "windowLabel": raw(`"w-2"`), "paneId": raw(`null`),
	})
	if !strings.HasPrefix(spawned.Handle.ID, "w-2/") {
		t.Fatalf("key = %q, want the window it was spawned in", spawned.Handle.ID)
	}
	if owner.opens[0].key != spawned.Handle.ID {
		t.Fatalf("the owner received %q and the caller was told %q", owner.opens[0].key, spawned.Handle.ID)
	}

	// It is still not findable by pane: it has no reattach key at all.
	answer, err := registry.Invoke("pty_pane_alive", control.Args{"paneId": raw(`"w-2"`)})
	if err != nil || answer != false {
		t.Fatalf("pty_pane_alive = %v, %v, want false", answer, err)
	}

	// And a window label that would break the split is refused on this path too.
	if _, err := registry.Invoke("spawn_terminal", control.Args{
		"cols": raw(`80`), "rows": raw(`24`), "windowLabel": raw(`"w-2/x"`),
	}); err == nil || !strings.Contains(err.Error(), "windowLabel") {
		t.Fatalf("error = %v, want a refusal naming windowLabel", err)
	}
}
