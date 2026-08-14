package main

import (
	"os"
	"os/exec"
	"testing"

	"github.com/creack/pty"
)

func testTerminalSession(t *testing.T) *terminalSession {
	t.Helper()
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatalf("create test terminal pipe: %v", err)
	}
	t.Cleanup(func() {
		_ = reader.Close()
		_ = writer.Close()
	})
	return &terminalSession{pty: writer}
}

func TestTerminalSessionIdentity(t *testing.T) {
	service := newTerminalService(nil)

	first := service.install("terminal-1", testTerminalSession(t))
	second := service.install("terminal-1", testTerminalSession(t))
	if first.Generation == second.Generation {
		t.Fatal("replacement terminal session must have a fresh generation")
	}

	if err := service.Close(first.ID, first.Generation); err != nil {
		t.Fatalf("stale close must be an idempotent no-op: %v", err)
	}
	current, err := service.session(second.ID, second.Generation)
	if err != nil || current == nil {
		t.Fatalf("stale close must not remove the replacement session: %v", err)
	}

	if err := service.Close(second.ID, second.Generation); err != nil {
		t.Fatalf("current close must succeed: %v", err)
	}
	if _, err := service.session(second.ID, second.Generation); err == nil {
		t.Fatal("closed current generation must no longer be addressable")
	}
}

func TestCloseTerminalSessionReapsItsProcess(t *testing.T) {
	cmd := exec.Command("/bin/sh", "-c", "sleep 60")
	file, err := pty.Start(cmd)
	if err != nil {
		t.Fatalf("start terminal process: %v", err)
	}
	t.Cleanup(func() {
		if cmd.ProcessState == nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	})

	closeTerminalSession(&terminalSession{pty: file, cmd: cmd})
	if cmd.ProcessState == nil || !cmd.ProcessState.Exited() {
		t.Fatalf("close must synchronously reap the PTY process: %+v", cmd.ProcessState)
	}
}
