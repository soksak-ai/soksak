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
	const wailsRef = "245331aa500541d44f52d78c9d2dc9beb405d526"
	if !strings.Contains(s, "repository: soksak-ai/wails, ref: "+wailsRef) {
		t.Fatal("Windows workflow is not pinned to the version-aligned Wails source")
	}
	const testsRef = "405d2e4ed3fb0228919aa2138ff9b3386e93199b"
	if !strings.Contains(s, "min-median-max/soksak-terminal-tests/.github/workflows/windows-system.yml@"+testsRef) {
		t.Fatal("Windows fleet workflow is not pinned")
	}
	if !strings.Contains(s, "tests_ref: "+testsRef) {
		t.Fatal("Windows fleet execution is not pinned")
	}
	if !strings.Contains(s, "$ErrorActionPreference = 'Stop'") {
		t.Fatal("Windows build failures do not stop artifact publication")
	}
	if !strings.Contains(s, "$PSNativeCommandUseErrorActionPreference = $true") {
		t.Fatal("Windows native command failures do not stop artifact publication")
	}
	if !strings.Contains(s, "go build -C frameworks/wails3/v3 -trimpath") {
		t.Fatal("source-built Wails CLI does not retain its embedded release identity")
	}
	if !strings.Contains(s, "Test-Path $artifact") {
		t.Fatal("Windows workflow does not verify built artifact paths")
	}
	for _, artifact := range []string{"soksak-core/bin/soksak.exe", "soksak-core/bin/sok.exe"} {
		if !strings.Contains(s, artifact) {
			t.Errorf("Windows workflow does not require artifact %s", artifact)
		}
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
