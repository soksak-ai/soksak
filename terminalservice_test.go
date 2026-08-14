package main

import "testing"

func TestTerminalSessionIdentity(t *testing.T) {
	service := newTerminalService(nil)
	service.sessions["terminal-1"] = &terminalSession{}

	if err := service.reserve("terminal-1"); err == nil {
		t.Fatal("duplicate terminal session must be rejected")
	}
	if err := service.reserve("terminal-2"); err != nil {
		t.Fatalf("fresh terminal session must be accepted: %v", err)
	}
	service.release("terminal-2")
	if err := service.reserve("terminal-2"); err != nil {
		t.Fatalf("released terminal identity must be reusable: %v", err)
	}
}
