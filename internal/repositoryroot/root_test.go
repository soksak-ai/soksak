package repositoryroot

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDiscoverFindsTheModuleFromANestedDirectory(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "go.mod"), []byte("module example.test/root\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(root, "a", "b")
	if err := os.MkdirAll(nested, 0o700); err != nil {
		t.Fatal(err)
	}
	got, err := Discover(nested)
	if err != nil || got != root {
		t.Fatalf("Discover() = %q, %v; want %q", got, err, root)
	}
}
