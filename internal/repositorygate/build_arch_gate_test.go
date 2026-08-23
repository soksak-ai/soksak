package repositorygate

import (
	"os"
	"strings"
	"testing"
)

func TestDarwinBuildDefaultsToTheHostArchitecture(t *testing.T) {
	contents, err := os.ReadFile("build/darwin/Taskfile.yml")
	if err != nil {
		t.Fatal(err)
	}
	text := string(contents)
	for _, required := range []string{
		"HOST_ARCH:",
		"hw.optional.arm64",
		"uname -m",
		"TARGET_ARCH: '{{.TARGET_ARCH | default .HOST_ARCH}}'",
		"GOARCH: '{{.TARGET_ARCH}}'",
	} {
		if !strings.Contains(text, required) {
			t.Errorf("darwin build rule is missing %q", required)
		}
	}
	if strings.Contains(text, "GOARCH: '{{.ARCH") {
		t.Error("darwin build still defaults GOARCH from Task's process architecture")
	}
}
