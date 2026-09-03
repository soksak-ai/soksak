//go:build !windows

package sidecar

import (
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"
)

// A stop that fails leaves the record, because the process it names is still there.
//
// The record is how a later run finds a unit it did not start. Removing it while the process
// survives produces a unit nothing can reach: adopt reads no record, Started reports nothing, and
// the next Start opens a second process against the same socket name. What the user sees is a
// terminal that will not attach, with the application reporting every sidecar healthy.
//
// Measured 2026-09-03: soksak-sidecar-terminal-alacritty 0.0.38 ran for seventeen minutes with no
// record in <home>/run, invisible to sidecar.status, while environment.json selected 0.0.47. Vision
// stopped at attaching-live-stream and the only symptom was "unknown surface command".
//
// The unit here is adopted (no child handle), which is what a unit from a previous application run
// is. Stop signals its pid and waits; the process ignores the signal, so the wait times out and the
// process is still running when Stop returns.
func TestAFailedStopKeepsTheRecordThatNamesTheLiveProcess(t *testing.T) {
	home := shortHome(t)
	host := NewHost(Deps{Home: home, ReadyWithin: 200 * time.Millisecond})

	survivor := exec.Command("/bin/sh", "-c", `trap "" TERM; sleep 30`)
	if err := survivor.Start(); err != nil {
		t.Fatalf("starting the survivor: %v", err)
	}
	t.Cleanup(func() {
		_ = survivor.Process.Kill()
		_, _ = survivor.Process.Wait()
	})

	open := Open{Name: "fake-unit", Address: "/nonexistent.sock", PID: survivor.Process.Pid, Version: "0.0.1"}
	host.remember("fake-unit", open, "token", "", "0.0.1", "/nonexistent/dist/fake-unit")
	host.mu.Lock()
	host.open["fake-unit"] = &unit{open: open, stderr: newRing(1), path: "/nonexistent/dist/fake-unit"}
	host.mu.Unlock()

	if err := host.Stop("fake-unit"); err == nil {
		t.Fatal("Stop reported success while the process is still running")
	}
	if err := survivor.Process.Signal(syscall.Signal(0)); err != nil {
		t.Fatalf("the survivor is gone; this test no longer reproduces a failed stop: %v", err)
	}
	if _, err := os.Stat(host.recordPath("fake-unit")); err != nil {
		t.Fatalf("the record was removed while the process survives: %v", err)
	}
}
