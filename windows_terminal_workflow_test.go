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
	for _, required := range []string{
		"actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
		"actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e",
		"actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
		"pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86",
		"actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
		"node-version: \"24.19.0\"",
	} {
		if !strings.Contains(s, required) {
			t.Errorf("Windows workflow does not pin Node 24 toolchain input %s", required)
		}
	}
	if !strings.Contains(s, "cache-dependency-path: soksak-core/go.sum") {
		t.Fatal("Windows Core Go cache does not follow the checked-out module")
	}
	if !strings.Contains(s, "go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.12") {
		t.Fatal("Windows workflow does not install the exact upstream Wails CLI")
	}
	const testsRef = "d6cb93701604d9cb37e082b27c134bc883605b96"
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
	for _, forbidden := range []string{"soksak-ai/wails", "frameworks/wails3"} {
		if strings.Contains(s, forbidden) {
			t.Errorf("Windows workflow depends on a Wails source checkout: %s", forbidden)
		}
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

func TestWebviewFrameRepairIsNotAPlatformContract(t *testing.T) {
	contract, err := os.ReadFile("frameworks/wails/window_host.go")
	if err != nil {
		t.Fatal(err)
	}
	boot, err := os.ReadFile("frameworks/wails/host.go")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(contract), "FitWebview(") || strings.Contains(string(boot), "FitWebview(") {
		t.Fatal("macOS webview frame repair is still a platform-wide boot contract")
	}
	darwin, err := os.ReadFile("frameworks/wails/window_fit_darwin.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(darwin), "repairDocumentView") || !strings.Contains(string(darwin), "fitWebviewToWindow") {
		t.Fatal("macOS frame repair was removed instead of scoped to macOS")
	}
}

func TestFrontendPinsNode24(t *testing.T) {
	manifest, err := os.ReadFile("frontend/package.json")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(manifest), `"node": "24.19.0"`) {
		t.Fatal("frontend does not pin Node 24.19.0")
	}
	if !strings.Contains(string(manifest), `"onlyBuiltDependencies": [`) || !strings.Contains(string(manifest), `"esbuild"`) {
		t.Fatal("frontend does not explicitly allow the esbuild install script")
	}
	version, err := os.ReadFile(".nvmrc")
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(version)) != "24.19.0" {
		t.Fatalf(".nvmrc = %q", version)
	}
}

func TestWindowsCanRevealWithoutTakingFocus(t *testing.T) {
	body, err := os.ReadFile("frameworks/wails/window_native_windows.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(body)
	for _, required := range []string{"SetWindowPos", "SWP_NOACTIVATE", "SWP_SHOWWINDOW", "IsWindowVisible"} {
		if !strings.Contains(source, required) {
			t.Errorf("Windows focus-free reveal is missing %s", required)
		}
	}
}
