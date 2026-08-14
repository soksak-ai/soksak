package main

import "testing"

func TestTerminalSessionIdentity(t *testing.T) {
	service := newTerminalService(nil)

	first := service.install("terminal-1", &terminalSession{})
	second := service.install("terminal-1", &terminalSession{})
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
