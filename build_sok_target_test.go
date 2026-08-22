package main

import (
	"os"
	"strings"
	"testing"
)

func TestControlClientUsesTheApplicationTarget(t *testing.T) {
	body, err := os.ReadFile("Taskfile.yml")
	if err != nil {
		t.Fatal(err)
	}
	block := taskBlock(t, string(body), "build:sok")
	if !strings.Contains(block, "task: '{{.GOOS}}:build:sok'") {
		t.Error("build:sok does not delegate target selection to the platform task")
	}

	checks := map[string][]string{
		"build/darwin/Taskfile.yml":  {"GOOS: darwin", "GOARCH: '{{.TARGET_ARCH}}'", "sysctl -n hw.optional.arm64"},
		"build/linux/Taskfile.yml":   {"GOOS: linux", "GOARCH: '{{.ARCH | default ARCH}}'"},
		"build/windows/Taskfile.yml": {"GOOS: windows", "GOARCH: '{{.ARCH | default ARCH}}'", "CGO_ENABLED: 0"},
	}
	for path, declarations := range checks {
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		block := taskBlock(t, string(body), "build:sok")
		for _, declaration := range declarations {
			if !strings.Contains(block, declaration) {
				t.Errorf("%s build:sok does not declare %s", path, declaration)
			}
		}
	}
}

func TestPinnedWailsCLIUsesTheHostExecutableName(t *testing.T) {
	const executable = `ternary "wails3.exe" "wails3" (eq OS "windows")`
	for _, path := range []string{"Taskfile.yml", "build/Taskfile.yml"} {
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(body), executable) {
			t.Errorf("%s does not select the pinned CLI executable for the host", path)
		}
	}
}

func TestFrontendInstallBuildsAndCopiesThePinnedWailsRuntime(t *testing.T) {
	body, err := os.ReadFile("build/Taskfile.yml")
	if err != nil {
		t.Fatal(err)
	}
	source := string(body)
	for _, required := range []string{
		"prepare:wails:runtime:",
		"npm ci",
		"npm run build:code",
		"task: prepare:wails:runtime",
		"pnpm --config.node-linker=hoisted --config.symlink=false install --frozen-lockfile",
	} {
		if !strings.Contains(source, required) {
			t.Errorf("frontend dependency preparation is missing %s", required)
		}
	}
	manifest, err := os.ReadFile("frontend/package.json")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(manifest), `"@wailsio/runtime": "file:../../frameworks/wails3/v3/internal/runtime/desktop/@wailsio/runtime"`) {
		t.Fatal("frontend does not consume the exact Wails runtime source")
	}
}

func taskBlock(t *testing.T, source, name string) string {
	t.Helper()
	lines := strings.Split(source, "\n")
	heading := "  " + name + ":"
	start := -1
	for index, line := range lines {
		if line == heading {
			start = index + 1
			break
		}
	}
	if start < 0 {
		t.Fatalf("task %s is missing", name)
	}
	end := len(lines)
	for index := start; index < len(lines); index++ {
		line := lines[index]
		if strings.HasPrefix(line, "  ") && !strings.HasPrefix(line, "    ") && strings.HasSuffix(line, ":") {
			end = index
			break
		}
	}
	return strings.Join(lines[start:end], "\n")
}
