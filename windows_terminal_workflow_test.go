package main

import (
	"os"
	"strings"
	"testing"
)

func TestWindowsTerminalWorkflowDelegatesFleetOwnership(t *testing.T) {
	b, e := os.ReadFile(".github/workflows/windows-terminal-system.yml")
	if e != nil {
		t.Fatal(e)
	}
	s := string(b)
	if !strings.Contains(s, "min-median-max/soksak-terminal-tests/.github/workflows/windows-system.yml@4521c688ef4a33b732c7cff6ff4ee76e90b9c72c") {
		t.Fatal("Windows fleet workflow is not pinned")
	}
	if !strings.Contains(s, "Cross-owner reusable workflows must be public") {
		t.Fatal("Windows workflow does not state its public fleet-workflow boundary")
	}
	for _, v := range []string{"soksak-plugin-terminal", "soksak-sidecar-terminal"} {
		if strings.Contains(s, v) {
			t.Errorf("Core workflow names provider %s", v)
		}
	}
}
