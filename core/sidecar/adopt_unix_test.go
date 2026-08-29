//go:build !windows

package sidecar

import (
	"os"
	"strconv"
	"testing"
	"time"

	controlwire "github.com/soksak-ai/soksak-contract-control"
	"github.com/soksak-ai/soksak-core/core/process"
	"path/filepath"
	"syscall"
)

// A second host finds the unit the first one started, and starts nothing.
//
// This is the whole reason a unit is a process. An application that came back and started a second
// one would leave the first holding everything it had — shells somebody is working in — with nothing
// able to reach it, while the second reported healthy the entire time.
//
// Two hosts over one home stand in for two runs of the application. What separates them is exactly
// what separates two runs: the second has an empty map and whatever the first wrote down.
func TestASecondRunFindsTheUnitTheFirstStarted(t *testing.T) {
	home := shortHome(t)
	runtimeRoot := shortHome(t)
	stageUnit(t, home, "fake-unit", fakeUnitSource)
	deps := func() Deps {
		return Deps{
			Home: home, Runtime: runtimeRoot, Spawner: process.OSSpawner{}, Environment: os.Environ(),
			Dial: dialUnix, ReadyWithin: 10 * time.Second, ResolveUnit: testSidecarResolver(home),
		}
	}

	first := NewHost(deps())
	started, err := first.Start("fake-unit")
	if err != nil {
		t.Fatalf("starting the unit: %v", err)
	}

	// The first run lets go without ending anything, which is what a release is.
	if err := first.Release("fake-unit"); err != nil {
		t.Fatalf("releasing the unit: %v", err)
	}

	second := NewHost(deps())
	t.Cleanup(func() { second.StopAll() })
	found, err := second.Start("fake-unit")
	if err != nil {
		t.Fatalf("the second run could not find the unit: %v", err)
	}
	if found.PID != started.PID {
		t.Fatalf("the second run started a second process: %d then %d — the first is the one with the "+
			"work in it, and nothing can reach it now", started.PID, found.PID)
	}
	if found.Address != started.Address {
		t.Fatalf("the second run reached %q and the first bound %q", found.Address, started.Address)
	}

	// And it can drive what it found, which is what adopting is for.
	answer, err := second.Send("fake-unit", controlwire.Request{ID: "1", Command: "fake-unit.echo"})
	if err != nil || !answer.Ok {
		t.Fatalf("the adopted unit did not answer: %v %+v", err, answer)
	}
}

func TestASecondRunCanIdempotentlyStopAnOwnedUnitWithoutStartingIt(t *testing.T) {
	home := shortHome(t)
	runtimeRoot := shortHome(t)
	stageUnit(t, home, "fake-unit", fakeUnitSource)
	deps := Deps{
		Home: home, Runtime: runtimeRoot, Spawner: process.OSSpawner{}, Environment: os.Environ(),
		Dial: dialUnix, ReadyWithin: 10 * time.Second, ResolveUnit: testSidecarResolver(home),
	}
	first := NewHost(deps)
	started, err := first.Start("fake-unit")
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Release("fake-unit"); err != nil {
		t.Fatal(err)
	}

	second := NewHost(deps)
	if err := second.Stop("fake-unit"); err != nil {
		t.Fatalf("stopping the recorded unit: %v", err)
	}
	if err := waitUntilUnreachable(started.Address, 5*time.Second); err != nil {
		t.Fatal(err)
	}
	if err := second.Stop("fake-unit"); err != nil {
		t.Fatalf("repeated stop is not idempotent: %v", err)
	}
	if _, err := os.Stat(second.recordPath("fake-unit")); !os.IsNotExist(err) {
		t.Fatalf("owned record remains after stop: %v", err)
	}
}

