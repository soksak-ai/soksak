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
