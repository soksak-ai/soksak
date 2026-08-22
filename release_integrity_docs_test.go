package main

import (
	"os"
	"strings"
	"testing"
)

func TestReleaseIntegrityRulesAreDocumentedInBothLanguages(t *testing.T) {
	documents := map[string]string{
		"docs/tech/RELEASE-INTEGRITY.md":    "Core",
		"docs/tech/RELEASE-INTEGRITY.ko.md": "코어",
	}
	for path, coreName := range documents {
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		text := string(body)
		for _, required := range []string{"sidecar.json", "release.json", "immutable", coreName, "registry"} {
			if !strings.Contains(text, required) {
				t.Errorf("%s does not define %s", path, required)
			}
		}
	}
}
