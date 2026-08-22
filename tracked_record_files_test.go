package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
)

func TestTrackedRecordFilesExcludeUntrackedAndGeneratedFiles(t *testing.T) {
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
	write("generated/model.go")
	if err := exec.Command("git", "-C", root, "add", "tracked.go", "generated/model.go").Run(); err != nil {
		t.Fatal(err)
	}

	files, err := trackedRecordFiles(root, map[string]bool{".go": true}, []string{"generated/"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(files, []string{"tracked.go"}) {
		t.Fatalf("files = %v, want [tracked.go]", files)
	}
}
