package main

import "testing"

func TestHelpRequestsOneDiscoverableCommandDocument(t *testing.T) {
	request, err := requestFrom([]string{"help", "window.snapshot"})
	if err != nil {
		t.Fatalf("parse help: %v", err)
	}
	if request.Command != "command.docs" {
		t.Fatalf("help command = %q, want command.docs", request.Command)
	}
	if got := string(request.Args["name"]); got != `"window.snapshot"` {
		t.Fatalf("help name = %s, want window.snapshot", got)
	}
	if got := string(request.Args["window"]); got != `"main"` {
		t.Fatalf("help window = %s, want the control plane", got)
	}
}

func TestHelpRequiresExactlyOneCommandName(t *testing.T) {
	for _, argv := range [][]string{{"help"}, {"help", "window.snapshot", "extra"}} {
		if _, err := requestFrom(argv); err == nil {
			t.Fatalf("requestFrom(%v) accepted an ambiguous help request", argv)
		}
	}
}
