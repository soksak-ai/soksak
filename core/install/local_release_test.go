package install

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// releaseDocument is a plugin release.json for id@version in the shape platformspec validates;
// extra is merged into the first artifact.
func releaseDocument(t *testing.T, id, version string, extra map[string]any) []byte {
	t.Helper()
	artifact := map[string]any{"target": "any", "file": id + "-" + version + ".tgz", "size": 12345, "sha256": strings.Repeat("1", 64), "format": "tgz", "manifest": "plugin.json"}
	for key, value := range extra {
		artifact[key] = value
	}
	body, err := json.Marshal(map[string]any{
		"kind": "plugin", "id": id, "version": version,
		"manifest":  map[string]any{"file": "plugin.json", "size": 24, "sha256": strings.Repeat("e", 64)},
		"source":    map[string]any{"repository": "https://github.com/soksak-ai/" + id, "commit": strings.Repeat("a", 40)},
		"artifacts": []any{artifact},
		"evidence":  []any{map[string]any{"file": "plugin-kind.conformance.json", "size": 1, "sha256": strings.Repeat("8", 64)}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func writeLocalRelease(t *testing.T, store, id, version string, body []byte) {
	t.Helper()
	directory := filepath.Join(store, "plugins", id, version)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "release.json"), body, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestReadLocalReleaseReturnsExactBytesAndAbsence(t *testing.T) {
	store := t.TempDir()
	missing, err := ReadLocalRelease(store, "plugin", "demo", "0.0.1")
	if err != nil || missing.Found {
		t.Fatalf("missing=%+v err=%v", missing, err)
	}
	body := releaseDocument(t, "demo", "0.0.1", nil)
	writeLocalRelease(t, store, "demo", "0.0.1", body)
	value, err := ReadLocalRelease(store, "plugin", "demo", "0.0.1")
	if err != nil || !value.Found || value.Body != string(body) || value.Size != uint64(len(body)) || len(value.SHA256) != 64 {
		t.Fatalf("value=%+v err=%v", value, err)
	}
}

func TestReadLocalReleaseRejectsADocumentWithAURL(t *testing.T) {
	store := t.TempDir()
	body := releaseDocument(t, "demo", "0.0.1", map[string]any{"url": "https://github.com/soksak-ai/demo/releases/download/v0.0.1/demo-0.0.1.tgz"})
	writeLocalRelease(t, store, "demo", "0.0.1", body)
	value, err := ReadLocalRelease(store, "plugin", "demo", "0.0.1")
	if err == nil {
		t.Fatalf("release document with a url was accepted: %+v", value)
	}
}

func TestReadLocalReleaseRejectsADocumentOfAnotherIdentity(t *testing.T) {
	store := t.TempDir()
	writeLocalRelease(t, store, "demo", "0.0.1", releaseDocument(t, "other", "0.0.1", nil))
	if _, err := ReadLocalRelease(store, "plugin", "demo", "0.0.1"); err == nil {
		t.Fatal("release document of another id was accepted")
	}
}

// The store path is derived from the id and the version; both follow the spec grammars, so a
// value that names a path segment is refused before any file system access.
func TestReadLocalReleaseRefusesAnIdOrVersionOutsideTheGrammar(t *testing.T) {
	store := t.TempDir()
	for _, identity := range [][2]string{{"../view", "0.0.1"}, {"view", "../0.0.1"}, {"View", "0.0.1"}, {"view", "v0.0.1"}, {"view", "01.0.0"}} {
		_, err := ReadLocalRelease(store, "plugin", identity[0], identity[1])
		if err == nil || !strings.Contains(err.Error(), "outside the spec grammar") {
			t.Fatalf("%q@%q: error = %v", identity[0], identity[1], err)
		}
	}
}
