package main

import (
	"os"
	"strings"
	"testing"
)

func TestRepositoryGovernanceDefinesSourcePreservation(t *testing.T) {
	body, err := os.ReadFile("docs/tech/REPOSITORY-GOVERNANCE.md")
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	for _, rule := range []string{
		"Local source is canonical",
		"Independent repositories",
		"version maintenance branch",
		"Forks",
		"Historical repositories",
		"No source loss",
		"archive/",
	} {
		if !strings.Contains(text, rule) {
			t.Errorf("repository governance does not define %q", rule)
		}
	}
}

func TestCurrentProductAutomationNamesMain(t *testing.T) {
	body, err := os.ReadFile(".github/workflows/multiplatform-system.yml")
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	if !strings.Contains(text, "branches: [main]") {
		t.Fatal("multiplatform verification must follow the canonical main branch")
	}
	if strings.Contains(text, "wails3beta-terminal-0.0.2") {
		t.Fatal("multiplatform verification names a retired development branch")
	}
}
