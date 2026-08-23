package repositorygate

import (
	"encoding/json"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"testing"
)

func TestMultiplatformWorkflowBuildsAndDelegatesEveryNativeTarget(t *testing.T) {
	b, e := os.ReadFile(".github/workflows/multiplatform-system.yml")
	if e != nil {
		t.Fatal(e)
	}
	s := string(b)
	for _, forbidden := range []string{
		"soksak-" + "contracts/",
		"repository: soksak-ai/soksak-" + "contract-",
		"REPLACE_" + "MOUNTS",
	} {
		if strings.Contains(s, forbidden) {
			t.Fatalf("multiplatform workflow discovers a dependency checkout through %q", forbidden)
		}
	}
	for _, required := range []string{
		"actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
		"actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e",
		"actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
		"pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86",
		"actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
		"node-version-file: soksak-core/frontend/package.json",
		"package_json_file: soksak-core/frontend/package.json",
		"windows-build:", "darwin-build:", "linux-build:",
		"ubuntu-24.04-arm", "architecture: amd64", "architecture: arm64",
		"scripts/ci/windows-build.sh all", "scripts/ci/darwin-release.sh", "scripts/ci/linux-release.sh ${{ matrix.architecture }}",
		"core-windows-artifact", "core-darwin-artifact", "core-linux-${{ matrix.architecture }}-artifact",
	} {
		if !strings.Contains(s, required) {
			t.Errorf("multiplatform workflow omits %s", required)
		}
	}
	if !strings.Contains(s, "cache-dependency-path: soksak-core/go.sum") {
		t.Fatal("Windows Core Go cache does not follow the checked-out module")
	}
	if !strings.Contains(s, "go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.12") {
		t.Fatal("Windows workflow does not install the exact upstream Wails CLI")
	}
	if !strings.Contains(s, "scripts/ci/windows-build.sh all") {
		t.Fatal("Windows workflow does not use the repository build runner")
	}
	for _, inline := range []string{"task build GOOS=windows", "task build:sok GOOS=windows"} {
		if strings.Contains(s, inline) {
			t.Errorf("Windows workflow duplicates runner logic: %s", inline)
		}
	}
	const testsRef = "b60de2bb87a6b82259144e607f90e3886753585b"
	for _, platform := range []string{"windows", "darwin", "linux"} {
		if !strings.Contains(s, "min-median-max/soksak-terminal-tests/.github/workflows/"+platform+"-system.yml@"+testsRef) {
			t.Errorf("%s fleet workflow is not pinned", platform)
		}
	}
	if strings.Count(s, "tests_ref: "+testsRef) != 3 {
		t.Fatal("native fleet executions do not share one exact Acceptance commit")
	}
	for _, forbidden := range []string{"soksak-ai/wails", "frameworks/wails3"} {
		if strings.Contains(s, forbidden) {
			t.Errorf("Windows workflow depends on a Wails source checkout: %s", forbidden)
		}
	}
	for _, artifact := range []string{"soksak-core/bin/soksak.exe", "soksak-core/bin/sok.exe"} {
		if !strings.Contains(s, artifact) {
			t.Errorf("Windows workflow does not require artifact %s", artifact)
		}
	}
	for _, job := range []string{"windows-system:", "darwin-system:", "linux-system:"} {
		if !strings.Contains(s, job) {
			t.Errorf("missing native system job %s", job)
		}
	}
	for _, v := range []string{"soksak-plugin-terminal", "soksak-sidecar-terminal"} {
		if strings.Contains(s, v) {
			t.Errorf("Core workflow names provider %s", v)
		}
	}
}

func TestEveryWorkflowRunnerIsExecutable(t *testing.T) {
	output, err := exec.Command("git", "ls-files", "-s", "scripts/ci/*.sh").Output()
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		if line != "" && !strings.HasPrefix(line, "100755 ") {
			t.Errorf("workflow runner is not executable: %s", line)
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

func TestFrontendOwnsExactToolchainVersions(t *testing.T) {
	manifest, err := os.ReadFile("frontend/package.json")
	if err != nil {
		t.Fatal(err)
	}
	var owner struct {
		Engines struct {
			Node string `json:"node"`
		} `json:"engines"`
		PackageManager string `json:"packageManager"`
	}
	if err := json.Unmarshal(manifest, &owner); err != nil {
		t.Fatal(err)
	}
	exact := regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)
	if !exact.MatchString(owner.Engines.Node) || !strings.HasPrefix(owner.PackageManager, "pnpm@") || !exact.MatchString(strings.TrimPrefix(owner.PackageManager, "pnpm@")) {
		t.Fatal("frontend toolchain owner files are not exact")
	}
	workspace, err := os.ReadFile("frontend/pnpm-workspace.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(workspace), "allowBuilds:") || !strings.Contains(string(workspace), "esbuild: true") {
		t.Fatal("frontend does not explicitly allow the esbuild install script")
	}
	if _, err := os.Stat(".nvmrc"); !os.IsNotExist(err) {
		t.Fatal("frontend Node version is duplicated in .nvmrc")
	}
}

func TestDarwinVerificationUsesTheProductDeploymentTarget(t *testing.T) {
	root, err := os.ReadFile("Taskfile.yml")
	if err != nil {
		t.Fatal(err)
	}
	darwin, err := os.ReadFile("build/darwin/Taskfile.yml")
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"CGO_CFLAGS", "CGO_LDFLAGS", "MACOSX_DEPLOYMENT_TARGET"} {
		if !strings.Contains(string(root), value) || !strings.Contains(string(darwin), value) {
			t.Fatalf("Darwin verification and product build do not both declare %s", value)
		}
	}
	if !strings.Contains(string(root), "10.15") || !strings.Contains(string(darwin), "10.15") {
		t.Fatal("Darwin verification and product build do not share macOS 10.15")
	}
}

func TestCorePinsTheWindowsSidecarSpec(t *testing.T) {
	selectionBody, err := os.ReadFile("build/soksak-spec.json")
	if err != nil {
		t.Fatal(err)
	}
	var selection struct{ Commit string }
	if err := json.Unmarshal(selectionBody, &selection); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile("go.mod")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), selection.Commit[:12]) {
		t.Fatal("Core and acceptance do not share the Windows sidecar manifest parser")
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

func TestWindowsReportsNativeContentSize(t *testing.T) {
	body, err := os.ReadFile("frameworks/wails/window_native_windows.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(body)
	for _, required := range []string{"GetClientRect", "GetDpiForWindow", "contentSizeFromClientRect"} {
		if !strings.Contains(source, required) {
			t.Errorf("Windows content size is missing %s", required)
		}
	}
	if strings.Contains(source, "return 0, 0, ErrContentSizeUnsupported") {
		t.Fatal("Windows still reports content size as unsupported")
	}
}
