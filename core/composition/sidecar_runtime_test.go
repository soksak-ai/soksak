package composition

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	contract "github.com/soksak-ai/soksak-contract-composition"
)

func TestBoundSidecarRuntimeUsesSettingsManifestAndProcess(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	binary := filepath.Join(root, "dist", "terminal-vt100")
	if err := os.MkdirAll(filepath.Dir(binary), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binary, []byte("binary"), 0o700); err != nil {
		t.Fatal(err)
	}
	manifest := map[string]any{
		"spec": "soksak-spec-sidecar@0.0.1", "id": "soksak-sidecar-terminal-vt100", "version": "0.0.1",
		"interface": map[string]string{"id": "soksak-spec-sidecar-terminal", "version": "0.0.1"},
		"process":   "dist/terminal-vt100",
	}
	body, _ := json.Marshal(manifest)
	if err := os.WriteFile(filepath.Join(root, "sidecar.json"), body, 0o600); err != nil {
		t.Fatal(err)
	}
	plugin := contract.PluginRef{ID: "soksak-plugin-terminal-vt100", Version: "0.0.1"}
	provider := contract.SidecarRef{ID: "soksak-sidecar-terminal-vt100", Version: "0.0.1"}
	pluginRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(pluginRoot, "plugin.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	settings := contract.Settings{
		Spec: contract.SettingsSpec, Generation: 1,
		Plugins:  []contract.Plugin{{PluginRef: plugin, Enabled: true, InstallPath: pluginRoot, Manifest: "plugin.json", Source: contract.Source{Type: contract.PathSource, Path: pluginRoot}}},
		Sidecars: []contract.Sidecar{{SidecarRef: provider, Enabled: true, InstallPath: root, Manifest: "sidecar.json", Source: contract.Source{Type: contract.PathSource, Path: root}}},
		Kits:     []contract.Kit{},
		Bindings: []contract.Binding{{Consumer: contract.Endpoint{Plugin: &plugin}, Requirement: "terminal-provider", Provider: contract.Endpoint{Sidecar: &provider}}},
	}
	writeJSON(t, filepath.Join(home, contract.SettingsFile), settings)
	runtime, err := ResolveBoundSidecar(home, plugin, "terminal-provider")
	if err != nil {
		t.Fatal(err)
	}
	if runtime.ID != provider.ID || runtime.Version != provider.Version || runtime.Process != binary || runtime.InterfaceID != "soksak-spec-sidecar-terminal" || runtime.InterfaceVersion != "0.0.1" {
		t.Fatalf("runtime=%+v", runtime)
	}
}

func TestBoundSidecarRuntimeRejectsMissingBinding(t *testing.T) {
	home := t.TempDir()
	plugin := contract.PluginRef{ID: "p", Version: "0.0.1"}
	settings := contract.Settings{Spec: contract.SettingsSpec, Generation: 1, Plugins: []contract.Plugin{}, Sidecars: []contract.Sidecar{}, Kits: []contract.Kit{}, Bindings: []contract.Binding{}}
	writeJSON(t, filepath.Join(home, contract.SettingsFile), settings)
	if _, err := ResolveBoundSidecar(home, plugin, "provider"); err == nil {
		t.Fatal("missing binding was accepted")
	}
}
