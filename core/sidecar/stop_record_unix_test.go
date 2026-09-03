//go:build !windows

package sidecar

import (
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"
)

// Stop keeps the record when end fails, because the process is still running.
//
// A later application run reads the record to find a unit it did not start. Removing the record
// while the process runs makes the unit unreachable: adopt reads no record, Started returns
// nothing, and the next Start creates a second process for the same unit name.
//
// Measured 2026-09-03: soksak-sidecar-terminal-alacritty 0.0.38 ran for 17 minutes with no record
// under <home>/run while environment.json selected 0.0.47. sidecar.status returned one unit; two
// were running. A terminal view failed to open and reported "unknown surface command".
//
// This unit is adopted, so it has no child handle, which is the shape of a unit left by a previous
// run. Stop signals the pid and waits for exit. The process ignores the signal, the wait ends at
// its deadline, and the process is running when Stop returns.
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
