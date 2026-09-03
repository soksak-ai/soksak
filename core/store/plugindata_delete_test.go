package store

import (
	"os"
	"path/filepath"
	"testing"
)

// What a plugin stored, it can take back. Without this a record outlives the thing it was for and
// nothing reaches it: a session that closed, a view that is gone, a key a build stopped writing.
// The store grows by everything that ever existed and no command can shrink it.
func TestAPluginTakesBackWhatItStored(t *testing.T) {
	base := t.TempDir()
	if err := writePluginData(base, "soksak-plugin-example", "session-7", `{"a":1}`); err != nil {
		t.Fatal(err)
	}
	if err := deletePluginData(base, "soksak-plugin-example", "session-7"); err != nil {
		t.Fatal(err)
	}
	if _, found, err := readPluginData(base, "soksak-plugin-example", "session-7"); err != nil {
		t.Fatal(err)
	} else if found {
		t.Fatal("the value survived the delete")
	}
	names, err := listPluginData(base, "soksak-plugin-example")
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 0 {
		t.Fatalf("the listing still names %v", names)
	}
}

// Deleting what was never written is not a failure. The outcome the caller wanted is the outcome it
// has, and a refusal would make a caller handle a case that is already what it asked for.
func TestDeletingWhatWasNeverWrittenIsNotAFailure(t *testing.T) {
	if err := deletePluginData(t.TempDir(), "soksak-plugin-example", "session-404"); err != nil {
		t.Fatalf("deleting an absent value answered %v", err)
	}
}

// A key another plugin's data would be reached through is refused, the same as it is for a read and
// a write. A delete is the one that would destroy rather than expose.
func TestADeleteCannotReachAnotherPluginsData(t *testing.T) {
	base := t.TempDir()
	if err := writePluginData(base, "soksak-plugin-other", "kept", "value"); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"../soksak-plugin-other/kept", "..", "/etc/passwd"} {
		if err := deletePluginData(base, "soksak-plugin-example", key); err == nil {
			t.Errorf("a delete of %q was accepted", key)
		}
	}
	if _, err := os.Stat(filepath.Join(base, "soksak-plugin-other")); err != nil {
		t.Fatalf("another plugin's directory did not survive: %v", err)
	}
}
