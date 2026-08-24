package repositorygate

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestVerifyRejectsAnInvalidFrontendToolchainBeforeProductTests(t *testing.T) {
	taskfile, err := os.ReadFile("Taskfile.yml")
	if err != nil {
		t.Fatal(err)
	}
	text := string(taskfile)
	prepare := "scripts/ci/prepare-frontend-dependencies.sh"
	check := "scripts/ci/check-frontend-toolchain.sh"
	prepareAt := strings.Index(text, prepare)
	checkAt := strings.Index(text, check)
	goAt := strings.Index(text, "task: verify:go")
	if prepareAt < 0 || checkAt < 0 {
		t.Fatalf("verify does not run prepare and check: %d, %d", prepareAt, checkAt)
	}
	if goAt < 0 || prepareAt > checkAt || checkAt > goAt {
		t.Fatal("frontend prepare and read-only check must run in order before product tests")
	}

	body, err := os.ReadFile(check)
	if err != nil {
		t.Fatal(err)
	}
	script := string(body)
	for _, required := range []string{
		"frontend/package.json",
		"node --version",
		"pnpm --version",
		"process.platform",
		"process.arch",
		"uname -m",
		"TOOLCHAIN_MISMATCH",
		"DEPENDENCY_STATE_INVALID",
		"lockSHA256",
		"exit 78",
	} {
		if !strings.Contains(script, required) {
			t.Errorf("frontend toolchain preflight is missing %q", required)
		}
	}
	if strings.Contains(script, "pnpm install") {
		t.Fatal("read-only frontend check mutates dependency state")
	}

	body, err = os.ReadFile(prepare)
	if err != nil {
		t.Fatal(err)
	}
	materialize := string(body)
	for _, required := range []string{"pnpm install --frozen-lockfile", "frontend-dependencies-owner", "--locked"} {
		if !strings.Contains(materialize, required) {
			t.Errorf("frontend dependency prepare is missing %q", required)
		}
	}
}

func TestFrontendToolchainCheckReadsPnpmFromItsOwningPackage(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the frontend preflight is a POSIX shell command")
	}
	platform := runtime.GOOS
	arch := runtime.GOARCH
	if arch == "amd64" {
		arch = "x64"
	}
	manifest, err := os.ReadFile("frontend/package.json")
	if err != nil {
		t.Fatal(err)
	}
	var declared struct {
		Engines struct {
			Node string `json:"node"`
		} `json:"engines"`
		PackageManager string `json:"packageManager"`
	}
	if err := json.Unmarshal(manifest, &declared); err != nil {
		t.Fatal(err)
	}
	pnpmVersion, found := strings.CutPrefix(declared.PackageManager, "pnpm@")
	if declared.Engines.Node == "" || !found || pnpmVersion == "" {
		t.Fatalf("frontend toolchain declaration is incomplete: %#v", declared)
	}
	bin := t.TempDir()
	node := `#!/bin/sh
case "$1" in
  --version) echo v` + declared.Engines.Node + ` ;;
  -p)
    case "$2" in
      process.platform) echo ` + platform + ` ;;
      process.arch) echo ` + arch + ` ;;
      *) exit 1 ;;
    esac ;;
  -e) printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ;;
  *) exit 1 ;;
esac
`
	pnpm := `#!/bin/sh
case "$PWD" in
  */frontend) echo ` + pnpmVersion + ` ;;
  *) echo wrong-package-manager ;;
esac
`
	for name, body := range map[string]string{
		"node": node, "pnpm": pnpm, "sysctl": "#!/bin/sh\nexit 1\n",
	} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	command := exec.Command("sh", "scripts/ci/check-frontend-toolchain.sh", "--toolchain-only")
	command.Env = append(os.Environ(), "PATH="+bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("frontend-owned pnpm was rejected: %v\n%s", err, output)
	}
	if !strings.Contains(string(output), "pnpm="+pnpmVersion) {
		t.Fatalf("frontend-owned pnpm was not reported: %s", output)
	}
}

func TestFrontendToolchainUsesPhysicalAppleSiliconUnderTranslation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the frontend preflight is a POSIX shell command")
	}
	manifest, err := os.ReadFile("frontend/package.json")
	if err != nil {
		t.Fatal(err)
	}
	var declared struct {
		Engines struct {
			Node string `json:"node"`
		} `json:"engines"`
		PackageManager string `json:"packageManager"`
	}
	if err := json.Unmarshal(manifest, &declared); err != nil {
		t.Fatal(err)
	}
	pnpmVersion, found := strings.CutPrefix(declared.PackageManager, "pnpm@")
	if declared.Engines.Node == "" || !found || pnpmVersion == "" {
		t.Fatalf("frontend toolchain declaration is incomplete: %#v", declared)
	}
	bin := t.TempDir()
	commands := map[string]string{
		"uname": `#!/bin/sh
case "$1" in
  -s) echo Darwin ;;
  -m) echo x86_64 ;;
  *) exit 1 ;;
esac
`,
		"sysctl": `#!/bin/sh
test "$1" = -n && test "$2" = hw.optional.arm64 && echo 1
`,
		"node": `#!/bin/sh
case "$1" in
  --version) echo v` + declared.Engines.Node + ` ;;
  -p)
    case "$2" in
      process.platform) echo darwin ;;
      process.arch) echo arm64 ;;
      *) exit 1 ;;
    esac ;;
  -e) printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ;;
  *) exit 1 ;;
esac
`,
		"pnpm": `#!/bin/sh
case "$PWD" in
  */frontend) echo ` + pnpmVersion + ` ;;
  *) echo wrong-package-manager ;;
esac
`,
	}
	for name, body := range commands {
		if err := os.WriteFile(filepath.Join(bin, name), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	command := exec.Command("sh", "scripts/ci/check-frontend-toolchain.sh", "--toolchain-only")
	command.Env = append(os.Environ(), "PATH="+bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("physical Apple Silicon was replaced by the translated process architecture: %v\n%s", err, output)
	}
	if !strings.Contains(string(output), "runtime=darwin/arm64") {
		t.Fatalf("physical Apple Silicon architecture was not reported: %s", output)
	}
}
