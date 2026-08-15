package scan

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAMissingDirectoryIsAnEmptyList(t *testing.T) {
	// A read command must not create the directory, and a fresh home meets
	// absence immediately. Measured 2026-07-28, the split was visible:
	// one leg answered [] and the other "os error 2" for the same command
	// name, because only one of them had already made its home.
	entries, err := Directory(filepath.Join(t.TempDir(), "never-created"), ".json")
	if err != nil {
		t.Fatalf("a missing directory must not be an error: %v", err)
	}
	if entries == nil {
		t.Fatal("the result must be an empty slice, never nil")
	}
	if len(entries) != 0 {
		t.Errorf("entries = %v, want none", entries)
	}
}

func TestAnUnreadableDirectoryIsAnError(t *testing.T) {
	// "nothing is installed" and "the directory could not be read" must stay
	// different answers, or a permissions problem reads as an empty catalogue.
	dir := filepath.Join(t.TempDir(), "sealed")
	if err := os.Mkdir(dir, 0o000); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })

	if _, err := Directory(dir, ".json"); err == nil {
		t.Fatal("an unreadable directory must fail rather than read as empty")
	}
}

func TestOnlyTheRequestedSuffixIsReturned(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"midnight.json", "notes.txt", "paper.json"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("{}"), 0o644); err != nil {
			t.Fatalf("preparing the fixture: %v", err)
		}
	}

	entries, err := Directory(dir, ".json")
	if err != nil {
		t.Fatalf("scanning: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %v, want the two json files", entries)
	}
	// Sorted, because the caller renders this and directory order is not stable
	// across filesystems.
	if filepath.Base(entries[0].Path) != "midnight.json" || filepath.Base(entries[1].Path) != "paper.json" {
		t.Errorf("entries are not sorted by name: %v", entries)
	}
}

func TestContentsAreReadWithTheEntry(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "one.json"), []byte(`{"name":"One"}`), 0o644); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}

	entries, err := Directory(dir, ".json")
	if err != nil {
		t.Fatalf("scanning: %v", err)
	}
	if entries[0].Contents != `{"name":"One"}` {
		t.Errorf("contents = %q", entries[0].Contents)
	}
}

func TestSubdirectoriesAreNotEntries(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "nested.json"), 0o755); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}

	entries, err := Directory(dir, ".json")
	if err != nil {
		t.Fatalf("scanning: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("a directory named like a file must not be an entry: %v", entries)
	}
}
