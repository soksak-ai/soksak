package repositorygate

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"golang.org/x/mod/modfile"
)

const wailsToolPath = "github.com/wailsapp/wails/v3/cmd/wails3"

func TestBuildToolchainVersionsHaveDeclaredOwners(t *testing.T) {
	manifest, err := os.ReadFile("frontend/package.json")
	if err != nil {
		t.Fatal(err)
	}
	var frontend struct {
		Engines struct {
			Node string `json:"node"`
		} `json:"engines"`
		PackageManager string `json:"packageManager"`
	}
	if err := json.Unmarshal(manifest, &frontend); err != nil {
		t.Fatal(err)
	}
	selection, err := os.ReadFile(".node-version")
	if err != nil {
		t.Errorf("reading the Node environment selector: %v", err)
	} else {
		if selected := strings.TrimSpace(string(selection)); selected == "" || selected != frontend.Engines.Node {
			t.Errorf("Node selector %q does not match frontend engine %q", selected, frontend.Engines.Node)
		}
	}
	if manager, version, found := strings.Cut(frontend.PackageManager, "@"); !found || manager != "pnpm" || version == "" {
		t.Errorf("frontend package manager is not an exact pnpm declaration: %q", frontend.PackageManager)
	}

	goMod, err := os.ReadFile("go.mod")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := modfile.Parse("go.mod", goMod, nil)
	if err != nil {
		t.Fatal(err)
	}
	wailsRequired := false
	for _, requirement := range parsed.Require {
		if requirement.Mod.Path == "github.com/wailsapp/wails/v3" && requirement.Mod.Version != "" {
			wailsRequired = true
		}
	}
	wailsRegistered := false
	for _, tool := range parsed.Tool {
		if tool.Path == wailsToolPath {
			wailsRegistered = true
		}
	}
	if !wailsRequired || !wailsRegistered {
		t.Errorf("go.mod must own both the Wails module and %s tool: required=%t tool=%t", wailsToolPath, wailsRequired, wailsRegistered)
	}
}

func TestBuildCommandsUseTheModuleOwnedWailsRunner(t *testing.T) {
	paths := []string{
		"Taskfile.yml",
		"build/Taskfile.yml",
		"build/config.yml",
		"build/darwin/Taskfile.yml",
		"build/docker/Dockerfile.windows-ci",
		"build/linux/Taskfile.yml",
		"build/windows/Taskfile.yml",
		"scripts/ci/windows-build.sh",
		"scripts/ci/windows-docker.sh",
		".github/workflows/multiplatform-system.yml",
	}
	ownedCalls := 0
	for _, path := range paths {
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		text := string(body)
		ownedCalls += strings.Count(text, "go tool wails3")
		for _, forbidden := range []string{"WAILS3", "cmd/wails3@v", `\"wails3\"`} {
			if strings.Contains(text, forbidden) {
				t.Errorf("%s contains ambient or independently versioned Wails path %q", path, forbidden)
			}
		}
	}
	if ownedCalls == 0 {
		t.Fatal("build commands do not invoke the module-owned Wails tool")
	}
	if _, err := os.Stat(".task-version"); !os.IsNotExist(err) {
		t.Errorf(".task-version exists even though Wails owns the active Task runner: %v", err)
	}
	taskfile, err := os.ReadFile("Taskfile.yml")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(taskfile), "task --version") {
		t.Fatal("verify checks an ambient Task binary instead of its Wails-owned runner")
	}
}

func TestBuildEnvironmentsSelectNodeFromTheRootDeclaration(t *testing.T) {
	for _, path := range []string{
		".github/workflows/multiplatform-system.yml",
		"scripts/ci/frontend-build.sh",
		"scripts/ci/windows-build.sh",
		"scripts/ci/windows-docker.sh",
	} {
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(body), ".node-version") {
			t.Errorf("%s does not select Node from .node-version", path)
		}
	}
	check, err := os.ReadFile("scripts/ci/check-frontend-toolchain.sh")
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{"$root/.node-version", "node_declared", `"$node_expected" != "$node_declared"`} {
		if !strings.Contains(string(check), required) {
			t.Errorf("frontend preflight does not enforce Node selector projection through %q", required)
		}
	}
}

func TestFrontendBuildResolvesPnpmFromTheFrontendPackage(t *testing.T) {
	body, err := os.ReadFile("scripts/ci/frontend-build.sh")
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	for _, required := range []string{
		`pnpm_actual=$(cd "$root/frontend" && pnpm --version`,
		`cd "$root/frontend"`,
		`pnpm "$@" install --frozen-lockfile`,
		`pnpm "$@" typecheck`,
		`pnpm "$@" build`,
	} {
		if !strings.Contains(text, required) {
			t.Errorf("frontend build does not resolve its owner through %q", required)
		}
	}
	if strings.Contains(text, `pnpm --dir "$root/frontend"`) {
		t.Fatal("frontend build starts pnpm outside the package that owns its version")
	}
}
