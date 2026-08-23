package repositorygate

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

func TestBuildTasksUseThePublishedWailsCLIFromPath(t *testing.T) {
	const declaration = `WAILS3: '{{.WAILS3 | default "wails3"}}'`
	for _, path := range []string{"Taskfile.yml", "build/Taskfile.yml"} {
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(body), declaration) {
			t.Errorf("%s does not resolve the published Wails CLI from PATH", path)
		}
	}
}

func TestFrontendInstallsThePublishedWailsRuntime(t *testing.T) {
	body, err := os.ReadFile("build/Taskfile.yml")
	if err != nil {
		t.Fatal(err)
	}
	source := string(body)
	for _, required := range []string{
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
	if !strings.Contains(string(manifest), `"@wailsio/runtime": "3.0.0-beta.12"`) {
		t.Fatal("frontend does not pin the published Wails runtime")
	}
	for _, forbidden := range []string{`"@wailsio/runtime": "file:`, `"@wailsio/runtime": "github:`} {
		if strings.Contains(string(manifest), forbidden) {
			t.Fatalf("frontend runtime uses a source checkout: %s", forbidden)
		}
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
