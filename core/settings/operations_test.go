package settings

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
func installed(id, path string) InstalledComponent {
	return InstalledComponent{Version: "0.0.1", Path: path, RegistryID: "official", Repository: "https://github.com/example/" + id, SourceCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ManifestSHA256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", ArtifactSHA256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}
}

func TestPluginManifestsCombinesUserChoiceAndInstalledResult(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	manifest := []byte("{\"id\":\"demo\"}")
	if err := os.WriteFile(filepath.Join(root, "plugin.json"), manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	preferences := Empty()
	preferences.Plugins["demo"] = Plugin{Enabled: true}
	writeJSON(t, filepath.Join(home, File), preferences)
	state := EmptyInstalled()
	state.Plugins["demo"] = installed("demo", root)
	writeJSON(t, filepath.Join(home, InstalledFile), state)
	records, err := PluginManifests(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 || !records[0].Enabled || records[0].InstallPath != root || records[0].Manifest == nil || *records[0].Manifest != string(manifest) {
		t.Fatalf("records=%+v", records)
	}
}

func TestProviderSelectionResolvesInstalledSidecar(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	process := filepath.Join(root, "dist", "terminal-provider")
	if err := os.MkdirAll(filepath.Dir(process), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(process, []byte("binary"), 0o700); err != nil {
		t.Fatal(err)
	}
	manifest := map[string]any{"id": "terminal-provider", "version": "0.0.1", "interface": map[string]string{"id": "terminal-state", "version": "0.0.1"}, "process": "dist/terminal-provider"}
	writeJSON(t, filepath.Join(root, "sidecar.json"), manifest)
	preferences := Empty()
	preferences.Plugins["terminal-view"] = Plugin{Enabled: true, Providers: map[string]string{"terminal": "terminal-provider"}}
	writeJSON(t, filepath.Join(home, File), preferences)
	state := EmptyInstalled()
	sidecar := installed("terminal-provider", root)
	sidecar.Target = "aarch64-apple-darwin"
	state.Sidecars["terminal-provider"] = sidecar
	writeJSON(t, filepath.Join(home, InstalledFile), state)
	runtime, err := ResolveBoundSidecar(home, PluginRef{ID: "terminal-view", Version: "0.0.1"}, "terminal")
	if err != nil {
		t.Fatal(err)
	}
	if runtime.Process != process || runtime.InterfaceID != "terminal-state" {
		t.Fatalf("runtime=%+v", runtime)
	}
}

func TestProviderSelectionResolvesAWindowsSidecarExecutable(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	process := filepath.Join(root, "dist", "terminal-provider.exe")
	if err := os.MkdirAll(filepath.Dir(process), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(process, []byte("binary"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeJSON(t, filepath.Join(root, "sidecar.json"), map[string]any{
		"id": "terminal-provider", "version": "0.0.1",
		"interface": map[string]string{"id": "terminal-state", "version": "0.0.1"},
		"process":   "dist/terminal-provider.exe",
	})
	preferences := Empty()
	preferences.Sidecars["terminal-provider"] = Component{}
	writeJSON(t, filepath.Join(home, File), preferences)
	state := EmptyInstalled()
	sidecar := installed("terminal-provider", root)
	sidecar.Target = "x86_64-pc-windows-msvc"
	state.Sidecars["terminal-provider"] = sidecar
	writeJSON(t, filepath.Join(home, InstalledFile), state)
	runtime, err := ResolveInstalledSidecar(home, "terminal-provider")
	if err != nil {
		t.Fatal(err)
	}
	if runtime.Process != process {
		t.Fatalf("process = %s", runtime.Process)
	}
}

func TestSettingsChangesAdvanceOneRevision(t *testing.T) {
	home := t.TempDir()
	value := Empty()
	value.Plugins["demo"] = Plugin{}
	writeJSON(t, filepath.Join(home, File), value)
	change, err := SetPluginsEnabled(home, []PluginRef{{ID: "demo", Version: "0.0.1"}}, true, 1)
	if err != nil {
		t.Fatal(err)
	}
	if change != (Change{PreviousRevision: 1, Revision: 2}) {
		t.Fatalf("change=%+v", change)
	}
	change, err = SetProvider(home, "demo", "terminal", "terminal-provider", 2)
	if err != nil {
		t.Fatal(err)
	}
	if change.Revision != 3 {
		t.Fatalf("change=%+v", change)
	}
}
