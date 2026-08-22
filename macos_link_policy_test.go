package main

import (
	"os"
	"strings"
	"testing"
)

func TestMacOSGoCommandsUseOneWarningFreeLinkPolicy(t *testing.T) {
	taskfile, err := os.ReadFile("Taskfile.yml")
	if err != nil {
		t.Fatal(err)
	}
	linker, err := os.ReadFile("scripts/ci/macos-link.sh")
	if err != nil {
		t.Fatal(err)
	}
	for path, body := range map[string]string{"Taskfile.yml": string(taskfile), "scripts/ci/macos-link.sh": string(linker)} {
		for _, required := range []string{"MACOSX_DEPLOYMENT_TARGET", "10.15", "-mmacosx-version-min=10.15", "-no_warn_duplicate_libraries"} {
			if !strings.Contains(body, required) {
				t.Errorf("%s omits %s", path, required)
			}
		}
	}
}
