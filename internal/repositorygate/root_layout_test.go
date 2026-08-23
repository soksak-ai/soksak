package repositorygate

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func TestRepositoryRootContainsOnlyTheCompositionRoot(t *testing.T) {
	entries, err := os.ReadDir(repositoryRoot)
	if err != nil {
		t.Fatal(err)
	}
	var goFiles []string
	for _, entry := range entries {
		if !entry.IsDir() && filepath.Ext(entry.Name()) == ".go" {
			goFiles = append(goFiles, entry.Name())
		}
	}
	sort.Strings(goFiles)
	if len(goFiles) != 1 || goFiles[0] != "main.go" {
		t.Fatalf("root Go files = %v, want only main.go", goFiles)
	}
}

func TestRepositoryGateContainsOnlyItsScannersAndTests(t *testing.T) {
	entries, err := os.ReadDir(filepath.Join(repositoryRoot, "internal", "repositorygate"))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".go" {
			continue
		}
		if entry.Name() == "repository_boundary.go" || entry.Name() == "tracked_record_files.go" || strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		t.Errorf("repository gate contains product source %s", entry.Name())
	}
}
