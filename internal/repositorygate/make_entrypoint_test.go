package repositorygate

import (
	"os"
	"strings"
	"testing"
)

func TestMakeOwnsLocalAndNativeBuildEntrypoints(t *testing.T) {
	body, err := os.ReadFile("Makefile")
	if err != nil {
		t.Fatal(err)
	}
	source := string(body)
	for _, target := range []string{"preflight:", "prepare:", "verify:", "build:", "compose:"} {
		if !strings.Contains(source, target) {
			t.Errorf("Makefile omits %s", target)
		}
	}
	for _, target := range []string{
		"aarch64-apple-darwin", "x86_64-apple-darwin", "universal-apple-darwin",
		"aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu", "x86_64-pc-windows-msvc",
	} {
		if !strings.Contains(source, target) {
			t.Errorf("Makefile omits native target %s", target)
		}
	}
	for _, duplicate := range []string{"NODE_VERSION :=", "PNPM_VERSION :=", "GO_VERSION :=", "WAILS_VERSION :="} {
		if strings.Contains(source, duplicate) {
			t.Errorf("Makefile duplicates declarative metadata: %s", duplicate)
		}
	}
	workflow, err := os.ReadFile(".github/workflows/multiplatform-system.yml")
	if err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{
		"make build TARGET=x86_64-pc-windows-msvc",
		"make build TARGET=\"${{ matrix.target }}\"",
		"make compose TARGET=universal-apple-darwin",
	} {
		if !strings.Contains(string(workflow), command) {
			t.Errorf("native workflow omits %s", command)
		}
	}
}
