//go:build !windows

package process

import (
	"fmt"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func realManager(t *testing.T, deps Deps) (*Manager, *recordingSink) {
	t.Helper()
	sink := newRecordingSink()
	deps.Sink = sink
	deps.Spawner = OSSpawner{}
	manager := NewManager(deps)
	t.Cleanup(func() { _, _ = manager.ReapAll() })
	return manager, sink
}

// The exit code crosses as one integer, after the last stdout byte.
func TestARealChildsExitCrossesAsOneIntegerAfterItsOutput(t *testing.T) {
	manager, sink := realManager(t, Deps{Home: t.TempDir(), Environment: []string{"PATH=/bin:/usr/bin"}})
	if _, err := manager.Spawn(Request{Cmd: "/bin/sh", Args: []string{"-c", "printf out; exit 7"}}); err != nil {
		t.Fatal(err)
	}
	exit := sink.waitExit(t)
	if exit.Code != 7 {
		t.Fatalf("exit code %d, want 7", exit.Code)
	}
	recorded := sink.recorded()
	want := []string{"stdout:out", "exit:7"}
	if fmt.Sprint(recorded) != fmt.Sprint(want) {
		t.Fatalf("events %v, want %v", recorded, want)
	}
	if listed := manager.List(); len(listed) != 0 {
		t.Fatalf("a child that delivered its exit is still listed: %v", listed)
	}
}

// A kill is not finished until the direct child has been waited on. ECHILD from
// wait4 is what proves it was reaped rather than merely signalled.
func TestKillReapsRatherThanOnlySignalling(t *testing.T) {
	manager, _ := realManager(t, Deps{Home: t.TempDir(), Environment: []string{"PATH=/bin:/usr/bin"}})
	id, err := manager.Spawn(Request{Cmd: "/bin/sh", Args: []string{"-c", "sleep 30"}})
	if err != nil {
		t.Fatal(err)
	}
	pid := manager.List()[0].PID

	reaped, err := manager.Kill(id)
	if err != nil || !reaped {
		t.Fatalf("kill = %v, %v", reaped, err)
	}

	var status syscall.WaitStatus
	waited, err := syscall.Wait4(pid, &status, syscall.WNOHANG, nil)
	if waited != -1 || err != syscall.ECHILD {
		t.Fatalf("wait4(%d) = %d, %v — kill must reap, not only signal", pid, waited, err)
	}
}

// A child looping on stdout with nobody listening: the reader drains and the
// kill is not held up by it. The regression this pins had a reader holding
// the child mutex inside wait(), so a kill blocked forever, the child became a
// zombie and swap ran to 32 GB.
func TestKillIsNotBlockedByADrainingReader(t *testing.T) {
	manager, sink := realManager(t, Deps{Home: t.TempDir(), Environment: []string{"PATH=/bin:/usr/bin"}})
	sink.mu.Lock()
	sink.gone = true
	sink.mu.Unlock()

	id, err := manager.Spawn(Request{Cmd: "/bin/sh", Args: []string{"-c", "while true; do echo x; done"}})
	if err != nil {
		t.Fatal(err)
	}
	// The reader has answered Gone and moved into drain. Killing before that
	// would prove nothing: the hazard only exists once a reader is draining.
	sink.waitDeparted(t)

	start := time.Now()
	reaped, err := manager.Kill(id)
	if err != nil || !reaped {
		t.Fatalf("kill = %v, %v", reaped, err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("kill took %v with the reader draining", elapsed)
	}
}

// alive is asked of the pid, not of a signal: a still-running process answers
// signal 0 without being disturbed.
func running(pid int) bool { return syscall.Kill(pid, 0) == nil }

// Group is why the option exists: a grandchild holding the parent's stdout
// dies with a grouped kill and survives an ungrouped one.
func TestAGroupedKillReachesTheGrandchildAndAnUngroupedOneDoesNot(t *testing.T) {
	for _, grouped := range []bool{true, false} {
		t.Run(fmt.Sprintf("group=%v", grouped), func(t *testing.T) {
			manager, sink := realManager(t, Deps{Home: t.TempDir(), Environment: []string{"PATH=/bin:/usr/bin"}})
			// The shell prints its background child's pid and then waits, so the
			// direct child is alive and a grandchild holds the same stdout.
			id, err := manager.Spawn(Request{
				Cmd:   "/bin/sh",
				Args:  []string{"-c", "sleep 30 & echo $!; wait"},
				Group: grouped,
			})
			if err != nil {
				t.Fatal(err)
			}

			grandchild, err := strconv.Atoi(strings.TrimSpace(sink.waitOutput(t)))
			if err != nil {
				t.Fatalf("the child did not name its grandchild: %v", err)
			}

			if _, err := manager.Kill(id); err != nil {
				t.Fatal(err)
			}

			if grouped {
				// The exit event can only arrive once every writer has let go of
				// stdout, and the grandchild is one of them. Its arrival is the
				// reading; a signal probe would answer yes for a zombie.
				sink.waitExit(t)
				return
			}
			// An ungrouped kill is delivered to the direct child only. The grandchild was
			// never signalled, so it is alive the instant the kill returns —
			// which is why the group option exists at all.
			if !running(grandchild) {
				t.Fatal("an ungrouped kill reached the grandchild — then the group option buys nothing")
			}
			// The absence of an exit is what is being asserted, so it is read
			// over a window rather than at a boundary: with the grandchild
			// holding stdout, EOF is hostage to its whole thirty seconds.
			select {
			case exit := <-sink.exits:
				t.Fatalf("stdout reached EOF (%v) while a grandchild still held it", exit)
			case <-time.After(time.Second):
			}
			_ = syscall.Kill(grandchild, syscall.SIGKILL)
		})
	}
}

// A child that reads stdin to the end blocks forever until stdin is closed.
func TestClosingStdinUnblocksAChildReadingToTheEnd(t *testing.T) {
	manager, sink := realManager(t, Deps{Home: t.TempDir(), Environment: []string{"PATH=/bin:/usr/bin"}})
	id, err := manager.Spawn(Request{Cmd: "/bin/cat"})
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.Write(id, []byte("hello")); err != nil {
		t.Fatal(err)
	}
	if err := manager.CloseStdin(id); err != nil {
		t.Fatal(err)
	}
	exit := sink.waitExit(t)
	if exit.Code != 0 {
		t.Fatalf("cat exited %d", exit.Code)
	}
	if recorded := sink.recorded(); len(recorded) == 0 || recorded[0] != "stdout:hello" {
		t.Fatalf("events %v — cat must echo what it was given before EOF", recorded)
	}
}

// The environment a child gets is the one that was passed in, plus only what the
// rules add. Reading it back through the child is the proof: SOKSAK_HOME is
// added, an unnamed variable survives, a named one is removed, and an internal
// SOKSAK_* never crosses.
func TestTheChildSeesExactlyTheGivenEnvironment(t *testing.T) {
	home := t.TempDir()
	manager, sink := realManager(t, Deps{
		Home:        home,
		Environment: []string{"PATH=/bin:/usr/bin", "KEEPME=1", "DROPME=1", "SOKSAK_VAULT_KEY=master"},
	})
	if _, err := manager.Spawn(Request{
		Cmd:       "/bin/sh",
		Args:      []string{"-c", `printf '%s|%s|%s|%s' "$SOKSAK_HOME" "$KEEPME" "$DROPME" "$SOKSAK_VAULT_KEY"`},
		EnvRemove: []string{"DROPME"},
	}); err != nil {
		t.Fatal(err)
	}
	sink.waitExit(t)

	want := home + "|1||"
	if got := strings.Join(sink.recorded()[:1], ""); got != "stdout:"+want {
		t.Fatalf("the child read %q, want %q", got, "stdout:"+want)
	}
}

// A secret enters the child's environment and nowhere else: not into the
// returned handle, and not onto the command line where ps would show it.
func TestASecretReachesTheChildAndNoReturnValue(t *testing.T) {
	home := t.TempDir()
	sink := newRecordingSink()
	spawner := &recordingOSSpawner{}
	manager := NewManager(Deps{
		Home:        home,
		Environment: []string{"PATH=/bin:/usr/bin"},
		Sink:        sink,
		Spawner:     spawner,
		Secrets:     fixedVault{"sk-real-9z"},
	})
	t.Cleanup(func() { _, _ = manager.ReapAll() })

	id, err := manager.Spawn(Request{
		Cmd:       "/bin/sh",
		Args:      []string{"-c", `printf %s "$SOKSAK_SECRET_0"`},
		Namespace: "plugin-a",
		Env:       map[string]string{"SOKSAK_SECRET_0": "plaintext-loser"},
		SecretEnv: map[string]string{"SOKSAK_SECRET_0": "apiKey"},
	})
	if err != nil {
		t.Fatal(err)
	}
	sink.waitExit(t)

	if got := sink.recorded()[0]; got != "stdout:sk-real-9z" {
		t.Fatalf("the child read %q — the secret must beat the plain entry of the same name", got)
	}
	if fmt.Sprint(id) == "sk-real-9z" {
		t.Fatal("the handle carried the secret")
	}
	for _, argument := range spawner.spec.Args {
		if strings.Contains(argument, "sk-real-9z") {
			t.Fatal("the secret reached the command line, where ps would show it")
		}
	}
	for _, info := range manager.List() {
		if strings.Contains(info.Cmd, "sk-real-9z") {
			t.Fatal("the secret reached the listed command")
		}
	}
}

type fixedVault struct{ plaintext string }

func (vault fixedVault) Resolve(string, string) (string, error) { return vault.plaintext, nil }

// recordingOSSpawner starts real children while keeping the spec it was given,
// so a test can look at what actually crossed into os/exec.
type recordingOSSpawner struct {
	spec Spec
}

func (spawner *recordingOSSpawner) Start(spec Spec) (Child, error) {
	spawner.spec = spec
	return OSSpawner{}.Start(spec)
}

// A direct child that exits while a grandchild still holds stdout is dead and
// still owned. That pair is the orphan surface.
func TestAnOrphanedGrandchildKeepsTheEntryVisibleAsNotAlive(t *testing.T) {
	manager, _ := realManager(t, Deps{Home: t.TempDir(), Environment: []string{"PATH=/bin:/usr/bin"}})
	id, err := manager.Spawn(Request{Cmd: "/bin/sh", Args: []string{"-c", "sleep 30 & exit 0"}})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-manager.settled(id):
	case <-time.After(10 * time.Second):
		t.Fatal("the direct child was never reaped")
	}

	listed := manager.List()
	if len(listed) != 1 {
		t.Fatalf("the entry left the ledger while its stream was still open: %v", listed)
	}
	if listed[0].Alive {
		t.Fatal("the direct child is reaped; saying alive hides the orphan")
	}
}

// The direct child exits first and a grandchild keeps its stdout. A grouped
// kill still has to reach that grandchild: it is the only thing holding the
// stream open, and until it is released no exit arrives at the consumer.
//
// A process group id cannot be reused while the group still has members, so
// naming it after the leader was reaped names this tree and no other.
func TestAGroupedKillReachesAGrandchildThatOutlivedItsParent(t *testing.T) {
	manager, sink := realManager(t, Deps{Home: t.TempDir(), Environment: []string{"PATH=/bin:/usr/bin"}})
	id, err := manager.Spawn(Request{
		Cmd:   "/bin/sh",
		Args:  []string{"-c", "sleep 30 & exit 0"},
		Group: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-manager.settled(id):
	case <-time.After(10 * time.Second):
		t.Fatal("the direct child was never reaped")
	}

	if _, err := manager.Kill(id); err != nil {
		t.Fatal(err)
	}
	// The exit can only cross once the grandchild has let go of stdout.
	sink.waitExit(t)
}

// A stdin write that filled the child's pipe must not hold up a kill.
//
// The write parks in the kernel holding the session's stdin lock, and the only
// thing that can release it is the child dying — so a kill that took that lock
// before signalling would be waiting on itself. Measured 2026-08-15: a 4 MB
// write to a child that never reads stdin hung Kill and ReapAll for ever,
// which is the shutdown path.
func TestKillIsNotBlockedByAStdinWriteThatFilledThePipe(t *testing.T) {
	manager, _ := realManager(t, Deps{Home: t.TempDir(), Environment: []string{"PATH=/bin:/usr/bin"}})
	id, err := manager.Spawn(Request{Cmd: "/bin/sh", Args: []string{"-c", "sleep 30"}})
	if err != nil {
		t.Fatal(err)
	}

	// Far more than a pipe holds, to a child that never reads: the write is
	// still parked when the kill arrives.
	writing := make(chan error, 1)
	go func() { writing <- manager.Write(id, make([]byte, 4<<20)) }()
	time.Sleep(200 * time.Millisecond)

	killed := make(chan error, 1)
	go func() {
		_, err := manager.Kill(id)
		killed <- err
	}()
	select {
	case err := <-killed:
		if err != nil {
			t.Fatalf("kill: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("kill never returned while a stdin write was parked in the kernel")
	}
	select {
	case <-writing:
	case <-time.After(10 * time.Second):
		t.Fatal("the parked write never came back after the child was reaped")
	}
}

// A consumer that left must not strand the child. The reader keeps emptying
// the pipe, so a child writing more than a pipe holds still finishes on its
// own terms — a reader that stopped reading would leave it blocked in write,
// and a child blocked in write is the one that cannot be killed cleanly.
func TestADepartedConsumerDoesNotStrandTheChild(t *testing.T) {
	manager, sink := realManager(t, Deps{Home: t.TempDir(), Environment: []string{"PATH=/bin:/usr/bin"}})
	sink.mu.Lock()
	sink.gone = true
	sink.mu.Unlock()

	// Roughly 260 KB, several times a pipe's capacity, then a code of its own.
	line := strings.Repeat("0123456789", 6)
	if _, err := manager.Spawn(Request{Cmd: "/bin/sh", Args: []string{"-c",
		"i=0; while [ $i -lt 4000 ]; do echo " + line + "; i=$((i+1)); done; exit 4"}}); err != nil {
		t.Fatal(err)
	}
	sink.waitDeparted(t)

	exit := sink.waitExit(t)
	if exit.Code != 4 {
		t.Fatalf("exit code %d, want 4 — the child was cut off mid-write rather than drained to its own ending", exit.Code)
	}
}
