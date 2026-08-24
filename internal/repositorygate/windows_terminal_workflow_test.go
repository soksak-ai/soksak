package repositorygate

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
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
		"node-version-file: soksak-core/.node-version",
		"package_json_file: soksak-core/frontend/package.json",
		"windows-build:", "darwin-build:", "linux-build:",
		"ubuntu-24.04-arm", "architecture: amd64", "architecture: arm64",
		"make build TARGET=x86_64-pc-windows-msvc", "make build TARGET=\"${{ matrix.target }}\"", "make compose TARGET=universal-apple-darwin",
		"core-windows-artifact", "core-darwin-artifact", "core-linux-${{ matrix.architecture }}-artifact",
	} {
		if !strings.Contains(s, required) {
			t.Errorf("multiplatform workflow omits %s", required)
		}
	}
	if !strings.Contains(s, "cache-dependency-path: soksak-core/go.sum") {
		t.Fatal("Windows Core Go cache does not follow the checked-out module")
	}
	if strings.Count(s, "soksak-core/scripts/ci/require-disk-capacity.sh") != 3 {
		t.Fatal("every native build must check capacity before installing toolchains")
	}
	for _, job := range []string{"windows-build:", "darwin-build:", "linux-build:"} {
		block := s[strings.Index(s, job):]
		next := len(block)
		for _, other := range []string{"windows-build:", "darwin-build:", "linux-build:", "windows-system:"} {
			if at := strings.Index(block[1:], other); at >= 0 && at+1 < next {
				next = at + 1
			}
		}
		block = block[:next]
		if strings.Index(block, "require-disk-capacity.sh") > strings.Index(block, "actions/setup-go@") {
			t.Fatalf("%s installs a toolchain before checking capacity", job)
		}
	}
	if !strings.Contains(s, "go tool wails3") {
		t.Fatal("Windows workflow does not use the Wails CLI owned by go.mod")
	}
	if !strings.Contains(s, "make build TARGET=x86_64-pc-windows-msvc") {
		t.Fatal("Windows workflow does not use the repository Make build entrypoint")
	}
	for _, inline := range []string{"task build GOOS=windows", "task build:sok GOOS=windows"} {
		if strings.Contains(s, inline) {
			t.Errorf("Windows workflow duplicates runner logic: %s", inline)
		}
	}
	refBody, err := os.ReadFile(".system-tests-ref")
	if err != nil {
		t.Fatal(err)
	}
	testsRef := strings.TrimSpace(string(refBody))
	if !regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(testsRef) || string(refBody) != testsRef+"\n" {
		t.Fatal("system-test owner ref must be one exact lowercase commit")
	}
	for _, platform := range []string{"windows", "darwin", "linux"} {
		if !strings.Contains(s, "min-median-max/soksak-terminal-tests/.github/workflows/"+platform+"-system.yml@"+testsRef) {
			t.Errorf("%s fleet workflow is not pinned", platform)
		}
	}
	if strings.Count(s, "tests_ref: "+testsRef) != 3 {
		t.Fatal("native fleet executions do not share one exact Acceptance commit")
	}
	for _, required := range []string{
		"artifact: core-darwin-arm64-artifact", "runner: macos-15", "architecture: arm64", "target: aarch64-apple-darwin", "variant: thin",
		"artifact: core-darwin-x86_64-artifact", "runner: macos-15-intel", "architecture: x86_64", "target: x86_64-apple-darwin",
		"artifact: core-darwin-artifact", "variant: universal",
	} {
		if !strings.Contains(s, required) {
			t.Errorf("Darwin system matrix omits %s", required)
		}
	}
	if strings.Count(s, "variant: universal") != 2 {
		t.Fatal("universal Darwin artifact is not tested on both native architectures")
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
	candidateTestsRef := "1497af685e77125749381eaca12bb9becd01671b"
	for _, required := range []string{
		"darwin-candidate-native-input:",
		"needs: darwin-build",
		"min-median-max/soksak-terminal-tests/.github/workflows/darwin-candidate-native-input.yml@" + candidateTestsRef,
		"tests_ref: " + candidateTestsRef,
		"core_artifact_name: core-darwin-arm64-artifact",
		"core_source_commit: ${{ github.sha }}",
	} {
		if !strings.Contains(s, required) {
			t.Errorf("candidate native workflow omits %s", required)
		}
	}
	for _, v := range []string{"soksak-plugin-terminal", "soksak-sidecar-terminal"} {
		if strings.Contains(s, v) {
			t.Errorf("Core workflow names provider %s", v)
		}
	}
}

func TestReleaseCapacityGateFailsBeforeWorkStarts(t *testing.T) {
	bin := t.TempDir()
	df := filepath.Join(bin, "df")
	run := func(available string) ([]byte, error) {
		body := "#!/bin/sh\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'\nprintf '/dev/test 99999999 1 " + available + " 1% /\\n'\n"
		if err := os.WriteFile(df, []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
		command := exec.Command("scripts/ci/require-disk-capacity.sh")
		command.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"))
		return command.CombinedOutput()
	}
	if output, err := run("1048575"); err == nil || !strings.Contains(string(output), "at least 10 GiB free space is required") {
		t.Fatalf("capacity gate accepted insufficient space: %v\n%s", err, output)
	}
	if output, err := run("10485760"); err != nil || !strings.Contains(string(output), "disk capacity:") {
		t.Fatalf("capacity gate rejected sufficient space: %v\n%s", err, output)
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
