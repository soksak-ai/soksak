package main

import (
	"os"
	"strings"
	"testing"
)

func TestReleaseIntegrityRulesAreDocumentedInBothLanguages(t *testing.T) {
	documents := []string{"docs/tech/RELEASE-INTEGRITY.md", "docs/tech/RELEASE-INTEGRITY.ko.md"}
	for _, path := range documents {
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		text := string(body)
		for _, required := range []string{"sidecar.json", "release.json", "immutable", "registry", "runtime"} {
			if !strings.Contains(text, required) {
				t.Errorf("%s does not define %s", path, required)
			}
		}
	}
}
