package repositorygate

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
)

func TestTrackedRecordFilesUseTheCurrentWorktree(t *testing.T) {
	root := t.TempDir()
	if err := exec.Command("git", "-C", root, "init", "--quiet").Run(); err != nil {
		t.Fatal(err)
	}
	write := func(path string) {
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("package sample\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("tracked.go")
	write("notes.go")
	write("deleted.go")
	write("generated/model.go")
	if err := exec.Command("git", "-C", root, "add", "tracked.go", "deleted.go", "generated/model.go").Run(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, "deleted.go")); err != nil {
		t.Fatal(err)
	}

	files, err := trackedRecordFiles(root, map[string]bool{".go": true}, []string{"generated/"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(files, []string{"notes.go", "tracked.go"}) {
		t.Fatalf("files = %v, want [notes.go tracked.go]", files)
	}
}

func TestTrackedRecordFilesApplyIncludedPrefixes(t *testing.T) {
	root := t.TempDir()
	if err := exec.Command("git", "-C", root, "init", "--quiet").Run(); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"core/a.go", "frontend/src/b.ts", "docs/c.md"} {
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("content\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := exec.Command("git", "-C", root, "add", ".").Run(); err != nil {
		t.Fatal(err)
	}

	files, err := trackedRecordFilesUnder(root, nil, []string{"core/", "frontend/src/"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(files, []string{"core/a.go", "frontend/src/b.ts"}) {
		t.Fatalf("files = %v", files)
	}
}
