package repositorygate

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestRepositoryDoesNotExecuteSiblingSources(t *testing.T) {
	root, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	findings, err := repositoryBoundaryFindings(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, finding := range findings {
		t.Error(finding)
	}
	tracked, err := exec.Command("git", "ls-files", ".pnpm-store").Output()
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(tracked)) != "" {
		t.Fatalf("pnpm cache is tracked:\n%s", tracked)
	}
}

func TestRepositoryBoundarySkipsPackageCacheButNotSourceLinks(t *testing.T) {
	root := t.TempDir()
	cache := filepath.Join(root, ".pnpm-store")
	if err := os.MkdirAll(cache, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("cache-target", filepath.Join(cache, "project")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("source-target", filepath.Join(root, "source.go")); err != nil {
		t.Fatal(err)
	}
	findings, err := repositoryBoundaryFindings(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 1 || findings[0] != "source.go: symbolic link" {
		t.Fatalf("findings = %v", findings)
	}
}
