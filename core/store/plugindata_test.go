package store

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A value never written is absence, not failure. Collapsing the two makes a
// permissions problem look like "never saved", and the caller silently falls
// back to a default.
func TestAnUnwrittenPluginValueIsAbsence(t *testing.T) {
	value, found, err := readPluginData(t.TempDir(), "memo", "notes")
	if err != nil {
		t.Fatalf("reading a value never written: %v", err)
	}
	if found {
		t.Errorf("found = true, value %q", value)
	}
}

// A read failure that is not absence carries its reason.
func TestAnUnreadablePluginValueIsAFailure(t *testing.T) {
	base := t.TempDir()
	// A directory where the value file should be: present, and not readable as
	// a file.
	if err := os.MkdirAll(filepath.Join(base, "memo", "notes.json"), 0o755); err != nil {
		t.Fatalf("preparing: %v", err)
	}
	if _, _, err := readPluginData(base, "memo", "notes"); err == nil {
		t.Fatal("an unreadable value answered as absence")
	}
}

// The value is carried as it was written. Parsing and re-printing changes key
// order and number formatting, and only the plugin using it sees the
// difference.
func TestAPluginValueIsCarriedVerbatim(t *testing.T) {
	base := t.TempDir()
	original := `{"z":1.50,"a":2}`
	if err := writePluginData(base, "memo", "notes", original); err != nil {
		t.Fatalf("writing: %v", err)
	}
	value, found, err := readPluginData(base, "memo", "notes")
	if err != nil || !found {
		t.Fatalf("reading back: found=%v err=%v", found, err)
	}
	if value != original {
		t.Errorf("value = %q, want %q", value, original)
	}
}

// A plugin that never wrote lists nothing. A missing directory is an empty
// list, and the listed names are stripped of `.json` so a listed name is
// directly a read argument.
func TestListingIsSortedStrippedAndEmptyWhenNothingWasWritten(t *testing.T) {
	base := t.TempDir()
	keys, err := listPluginData(base, "memo")
	if err != nil {
		t.Fatalf("listing a plugin that never wrote: %v", err)
	}
	if len(keys) != 0 {
		t.Errorf("keys = %v", keys)
	}
	for _, key := range []string{"zebra", "apple"} {
		if err := writePluginData(base, "memo", key, "1"); err != nil {
			t.Fatalf("writing: %v", err)
		}
	}
	if err := os.WriteFile(filepath.Join(base, "memo", "notes.txt"), []byte("x"), 0o644); err != nil {
		t.Fatalf("preparing: %v", err)
	}
	keys, err = listPluginData(base, "memo")
	if err != nil {
		t.Fatalf("listing: %v", err)
	}
	if strings.Join(keys, ",") != "apple,zebra" {
		t.Errorf("keys = %v", keys)
	}
}

// A directory that cannot be read is an error, not an empty list.
func TestAnUnreadablePluginDirectoryIsAFailure(t *testing.T) {
	base := t.TempDir()
	if err := os.WriteFile(filepath.Join(base, "memo"), []byte("x"), 0o644); err != nil {
		t.Fatalf("preparing: %v", err)
	}
	if _, err := listPluginData(base, "memo"); err == nil {
		t.Fatal("a plugin directory that is a file listed as empty")
	}
}

// Reads never create the directory. It changes none of the three commands'
// answers, and only the side effect would differ per process.
func TestReadsLeaveTheFilesystemAlone(t *testing.T) {
	base := filepath.Join(t.TempDir(), "plugins-data")
	if _, _, err := readPluginData(base, "memo", "notes"); err != nil {
		t.Fatalf("reading: %v", err)
	}
	if _, err := listPluginData(base, "memo"); err != nil {
		t.Fatalf("listing: %v", err)
	}
	if _, err := os.Stat(base); !os.IsNotExist(err) {
		t.Errorf("a read created %s", base)
	}
}

// Writes create their own parents, so a first write does not depend on a layout
// some other process made.
func TestAWriteCreatesItsOwnParents(t *testing.T) {
	base := filepath.Join(t.TempDir(), "plugins-data")
	if err := writePluginData(base, "memo", "notes", "1"); err != nil {
		t.Fatalf("writing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(base, "memo", "notes.json")); err != nil {
		t.Errorf("the value was not written: %v", err)
	}
}

// Path escape is refused by the character set: there is no `.` and no `/` in a
// plugin id, and a bare `.` or `..` key is refused by name.
func TestPathEscapeIsRefusedOnEveryPluginSurface(t *testing.T) {
	base := t.TempDir()
	if _, _, err := readPluginData(base, "../../etc", "passwd"); err == nil {
		t.Error("an escaping id was accepted for reading")
	}
	if _, _, err := readPluginData(base, "memo", ".."); err == nil {
		t.Error("an escaping key was accepted for reading")
	}
	if err := writePluginData(base, "memo", "../secret", "1"); err == nil {
		t.Error("an escaping key was accepted for writing")
	}
	if _, err := listPluginData(base, "../../etc"); err == nil {
		t.Error("an escaping id was accepted for listing")
	}
}
