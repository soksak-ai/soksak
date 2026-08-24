package repositorygate

import (
	"os"
	"strings"
	"testing"
)

func TestVerifyRejectsAnInvalidFrontendToolchainBeforeProductTests(t *testing.T) {
	taskfile, err := os.ReadFile("Taskfile.yml")
	if err != nil {
		t.Fatal(err)
	}
	text := string(taskfile)
	preflight := "scripts/ci/require-frontend-toolchain.sh"
	preflightAt := strings.Index(text, preflight)
	goAt := strings.Index(text, "task: verify:go")
	if preflightAt < 0 {
		t.Fatalf("verify does not run %s", preflight)
	}
	if goAt < 0 || preflightAt > goAt {
		t.Fatal("frontend toolchain preflight must run before product tests")
	}

	body, err := os.ReadFile(preflight)
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
		"pnpm install --frozen-lockfile",
		"exit 78",
	} {
		if !strings.Contains(script, required) {
			t.Errorf("frontend toolchain preflight is missing %q", required)
		}
	}
}
