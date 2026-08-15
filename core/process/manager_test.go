package process

import (
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// ── a child that starts nothing ───────────────────────────────────────────────

type fakeSpawner struct {
	mu       sync.Mutex
	started  []Spec
	children []*fakeChild
}

func (spawner *fakeSpawner) Start(spec Spec) (Child, error) {
	spawner.mu.Lock()
	defer spawner.mu.Unlock()
	child := newFakeChild(4000 + len(spawner.children))
	spawner.started = append(spawner.started, spec)
	spawner.children = append(spawner.children, child)
	return child, nil
}

func (spawner *fakeSpawner) starts() int {
	spawner.mu.Lock()
	defer spawner.mu.Unlock()
	return len(spawner.started)
}

func (spawner *fakeSpawner) child(index int) *fakeChild {
	spawner.mu.Lock()
	defer spawner.mu.Unlock()
	return spawner.children[index]
}

type fakeChild struct {
	pid         int
	stdinRead   *os.File
	stdinWrite  *os.File
	stdoutRead  *os.File
	stdoutWrite *os.File
	stderrRead  *os.File
	stderrWrite *os.File

	exit      chan int
	once      sync.Once
	signalled atomic.Int32
	waits     atomic.Int32
}

func newFakeChild(pid int) *fakeChild {
	child := &fakeChild{pid: pid, exit: make(chan int, 1)}
	var err error
	if child.stdinRead, child.stdinWrite, err = os.Pipe(); err != nil {
		panic(err)
	}
	if child.stdoutRead, child.stdoutWrite, err = os.Pipe(); err != nil {
		panic(err)
	}
	if child.stderrRead, child.stderrWrite, err = os.Pipe(); err != nil {
		panic(err)
	}
	return child
}

func (child *fakeChild) PID() int              { return child.pid }
func (child *fakeChild) Stdin() io.WriteCloser { return child.stdinWrite }
func (child *fakeChild) Stdout() io.ReadCloser { return child.stdoutRead }
func (child *fakeChild) Stderr() io.ReadCloser { return child.stderrRead }

func (child *fakeChild) Wait() (int, error) {
	child.waits.Add(1)
	return <-child.exit, nil
}

func (child *fakeChild) Signal() error {
	child.signalled.Add(1)
	child.die(-1)
	return nil
}

// say writes to stdout the way the child would.
func (child *fakeChild) say(text string) {
	if _, err := child.stdoutWrite.WriteString(text); err != nil {
		panic(err)
	}
}

// die ends the child: its output pipes close and Wait answers.
func (child *fakeChild) die(code int) {
	child.once.Do(func() {
		_ = child.stdoutWrite.Close()
		_ = child.stderrWrite.Close()
		_ = child.stdinRead.Close()
		child.exit <- code
	})
}

// exitOnly ends the direct child while something else still holds its stdout —
// a grandchild that outlives its parent.
func (child *fakeChild) exitOnly(code int) { child.exit <- code }

// ── a consumer that can leave ────────────────────────────────────────────────

type recordingSink struct {
	mu      sync.Mutex
	events  []string
	gone    bool
	onExit  func(Exit)
	exits   chan Exit
	outputs chan string
	// departed closes the first time this sink answers Gone, which is the
	// boundary at which the reader stops delivering and starts draining.
	departed chan struct{}
	left     sync.Once
	// handed counts every delivery the reader attempted, answered or refused.
	// The recorded events cannot stand in for it: a sink that has left records
	// nothing, so a reader still handing bytes to a departed consumer would
	// leave no trace at all.
	handed atomic.Int64
}

func newRecordingSink() *recordingSink {
	return &recordingSink{
		exits:    make(chan Exit, 8),
		outputs:  make(chan string, 64),
		departed: make(chan struct{}),
	}
}

func (sink *recordingSink) waitDeparted(t *testing.T) {
	t.Helper()
	select {
	case <-sink.departed:
	case <-time.After(10 * time.Second):
		t.Fatal("the reader never learned its consumer had left")
	}
}

func (sink *recordingSink) EmitProcessOutput(output Output) Delivery {
	sink.handed.Add(1)
	bytes, err := base64.StdEncoding.DecodeString(output.DataBase64)
	if err != nil {
		panic(err)
	}
	sink.mu.Lock()
	gone := sink.gone
	if !gone {
		sink.events = append(sink.events, fmt.Sprintf("%s:%s", output.Stream, bytes))
	}
	sink.mu.Unlock()
	if gone {
		sink.left.Do(func() { close(sink.departed) })
		return Gone
	}
	// Non-blocking: a test that never reads must not stall the reader it is
	// observing.
	select {
	case sink.outputs <- string(bytes):
	default:
	}
	return Delivered
}

func (sink *recordingSink) EmitProcessExit(exit Exit) Delivery {
	if sink.onExit != nil {
		sink.onExit(exit)
	}
	sink.mu.Lock()
	sink.events = append(sink.events, fmt.Sprintf("exit:%d", exit.Code))
	sink.mu.Unlock()
	sink.exits <- exit
	return Delivered
}

func (sink *recordingSink) recorded() []string {
	sink.mu.Lock()
	defer sink.mu.Unlock()
	return append([]string(nil), sink.events...)
}

func (sink *recordingSink) waitExit(t *testing.T) Exit {
	t.Helper()
	select {
	case exit := <-sink.exits:
		return exit
	case <-time.After(10 * time.Second):
		t.Fatal("no exit ever crossed the sink")
		return Exit{}
	}
}

func (sink *recordingSink) waitOutput(t *testing.T) string {
	t.Helper()
	select {
	case text := <-sink.outputs:
		return text
	case <-time.After(10 * time.Second):
		t.Fatal("no output ever crossed the sink")
		return ""
	}
}

func testManager(t *testing.T) (*Manager, *fakeSpawner, *recordingSink) {
	t.Helper()
	spawner := &fakeSpawner{}
	sink := newRecordingSink()
	manager := NewManager(Deps{Home: "/home", Environment: []string{"PATH=/bin"}, Sink: sink, Spawner: spawner})
	t.Cleanup(func() { _, _ = manager.ReapAll() })
	return manager, spawner, sink
}

// ── handles ──────────────────────────────────────────────────────────────────

// The first handle is 1, and no handle is ever reused. Zero must never name a
// live child: a persisted handle is JSON, and zero is what absence looks like
// there.
func TestTheFirstHandleIsOneAndNoHandleRepeats(t *testing.T) {
	manager, _, _ := testManager(t)
	seen := map[uint32]bool{}
	for round := 0; round < 3; round++ {
		id, err := manager.Spawn(Request{Cmd: "/bin/true"})
		if err != nil {
			t.Fatal(err)
		}
		if round == 0 && id != 1 {
			t.Fatalf("the first handle is %d, want 1", id)
		}
		if id == 0 {
			t.Fatal("zero is what absence looks like in JSON and must never name a child")
		}
		if seen[id] {
			t.Fatalf("handle %d was handed out twice", id)
		}
		seen[id] = true
	}
	if _, err := manager.Kill(2); err != nil {
		t.Fatal(err)
	}
	id, err := manager.Spawn(Request{Cmd: "/bin/true"})
	if err != nil {
		t.Fatal(err)
	}
	if seen[id] {
		t.Fatalf("handle %d was reused after the child holding it was reaped", id)
	}
}

// ── refusals that start nothing ──────────────────────────────────────────────

// One failure fails them all, before anything is started: a child that comes up
// half-configured reports that failure as anything but a secret problem.
func TestSecretsWithoutANamespaceStartNothing(t *testing.T) {
	manager, spawner, _ := testManager(t)
	if _, err := manager.Spawn(Request{Cmd: "/bin/true", SecretEnv: map[string]string{"A": "k"}}); err == nil {
		t.Fatal("secretEnv without ns must be refused")
	}
	if spawner.starts() != 0 {
		t.Fatalf("the spawner was called %d times for a request that was refused", spawner.starts())
	}
}

func TestSecretsWithoutAVaultStartNothing(t *testing.T) {
	spawner := &fakeSpawner{}
	manager := NewManager(Deps{Home: "/home", Sink: newRecordingSink(), Spawner: spawner})
	_, err := manager.Spawn(Request{Cmd: "/bin/true", Namespace: "plug", SecretEnv: map[string]string{"A": "k"}})
	if err == nil {
		t.Fatal("a host with no vault must refuse rather than inject an empty value")
	}
	if !strings.Contains(err.Error(), "vault") {
		t.Fatalf("error %q must say this process has no vault", err)
	}
	if spawner.starts() != 0 {
		t.Fatalf("the spawner was called %d times for a request that was refused", spawner.starts())
	}
}

// A host without a vault still starts children. Tying every spawn to a vault
// would leave a vault-less process unable to start anything at all.
func TestAHostWithoutAVaultStillSpawns(t *testing.T) {
	spawner := &fakeSpawner{}
	manager := NewManager(Deps{Home: "/home", Sink: newRecordingSink(), Spawner: spawner})
	if _, err := manager.Spawn(Request{Cmd: "/bin/true"}); err != nil {
		t.Fatalf("a vault-less host must still spawn: %v", err)
	}
	if spawner.starts() != 1 {
		t.Fatalf("the spawner was called %d times, want once", spawner.starts())
	}
}

// A host that was given no spawner does not pretend to have started something.
func TestAHostWithNoSpawnerSaysSoRatherThanAnsweringZero(t *testing.T) {
	manager := NewManager(Deps{Home: "/home"})
	id, err := manager.Spawn(Request{Cmd: "/bin/true"})
	if err == nil {
		t.Fatalf("a host with no spawner answered handle %d", id)
	}
	if id != 0 {
		t.Fatalf("a refused spawn answered handle %d", id)
	}
}

// ── the exit event ───────────────────────────────────────────────────────────

// The exit is the last event of the stream, after the final output byte. The
// consumer already compensates for the other order with a timer, so keeping
// exit last is load-bearing.
func TestTheExitArrivesAfterTheLastOutputByte(t *testing.T) {
	manager, spawner, sink := testManager(t)
	if _, err := manager.Spawn(Request{Cmd: "/bin/sh"}); err != nil {
		t.Fatal(err)
	}
	child := spawner.child(0)
	child.say("out")
	child.die(7)

	exit := sink.waitExit(t)
	if exit.Code != 7 {
		t.Fatalf("exit code %d, want 7", exit.Code)
	}
	recorded := sink.recorded()
	want := []string{"stdout:out", "exit:7"}
	if fmt.Sprint(recorded) != fmt.Sprint(want) {
		t.Fatalf("events %v, want %v", recorded, want)
	}
}

// The exit receipt and leaving the ledger are one event. An alive:false entry
// still listed after the consumer saw the exit means the ownership ledger
// disagrees with the facts.
func TestDeregistrationPrecedesTheExitReceipt(t *testing.T) {
	manager, spawner, sink := testManager(t)
	var listedAtExit []Info
	sink.onExit = func(Exit) { listedAtExit = manager.List() }

	if _, err := manager.Spawn(Request{Cmd: "/bin/sh"}); err != nil {
		t.Fatal(err)
	}
	spawner.child(0).die(0)
	sink.waitExit(t)

	if len(listedAtExit) != 0 {
		t.Fatalf("the ledger still held %v when the exit receipt was delivered", listedAtExit)
	}
}

// ── the measured deadlock ────────────────────────────────────

// A consumer that left ends the pump; the reader then drains so the child never
// blocks in write, and a kill is not held up by it.
//
// The measured bug was a reader holding the child mutex inside wait(), so a kill
// blocked forever, the child became a zombie and swap ran to 32 GB. Go has no
// such mutex; the equivalent hazard is a second Wait. Exactly one goroutine per
// session calls Wait, and the kill path only signals and then observes.
func TestADepartedConsumerNeverHoldsUpAKill(t *testing.T) {
	manager, spawner, sink := testManager(t)
	sink.mu.Lock()
	sink.gone = true
	sink.mu.Unlock()

	id, err := manager.Spawn(Request{Cmd: "/bin/sh"})
	if err != nil {
		t.Fatal(err)
	}
	child := spawner.child(0)
	shouting := make(chan struct{})
	go func() {
		defer close(shouting)
		for {
			if _, err := child.stdoutWrite.WriteString("x\n"); err != nil {
				return
			}
		}
	}()

	// The reader has answered Gone and moved into drain; only from there does
	// the kill have anything to be held up by.
	sink.waitDeparted(t)

	start := time.Now()
	reaped, err := manager.Kill(id)
	if err != nil {
		t.Fatal(err)
	}
	if !reaped {
		t.Fatal("a live child must come back reaped")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("kill took %v while the reader was draining", elapsed)
	}
	<-shouting
}

// Once the consumer has answered Gone, the reader stops handing it bytes.
//
// Gone is the whole reason a delivery is a value and not a void return, and the
// tests that wait on departure only prove the sink was asked once — a reader
// that ignored the answer would keep producing for a consumer that left, and
// nothing would say so. The child goes on shouting after the departure and then
// ends, so the count is read at a boundary rather than after a sleep.
func TestADepartedConsumerIsHandedNothingFurther(t *testing.T) {
	manager, spawner, sink := testManager(t)
	sink.mu.Lock()
	sink.gone = true
	sink.mu.Unlock()

	if _, err := manager.Spawn(Request{Cmd: "/bin/sh"}); err != nil {
		t.Fatal(err)
	}
	child := spawner.child(0)
	child.say("first")
	// The one delivery that answered Gone has happened; everything after it is
	// production for nobody.
	sink.waitDeparted(t)
	for shout := 0; shout < 200; shout++ {
		child.say("more")
	}
	child.die(0)
	sink.waitExit(t)

	if handed := sink.handed.Load(); handed != 1 {
		t.Fatalf("the reader handed %d deliveries to a consumer that left after the first", handed)
	}
}

// ── kill ─────────────────────────────────────────────────────────────────────

// Killing what is already gone is not an error — the plugin API kills on
// unload — but it does not read as a reaping either.
func TestKillingAnUnknownHandleIsNotAReaping(t *testing.T) {
	manager, _, _ := testManager(t)
	reaped, err := manager.Kill(99)
	if err != nil {
		t.Fatalf("killing an already-finished handle must stay idempotent: %v", err)
	}
	if reaped {
		t.Fatal("nothing was there to reap, and that must not read as reaped")
	}
}

func TestKillSignalsAndWaits(t *testing.T) {
	manager, spawner, _ := testManager(t)
	id, err := manager.Spawn(Request{Cmd: "/bin/sh"})
	if err != nil {
		t.Fatal(err)
	}
	child := spawner.child(0)
	reaped, err := manager.Kill(id)
	if err != nil || !reaped {
		t.Fatalf("kill = %v, %v", reaped, err)
	}
	if child.signalled.Load() == 0 {
		t.Fatal("kill must signal the child")
	}
	// A kill signal is not a reaping. Exactly one goroutine waits, and the kill
	// path returns only once that wait is over.
	if child.waits.Load() != 1 {
		t.Fatalf("the child was waited on %d times, want exactly one waiter", child.waits.Load())
	}
	if listed := manager.List(); len(listed) != 0 {
		t.Fatalf("a reaped child is still listed: %v", listed)
	}
}

// ── stdin ────────────────────────────────────────────────────────────────────

// Swallowing a write leaves the caller seeing only "my input vanished".
func TestWriteNamesWhatItCouldNotDo(t *testing.T) {
	manager, _, _ := testManager(t)
	if err := manager.Write(99, []byte("hi")); err == nil {
		t.Fatal("writing to a handle that names nothing must fail")
	} else if !strings.Contains(err.Error(), "99") {
		t.Fatalf("error %q must name the handle", err)
	}

	id, err := manager.Spawn(Request{Cmd: "/bin/sh"})
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.CloseStdin(id); err != nil {
		t.Fatal(err)
	}
	err = manager.Write(id, []byte("hi"))
	if err == nil {
		t.Fatal("writing to a closed stdin must fail")
	}
	if !strings.Contains(err.Error(), "stdin") {
		t.Fatalf("error %q must say which end is closed", err)
	}
}

// Closing stdin twice is a no-op; closing a handle that names nothing is not.
// The caller holds a handle for a child it means to release, and that child
// would wait for an EOF that never comes while the caller believes it was sent.
func TestClosingStdinIsIdempotentAndAnUnknownHandleFails(t *testing.T) {
	manager, _, _ := testManager(t)
	id, err := manager.Spawn(Request{Cmd: "/bin/sh"})
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.CloseStdin(id); err != nil {
		t.Fatal(err)
	}
	if err := manager.CloseStdin(id); err != nil {
		t.Fatalf("closing an already closed stdin must be a no-op: %v", err)
	}
	if err := manager.CloseStdin(99); err == nil {
		t.Fatal("closing stdin on a handle that names nothing must fail")
	}
}

// ── the list ─────────────────────────────────────────────────────────────────

// Empty is an empty list, not null: a nil slice marshals to null, which reads
// as "no answer" rather than "nothing running".
func TestAnEmptyListIsASliceAndNotNull(t *testing.T) {
	manager, _, _ := testManager(t)
	listed := manager.List()
	if listed == nil {
		t.Fatal("an empty list must be [] — null reads as no answer at all")
	}
	if len(listed) != 0 {
		t.Fatalf("a fresh manager listed %v", listed)
	}
}

func TestTheListIsSortedAndCarriesBothIdentifiers(t *testing.T) {
	manager, _, _ := testManager(t)
	label := "w-a"
	for round := 0; round < 3; round++ {
		if _, err := manager.Spawn(Request{Cmd: "/bin/sh", Args: []string{"-c", "true"}, Window: label}); err != nil {
			t.Fatal(err)
		}
	}
	listed := manager.List()
	if len(listed) != 3 {
		t.Fatalf("listed %d children, want 3", len(listed))
	}
	for index, info := range listed {
		if info.ID != uint32(index+1) {
			t.Fatalf("entry %d has id %d — the list is sorted by handle", index, info.ID)
		}
		// The handle is a small counter; the pid is the only thing that can
		// answer "is that process alive". Confusing the two makes the question
		// unaskable.
		if info.PID == int(info.ID) {
			t.Fatalf("entry %d has pid %d equal to its handle", index, info.PID)
		}
		if info.Window == nil || *info.Window != label {
			t.Fatalf("entry %d lost its window label", index)
		}
		if info.Cmd != "/bin/sh -c true" {
			t.Fatalf("entry %d says it runs %q", index, info.Cmd)
		}
		if !info.Alive {
			t.Fatalf("entry %d is not alive and nothing has ended", index)
		}
	}
}

// A child spawned with no window is stamped absent, not "". An empty label that
// compares equal would let one reclaim reap every windowless child at once.
func TestAChildWithNoWindowIsStampedAbsent(t *testing.T) {
	manager, _, _ := testManager(t)
	if _, err := manager.Spawn(Request{Cmd: "/bin/sh"}); err != nil {
		t.Fatal(err)
	}
	if window := manager.List()[0].Window; window != nil {
		t.Fatalf("an unowned child carries window %q rather than absence", *window)
	}
}

// A direct child that has exited while a grandchild still holds its stdout is
// the orphan surface: dead, and still in the ledger.
func TestAnExitedChildHoldingStdoutIsListedAsNotAlive(t *testing.T) {
	manager, spawner, _ := testManager(t)
	id, err := manager.Spawn(Request{Cmd: "/bin/sh"})
	if err != nil {
		t.Fatal(err)
	}
	spawner.child(0).exitOnly(3)
	<-manager.settled(id)

	listed := manager.List()
	if len(listed) != 1 {
		t.Fatalf("the entry left the ledger before its stream ended: %v", listed)
	}
	if listed[0].Alive {
		t.Fatal("the direct child has been reaped; still saying alive hides the orphan")
	}
}

// ── reclamation ──────────────────────────────────────────────────────────────

func TestReclaimReapsOnlyThatWindowsChildren(t *testing.T) {
	manager, _, _ := testManager(t)
	for _, label := range []string{"w-a", "w-b", "w-a"} {
		if _, err := manager.Spawn(Request{Cmd: "/bin/sh", Window: label}); err != nil {
			t.Fatal(err)
		}
	}
	count, err := manager.ReclaimByWindow("w-a")
	if err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("reclaimed %d, want 2", count)
	}
	listed := manager.List()
	if len(listed) != 1 || listed[0].Window == nil || *listed[0].Window != "w-b" {
		t.Fatalf("another window's children were disturbed: %v", listed)
	}
}