func TestRecordedInventoryExposesOwnershipWithoutAdoptingOrLeakingToken(t *testing.T) {
	home := shortHome(t)
	runtimeRoot := shortHome(t)
	stageUnit(t, home, "fake-unit", fakeUnitSource)
	deps := Deps{
		Home: home, Runtime: runtimeRoot, Spawner: process.OSSpawner{}, Environment: os.Environ(),
		Dial: dialUnix, ReadyWithin: 10 * time.Second, ResolveUnit: testSidecarResolver(home),
	}
	first := NewHost(deps)
	started, err := first.Start("fake-unit")
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Release("fake-unit"); err != nil {
		t.Fatal(err)
	}

	second := NewHost(deps)
	t.Cleanup(func() { _ = second.Stop("fake-unit") })
	recorded, err := second.Recorded()
	if err != nil {
		t.Fatal(err)
	}
	if len(recorded) != 1 || recorded[0] != started {
		t.Fatalf("recorded=%+v started=%+v", recorded, started)
	}
	if len(second.Started()) != 0 {
		t.Fatal("reading recorded ownership adopted the unit")
	}
}

// A record left by a unit that has gone starts a new one rather than failing.
//
// The record is not evidence that anything is listening — a path exists both when someone is and
// when a dead unit left it behind. A connect settles it, and a connect is an event rather than a look.
func TestARecordWithNothingBehindItStartsAUnit(t *testing.T) {
	home := shortHome(t)
	runtimeRoot := shortHome(t)
	stageUnit(t, home, "fake-unit", fakeUnitSource)
	deps := Deps{
		Home: home, Runtime: runtimeRoot, Spawner: process.OSSpawner{}, Environment: os.Environ(),
		Dial: dialUnix, ReadyWithin: 10 * time.Second, ResolveUnit: testSidecarResolver(home),
	}

	first := NewHost(deps)
	started, err := first.Start("fake-unit")
	if err != nil {
		t.Fatalf("starting the unit: %v", err)
	}
	// Ended, so the record now names a process that is not there.
	if err := first.Stop("fake-unit"); err != nil {
		t.Fatalf("stopping the unit: %v", err)
	}
	if err := waitUntilUnreachable(started.Address, 5*time.Second); err != nil {
		t.Fatalf("the unit still answers after it was stopped: %v", err)
	}

	second := NewHost(deps)
	t.Cleanup(func() { second.StopAll() })
	fresh, err := second.Start("fake-unit")
	if err != nil {
		t.Fatalf("a run with a stale record could not start a unit: %v", err)
	}
	if fresh.PID == started.PID {
		t.Fatal("the stale record was adopted, so this run is talking to a process that is gone")
	}
}

// The record names the program the unit was started from. A later run whose record resolves to
// another program (the sidecar was reinstalled at another version) ends the unit it finds and
// starts the recorded one; adopting it would keep the old program serving under the new record.
func TestASecondRunReplacesAUnitWhoseRecordedProgramChanged(t *testing.T) {
	home := shortHome(t)
	runtimeRoot := shortHome(t)
	stageUnit(t, home, "fake-unit", fakeUnitSource)
	first := NewHost(Deps{
		Home: home, Runtime: runtimeRoot, Spawner: process.OSSpawner{}, Environment: os.Environ(),
		Dial: dialUnix, ReadyWithin: 10 * time.Second, ResolveUnit: testSidecarResolver(home),
	})
	started, err := first.Start("fake-unit")
	if err != nil {
		t.Fatalf("starting the unit: %v", err)
	}
	if err := first.Release("fake-unit"); err != nil {
		t.Fatalf("releasing the unit: %v", err)
	}

	reinstalled := shortHome(t)
	stageUnit(t, reinstalled, "fake-unit", fakeUnitSource)
	second := NewHost(Deps{
		Home: home, Runtime: runtimeRoot, Spawner: process.OSSpawner{}, Environment: os.Environ(),
		Dial: dialUnix, ReadyWithin: 10 * time.Second, ResolveUnit: testSidecarResolver(reinstalled),
	})
	t.Cleanup(func() { second.StopAll() })
	found, err := second.Start("fake-unit")
	if err != nil {
		t.Fatalf("the second run could not start the recorded program: %v", err)
	}
	if found.PID == started.PID {
		t.Fatalf("the second run adopted the old program (pid %d) although the record names another", started.PID)
	}
	if err := signalPID(started.PID); err == nil {
		t.Fatalf("the old program (pid %d) is still running", started.PID)
	}
}

