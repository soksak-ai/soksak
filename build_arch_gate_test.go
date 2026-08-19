package main

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
		"uname -m",
		"GOARCH: '{{.ARCH | default .HOST_ARCH}}'",
	} {
		if !strings.Contains(text, required) {
			t.Errorf("darwin build rule is missing %q", required)
		}
	}
}
