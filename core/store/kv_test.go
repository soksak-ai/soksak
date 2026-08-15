package store

import (
	"path/filepath"
	"testing"
)

func open(t *testing.T) *KV {
	t.Helper()
	kv, err := OpenKV(filepath.Join(t.TempDir(), "soksak.db"))
	if err != nil {
		t.Fatalf("opening the store: %v", err)
	}
	t.Cleanup(func() { _ = kv.Close() })
	return kv
}

func TestMissingKeyIsAbsenceNotFailure(t *testing.T) {
	// A key that was never written is an ordinary answer. Failing here would
	// make every first read of every setting an error.
	value, found, err := open(t).Get("ui", "theme")
	if err != nil {
		t.Fatalf("reading a missing key: %v", err)
	}
	if found {
		t.Errorf("found = true for a key never written, value %q", value)
	}
}

func TestTheLastWriteWins(t *testing.T) {
	kv := open(t)
	if err := kv.Set("ui", "theme", `"Midnight"`); err != nil {
		t.Fatalf("first write: %v", err)
	}
	if err := kv.Set("ui", "theme", `"Paper"`); err != nil {
		t.Fatalf("second write: %v", err)
	}

	value, found, err := kv.Get("ui", "theme")
	if err != nil || !found {
		t.Fatalf("reading back: value=%q found=%v err=%v", value, found, err)
	}
	if value != `"Paper"` {
		t.Errorf("value = %q, want the later write", value)
	}
}

func TestNamespacesDoNotSeeEachOther(t *testing.T) {
	kv := open(t)
	if err := kv.Set("ui", "theme", `"Midnight"`); err != nil {
		t.Fatalf("writing: %v", err)
	}

	if _, found, _ := kv.Get("plugin-notes", "theme"); found {
		t.Error("a key must not be visible from another namespace")
	}
}

func TestNamespaceNamesAreConstrained(t *testing.T) {
	kv := open(t)
	// The character set has no `/`, `.`, or `:`, so a namespace cannot leak
	// into a path or a meta key.
	for _, bad := range []string{"", "UI", "ui/theme", "ui.theme", "ui:theme", "-ui", "ui theme"} {
		if err := kv.Set(bad, "k", "1"); err == nil {
			t.Errorf("namespace %q was accepted", bad)
		}
		if _, _, err := kv.Get(bad, "k"); err == nil {
			t.Errorf("namespace %q was accepted for reading", bad)
		}
	}
	for _, good := range []string{"ui", "plugin-notes", "a0"} {
		if err := kv.Set(good, "k", "1"); err != nil {
			t.Errorf("namespace %q was refused: %v", good, err)
		}
	}
}

func TestDeleteRemovesTheKey(t *testing.T) {
	kv := open(t)
	if err := kv.Set("ui", "theme", `"Midnight"`); err != nil {
		t.Fatalf("writing: %v", err)
	}
	if err := kv.Delete("ui", "theme"); err != nil {
		t.Fatalf("deleting: %v", err)
	}

	if _, found, _ := kv.Get("ui", "theme"); found {
		t.Error("the key survived deletion")
	}
}

func TestDeletingWhatIsNotThereIsNotAnError(t *testing.T) {
	// Deletion converges on the same state whether or not the key was there,
	// so repeating it is safe.
	if err := open(t).Delete("ui", "never-written"); err != nil {
		t.Errorf("deleting a missing key: %v", err)
	}
}

func TestValuesSurviveReopening(t *testing.T) {
	path := filepath.Join(t.TempDir(), "soksak.db")
	first, err := OpenKV(path)
	if err != nil {
		t.Fatalf("opening: %v", err)
	}
	if err := first.Set("ui", "theme", `"Midnight"`); err != nil {
		t.Fatalf("writing: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("closing: %v", err)
	}

	second, err := OpenKV(path)
	if err != nil {
		t.Fatalf("reopening: %v", err)
	}
	t.Cleanup(func() { _ = second.Close() })

	value, found, err := second.Get("ui", "theme")
	if err != nil || !found || value != `"Midnight"` {
		t.Errorf("after reopening: value=%q found=%v err=%v", value, found, err)
	}
}
