package environment

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
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
	environment.Plugins["demo"] = Plugin{Component: Component{Version: "0.0.1", Path: root, ArtifactSHA256: strings.Repeat("a", 64), Source: "registry", Registry: "official"}, Enabled: true}
	writeJSON(t, filepath.Join(home, File), environment)
	records, err := PluginManifests(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 || !records[0].Enabled || records[0].InstallPath != root || records[0].Manifest == nil || *records[0].Manifest != string(manifest) {
		t.Fatalf("records=%+v", records)
	}
}

func TestInitializePublishesTheFirstEnvironmentRevision(t *testing.T) {
	home := t.TempDir()
	if err := Initialize(home); err != nil {
		t.Fatal(err)
	}
	value, exists, err := Read(home)
	if err != nil || !exists || value.Revision != 1 {
		t.Fatalf("environment=%+v exists=%v err=%v", value, exists, err)
	}
}

func TestExactSidecarReferenceResolvesEnvironmentSidecar(t *testing.T) {
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
	environment.Plugins["terminal-view"] = Plugin{Component: Component{Version: "0.0.1", Path: t.TempDir(), ArtifactSHA256: strings.Repeat("a", 64), Source: "registry", Registry: "official"}, Enabled: true}
	environment.Sidecars["terminal-sidecar"] = Component{Version: "0.0.1", Path: root, ArtifactSHA256: strings.Repeat("b", 64), Source: "registry", Registry: "official", Target: "aarch64-apple-darwin"}
	writeJSON(t, filepath.Join(home, File), environment)
	runtime, err := ResolveSidecarForPlugin(home, PluginRef{ID: "terminal-view", Version: "0.0.1"}, PluginRef{ID: "terminal-sidecar", Version: "0.0.1"})
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
	environment.Sidecars["terminal-sidecar"] = Component{Version: "0.0.1", Path: root, ArtifactSHA256: strings.Repeat("a", 64), Source: "registry", Registry: "official", Target: "x86_64-pc-windows-msvc"}
	writeJSON(t, filepath.Join(home, File), environment)
	runtime, err := ResolveSidecarVersion(home, "terminal-sidecar", "0.0.1")
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
	value.Plugins["demo"] = Plugin{Component: Component{Version: "0.0.1", Path: t.TempDir(), ArtifactSHA256: strings.Repeat("a", 64), Source: "registry", Registry: "official"}}
	writeJSON(t, filepath.Join(home, File), value)
	change, err := SetPluginsEnabled(home, []PluginRef{{ID: "demo", Version: "0.0.1"}}, true, 1)
	if err != nil {
		t.Fatal(err)
	}
	if change != (Change{PreviousRevision: 1, Revision: 2}) {
		t.Fatalf("change=%+v", change)
	}
}

func TestPluginEnablementUsesTheInstalledReleaseVersion(t *testing.T) {
	home := t.TempDir()
	value := Empty()
	value.Plugins["demo"] = Plugin{Component: Component{Version: "0.0.3", Path: t.TempDir(), ArtifactSHA256: strings.Repeat("a", 64), Source: "registry", Registry: "official"}}
	writeJSON(t, filepath.Join(home, File), value)
	if _, err := SetPluginsEnabled(home, []PluginRef{{ID: "demo", Version: "0.0.3"}}, true, 1); err != nil {
		t.Fatalf("installed version was refused: %v", err)
	}
	if _, err := SetPluginsEnabled(home, []PluginRef{{ID: "demo", Version: "0.0.2"}}, false, 2); !os.IsNotExist(err) {
		t.Fatalf("mismatched version error = %v", err)
	}
}