// A record whose process has ended is not a unit. Reading the inventory forgets it, so a caller
// that refuses to act while something is recorded is not held by a run that died without stopping.
func TestRecordedInventoryForgetsARecordWhoseProcessHasEnded(t *testing.T) {
	home := shortHome(t)
	runtimeRoot := shortHome(t)
	stageUnit(t, home, "fake-unit", fakeUnitSource)
	deps := Deps{
		Home: home, Runtime: runtimeRoot, Spawner: process.OSSpawner{}, Environment: os.Environ(),
		Dial: dialUnix, ReadyWithin: 10 * time.Second, ResolveUnit: testSidecarResolver(home),
	}
	first := NewHost(deps)
	if _, err := first.Start("fake-unit"); err != nil {
		t.Fatal(err)
	}
	if err := first.Stop("fake-unit"); err != nil {
		t.Fatal(err)
	}
	// Stop removed the record with the unit. Put one back to stand for the record a run that died
	// without stopping leaves behind.
	record := filepath.Join(home, "run", "sidecar-fake-unit.json")
	if err := os.MkdirAll(filepath.Dir(record), 0o700); err != nil {
		t.Fatal(err)
	}
	body := `{"address":"` + filepath.Join(home, "run", "gone.sock") + `","protocol":2,"pid":999999,"processLabel":"soksak","secretNames":""}`
	if err := os.WriteFile(record, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	second := NewHost(deps)
	recorded, err := second.Recorded()
	if err != nil {
		t.Fatalf("reading the inventory: %v", err)
	}
	if len(recorded) != 0 {
		t.Fatalf("a record whose process has ended was reported: %+v", recorded)
	}
	if _, err := os.Stat(record); !os.IsNotExist(err) {
		t.Fatalf("the stale record survived the read: %v", err)
	}
}

func TestRecordedInventoryForgetsADeadRecordBeforeApplyingTheCurrentWireShape(t *testing.T) {
	home := shortHome(t)
	recordPath := filepath.Join(home, "run", "sidecar-old-unit.json")
	if err := os.MkdirAll(filepath.Dir(recordPath), 0o700); err != nil {
		t.Fatal(err)
	}
	// This is valid ownership JSON from protocol 1. It has a PID but predates processLabel.
	// A dead owner makes the record stale before the current wire shape matters.
	body := `{"address":"/tmp/gone-old-unit.sock","protocol":1,"pid":999999}`
	if err := os.WriteFile(recordPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	host := NewHost(Deps{Home: home})
	recorded, err := host.Recorded()
	if err != nil {
		t.Fatalf("dead old record blocked the inventory: %v", err)
	}
	if len(recorded) != 0 {
		t.Fatalf("dead old record was reported as owned: %+v", recorded)
	}
	if _, err := os.Stat(recordPath); !os.IsNotExist(err) {
		t.Fatalf("dead old record survived inventory: %v", err)
	}
}

func TestRecordedInventoryKeepsAndRefusesALiveRecordOutsideTheCurrentWireShape(t *testing.T) {
	home := shortHome(t)
	recordPath := filepath.Join(home, "run", "sidecar-live-old-unit.json")
	if err := os.MkdirAll(filepath.Dir(recordPath), 0o700); err != nil {
		t.Fatal(err)
	}
	body := `{"address":"/tmp/live-old-unit.sock","protocol":1,"pid":` + strconv.Itoa(os.Getpid()) + `}`
	if err := os.WriteFile(recordPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	host := NewHost(Deps{Home: home})
	if _, err := host.Recorded(); err == nil {
		t.Fatal("live old record was accepted as current ownership")
	}
	if _, err := os.Stat(recordPath); err != nil {
		t.Fatalf("live old record was removed: %v", err)
	}
}

// A unit this host adopted is one another run started, so nothing here observes its end. When its
// process goes the address refuses, and starting again has to begin a new one rather than answer
// with an address nobody is listening at — otherwise every caller after the first keeps getting it.
func TestStartingAgainReplacesAnAdoptedUnitNothingAnswersAt(t *testing.T) {
	home := shortHome(t)
	runtimeRoot := shortHome(t)
	stageUnit(t, home, "fake-unit", fakeUnitSource)
	deps := Deps{
		Home: home, Runtime: runtimeRoot, Spawner: process.OSSpawner{}, Environment: os.Environ(),
		Dial: dialUnix, ReadyWithin: 10 * time.Second, ResolveUnit: testSidecarResolver(home),
	}
	first := NewHost(deps)
	started, err := first.Start("fake-unit")
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Release("fake-unit"); err != nil {
		t.Fatal(err)
	}

	// A second run adopts what the first left running, as an application coming back does.
	second := NewHost(deps)
	t.Cleanup(func() { _ = second.Stop("fake-unit") })
	adopted, err := second.Start("fake-unit")
	if err != nil {
		t.Fatal(err)
	}
	if adopted.PID != started.PID {
		t.Fatalf("the running unit was not adopted: %d vs %d", adopted.PID, started.PID)
	}

	// The adopted process goes without this host being told.
	if err := syscall.Kill(-adopted.PID, syscall.SIGKILL); err != nil {
		t.Fatalf("ending the unit: %v", err)
	}
	second.awaitGone(adopted.Address)

	again, err := second.Start("fake-unit")
	if err != nil {
		t.Fatalf("starting again: %v", err)
	}
	if again.PID == adopted.PID {
		t.Fatalf("the same dead unit was answered with: pid=%d", again.PID)
	}
	conn, err := dialUnix(again.Address)
	if err != nil {
		t.Fatalf("nothing is listening at the answered address: %v", err)
	}
	_ = conn.Close()
}

// The inventory answers what is there. A held unit whose address refuses is not running, and a
// caller that refuses to act while something is running must not be held by one that has gone.
func TestStartedInventoryDropsAHeldUnitNothingAnswersAt(t *testing.T) {
	home := shortHome(t)
	runtimeRoot := shortHome(t)
	stageUnit(t, home, "fake-unit", fakeUnitSource)
	deps := Deps{
		Home: home, Runtime: runtimeRoot, Spawner: process.OSSpawner{}, Environment: os.Environ(),
		Dial: dialUnix, ReadyWithin: 10 * time.Second, ResolveUnit: testSidecarResolver(home),
	}
	first := NewHost(deps)
	started, err := first.Start("fake-unit")
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Release("fake-unit"); err != nil {
		t.Fatal(err)
	}
	second := NewHost(deps)
	t.Cleanup(func() { _ = second.Stop("fake-unit") })
	if _, err := second.Start("fake-unit"); err != nil {
		t.Fatal(err)
	}
	if len(second.Started()) != 1 {
		t.Fatalf("the adopted unit is not reported: %+v", second.Started())
	}
	if err := syscall.Kill(-started.PID, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	second.awaitGone(started.Address)
	if open := second.Started(); len(open) != 0 {
		t.Fatalf("a unit nothing answers at was reported open: %+v", open)
	}
}

// A caller granted a unit is granted the name, not one process. When the process this host held is
// gone, the next request starts the unit the settings name and is served by that one. Without this
// every caller granted the unit holds a name nothing serves.
func TestSendStartsAUnitWhoseProcessIsGone(t *testing.T) {
	home := shortHome(t)
	runtimeRoot := shortHome(t)
	stageUnit(t, home, "fake-unit", fakeUnitSource)
	deps := Deps{
		Home: home, Runtime: runtimeRoot, Spawner: process.OSSpawner{}, Environment: os.Environ(),
		Dial: dialUnix, ReadyWithin: 10 * time.Second, ResolveUnit: testSidecarResolver(home),
	}
	host := NewHost(deps)
	t.Cleanup(func() { _ = host.Stop("fake-unit") })
	started, err := host.Start("fake-unit")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := host.Send("fake-unit", controlwire.Request{ID: "one", Command: "fake-unit.echo"}); err != nil {
		t.Fatalf("first request: %v", err)
	}

	if err := syscall.Kill(-started.PID, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	host.awaitGone(started.Address)

	if _, err := host.Send("fake-unit", controlwire.Request{ID: "two", Command: "fake-unit.echo"}); err != nil {
		t.Fatalf("the request did not reach a unit: %v", err)
	}
	if open := host.Started(); len(open) != 1 || open[0].PID == started.PID {
		t.Fatalf("no new unit is serving the name: %+v", open)
	}
}
