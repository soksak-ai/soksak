package repositorygate

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
		"Historical source",
		"No source loss",
		"archive/",
	} {
		if !strings.Contains(text, rule) {
			t.Errorf("repository governance does not define %q", rule)
		}
	}
}

func TestNativeSystemVerificationRunsOnlyWhenRequested(t *testing.T) {
	body, err := os.ReadFile(".github/workflows/multiplatform-system.yml")
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	if !strings.Contains(text, "workflow_dispatch:") {
		t.Fatal("multiplatform verification has no manual entry point")
	}
	if strings.Contains(text, "push:") {
		t.Fatal("multiplatform verification spends native runners on every source push")
	}
}
