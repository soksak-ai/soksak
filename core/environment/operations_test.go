package environment

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func writeJSON(t *testing.T, path string, value any) {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
}
func TestPluginManifestsReadOneEnvironmentRecord(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	manifest := []byte("{\"id\":\"demo\"}")
	if err := os.WriteFile(filepath.Join(root, "plugin.json"), manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	environment := Empty()
	environment.Plugins["demo"] = Plugin{Component: Component{Version: "0.0.1", Path: root, Source: "registry", Registry: "official"}, Enabled: true}
	writeJSON(t, filepath.Join(home, File), environment)
	records, err := PluginManifests(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 || !records[0].Enabled || records[0].InstallPath != root || records[0].Manifest == nil || *records[0].Manifest != string(manifest) {
		t.Fatalf("records=%+v", records)
	}
}

func TestSidecarSelectionResolvesEnvironmentSidecar(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	process := filepath.Join(root, "dist", "terminal-sidecar")
	if err := os.MkdirAll(filepath.Dir(process), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(process, []byte("binary"), 0o700); err != nil {
		t.Fatal(err)
	}
	manifest := map[string]any{"id": "terminal-sidecar", "version": "0.0.1", "interface": map[string]string{"id": "terminal-state", "version": "0.0.1"}, "process": "dist/terminal-sidecar"}
	writeJSON(t, filepath.Join(root, "sidecar.json"), manifest)
	environment := Empty()
	environment.Plugins["terminal-view"] = Plugin{Component: Component{Version: "0.0.1", Path: t.TempDir(), Source: "registry", Registry: "official"}, Enabled: true, Sidecars: map[string]string{"terminal": "terminal-sidecar"}}
	environment.Sidecars["terminal-sidecar"] = Component{Version: "0.0.1", Path: root, Source: "registry", Registry: "official", Target: "aarch64-apple-darwin"}
	writeJSON(t, filepath.Join(home, File), environment)
	runtime, err := ResolveBoundSidecar(home, PluginRef{ID: "terminal-view", Version: "0.0.1"}, "terminal")
	if err != nil {
		t.Fatal(err)
	}
	if runtime.Process != process || runtime.InterfaceID != "terminal-state" {
		t.Fatalf("runtime=%+v", runtime)
	}
}

func TestSidecarSelectionResolvesAWindowsSidecarExecutable(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	process := filepath.Join(root, "dist", "terminal-sidecar.exe")
	if err := os.MkdirAll(filepath.Dir(process), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(process, []byte("binary"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeJSON(t, filepath.Join(root, "sidecar.json"), map[string]any{
		"id": "terminal-sidecar", "version": "0.0.1",
		"interface": map[string]string{"id": "terminal-state", "version": "0.0.1"},
		"process":   "dist/terminal-sidecar.exe",
	})
	environment := Empty()
	environment.Sidecars["terminal-sidecar"] = Component{Version: "0.0.1", Path: root, Source: "registry", Registry: "official", Target: "x86_64-pc-windows-msvc"}
	writeJSON(t, filepath.Join(home, File), environment)
	runtime, err := ResolveSidecar(home, "terminal-sidecar")
	if err != nil {
		t.Fatal(err)
	}
	if runtime.Process != process {
		t.Fatalf("process = %s", runtime.Process)
	}
}

func TestEnvironmentChangesAdvanceOneRevision(t *testing.T) {
	home := t.TempDir()
	value := Empty()
	value.Plugins["demo"] = Plugin{Component: Component{Version: "0.0.1", Path: t.TempDir(), Source: "registry", Registry: "official"}}
	writeJSON(t, filepath.Join(home, File), value)
	change, err := SetPluginsEnabled(home, []PluginRef{{ID: "demo", Version: "0.0.1"}}, true, 1)
	if err != nil {
		t.Fatal(err)
	}
	if change != (Change{PreviousRevision: 1, Revision: 2}) {
		t.Fatalf("change=%+v", change)
	}
	change, err = SetSidecar(home, "demo", "terminal", "terminal-sidecar", 2)
	if err != nil {
		t.Fatal(err)
	}
	if change.Revision != 3 {
		t.Fatalf("change=%+v", change)
	}
}
