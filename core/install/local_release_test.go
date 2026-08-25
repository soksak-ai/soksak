package install

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadLocalReleaseReturnsExactBytesAndAbsence(t *testing.T) {
	store := t.TempDir()
	missing, err := ReadLocalRelease(store, "plugin", "demo", "0.0.1")
	if err != nil || missing.Found {
		t.Fatalf("missing=%+v err=%v", missing, err)
	}
	directory := filepath.Join(store, "plugins", "demo", "0.0.1")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"kind":"plugin","id":"demo","version":"0.0.1"}`)
	if err := os.WriteFile(filepath.Join(directory, "release.json"), body, 0o600); err != nil {
		t.Fatal(err)
	}
	value, err := ReadLocalRelease(store, "plugin", "demo", "0.0.1")
	if err != nil || !value.Found || value.Body != string(body) || value.Size != uint64(len(body)) || len(value.SHA256) != 64 {
		t.Fatalf("value=%+v err=%v", value, err)
	}
}
