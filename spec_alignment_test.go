package main

import (
	"os"
	"strings"
	"testing"

	platformspec "github.com/soksak-ai/soksak-spec/go/platformspec"
)

func TestGoAndFrontendSpecsAcceptSidecarPatchVersions(t *testing.T) {
	manifest := []byte(`{"id":"soksak-sidecar-terminal-vt100","version":"0.0.7","interface":{"id":"soksak-spec-sidecar-terminal","version":"0.0.1"},"process":"dist/soksak-sidecar-terminal-vt100"}`)
	parsed, err := platformspec.ParseSidecarManifest(manifest)
	if err != nil || parsed.Version != "0.0.7" {
		t.Fatalf("Go sidecar parser rejected patch version: %+v %v", parsed, err)
	}
	packageJSON, err := os.ReadFile("frontend/package.json")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(packageJSON), "/v0.0.13/soksak-ai-plugin-spec-0.0.13.tgz") {
		t.Fatal("frontend and Go do not use the same sidecar parser release")
	}
}