// A window this manager has no record of is nothing to reap, which is not a
// failure.
func TestReclaimingAWindowWithNoChildrenIsZero(t *testing.T) {
	manager, _, _ := testManager(t)
	count, err := manager.ReclaimByWindow("w-empty")
	if err != nil {
		t.Fatalf("nothing to reap is not a failure: %v", err)
	}
	if count != 0 {
		t.Fatalf("reclaimed %d from a window with no children", count)
	}
}

// An empty label can never match, so a caller that does not know its own label
// must be told rather than allowed to spell "reap everything unowned".
func TestReclaimingWithNoLabelIsRefusedAndNeverTouchesUnownedChildren(t *testing.T) {
	manager, _, _ := testManager(t)
	if _, err := manager.Spawn(Request{Cmd: "/bin/sh"}); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.ReclaimByWindow(""); err == nil {
		t.Fatal("an empty window label must be refused")
	}
	if len(manager.List()) != 1 {
		t.Fatal("the unowned child was reaped by a label that names nothing")
	}
}

// ── shutdown ─────────────────────────────────────────────────────────────────

// Nothing in the seven commands reaps at shutdown, so the package that owns the
// children has to be tellable to stop. A child left alive past the app is one
// nobody can reach any more.
func TestReapAllReapsEveryRegisteredChild(t *testing.T) {
	manager, spawner, _ := testManager(t)
	for round := 0; round < 2; round++ {
		if _, err := manager.Spawn(Request{Cmd: "/bin/sh"}); err != nil {
			t.Fatal(err)
		}
	}
	count, err := manager.ReapAll()
	if err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("reaped %d, want 2", count)
	}
	for index := 0; index < 2; index++ {
		if spawner.child(index).signalled.Load() == 0 {
			t.Fatalf("child %d was never signalled", index)
		}
	}
	if len(manager.List()) != 0 {
		t.Fatal("the ledger still holds children after a reap-all")
	}
}
