package main

import (
	"os"
	"os/exec"
	"testing"
)

func TestThisProcessIsAlive(t *testing.T) {
	if !pidAlive(os.Getpid()) {
		t.Fatal("this process reported itself dead")
	}
}

func TestAReapedProcessIsNotAlive(t *testing.T) {
	// A pid that was never used would prove nothing: the answer must change
	// when a process this test watched actually ends.
	command := exec.Command("go", "version")
	if err := command.Start(); err != nil {
		t.Skipf("could not start a child: %v", err)
	}
	pid := command.Process.Pid
	if err := command.Wait(); err != nil {
		t.Fatalf("child: %v", err)
	}
	if pidAlive(pid) {
		t.Errorf("pid %d reported alive after it exited and was reaped", pid)
	}
}

func TestAnImpossiblePidIsNotAlive(t *testing.T) {
	// Zero and negative are process-group selectors to kill(2), not processes.
	// Answering "alive" for them would make a group signal look like a liveness
	// check that passed.
	for _, pid := range []int{0, -1, -12345} {
		if pidAlive(pid) {
			t.Errorf("pid %d reported alive", pid)
		}
	}
}
