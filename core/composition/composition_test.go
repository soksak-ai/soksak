package composition

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	contract "github.com/soksak-ai/soksak-contract-composition"
	"github.com/soksak-ai/soksak-core/core/control"
)

func writeJSON(t *testing.T, path string, value any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
}
func fixture(t *testing.T) (string, contract.Plugin) {
	t.Helper()
	home := t.TempDir()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "plugin.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	plugin := contract.Plugin{PluginRef: contract.PluginRef{ID: "demo", Version: "0.0.1"}, Enabled: true, Development: true, InstallPath: root, Manifest: "plugin.json", Source: contract.Source{Type: contract.PathSource, Path: root}}
	settings := contract.Settings{Spec: contract.SettingsSpec, Generation: 7, Plugins: []contract.Plugin{plugin}, Sidecars: []contract.Sidecar{}, Kits: []contract.Kit{}, Bindings: []contract.Binding{}}
	writeJSON(t, filepath.Join(home, contract.SettingsFile), settings)
	return home, plugin
}
func TestLoadReadsTypedSettingsAndManifests(t *testing.T) {
	home, plugin := fixture(t)
	result, err := Load(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Graph.Plugins) != 1 || result.Graph.Plugins[0].Plugin != plugin || result.Graph.Plugins[0].Status != contract.Resolved {
		t.Fatalf("result=%+v", result)
	}
}
func TestLoadRejectsSymlinkedPluginPath(t *testing.T) {
	home, plugin := fixture(t)
	link := filepath.Join(t.TempDir(), "linked")
	if err := os.Symlink(plugin.InstallPath, link); err != nil {
		t.Fatal(err)
	}
	plugin.InstallPath = link
	plugin.Source.Path = link
	settings := contract.Settings{Spec: contract.SettingsSpec, Generation: 7, Plugins: []contract.Plugin{plugin}, Sidecars: []contract.Sidecar{}, Kits: []contract.Kit{}, Bindings: []contract.Binding{}}
	writeJSON(t, filepath.Join(home, contract.SettingsFile), settings)
	result, err := Load(home)
	if err != nil {
		t.Fatal(err)
	}
	if result.Graph.Plugins[0].Status != contract.Rejected {
		t.Fatalf("graph=%+v", result.Graph)
	}
}
func TestLoadRefusesMissingSettings(t *testing.T) {
	if _, err := Load(t.TempDir()); err == nil {
		t.Fatal("missing settings answered empty composition")
	}
}
func TestPluginAssetRootsContainOnlyResolvedEnabledPlugins(t *testing.T) {
	home, plugin := fixture(t)
	disabled := plugin
	disabled.ID = "disabled"
	disabled.Enabled = false
	disabled.InstallPath = t.TempDir()
	disabled.Source.Path = disabled.InstallPath
	if err := os.WriteFile(filepath.Join(disabled.InstallPath, "plugin.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	settings := contract.Settings{Spec: contract.SettingsSpec, Generation: 7, Plugins: []contract.Plugin{plugin, disabled}, Sidecars: []contract.Sidecar{}, Kits: []contract.Kit{}, Bindings: []contract.Binding{}}
	writeJSON(t, filepath.Join(home, contract.SettingsFile), settings)
	roots, err := PluginAssetRoots(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(roots) != 1 || roots[0] != plugin.InstallPath {
		t.Fatalf("roots=%v", roots)
	}
}
func TestCommandsExposeOneCompositionResult(t *testing.T) {
	home, _ := fixture(t)
	registry := control.NewRegistry()
	Register(registry, Deps{Home: home})
	settingsValue, err := registry.Invoke("composition_settings", nil)
	if err != nil {
		t.Fatal(err)
	}
	graphValue, err := registry.Invoke("composition_graph", nil)
	if err != nil {
		t.Fatal(err)
	}
	statusValue, err := registry.Invoke("composition_status", nil)
	if err != nil {
		t.Fatal(err)
	}
	settings := settingsValue.(contract.Settings)
	graph := graphValue.(contract.Graph)
	status := statusValue.(Status)
	if settings.Generation != 7 || status.Generation != 7 || len(graph.Plugins) != status.Plugins || status.DevelopmentPlugins != 1 {
		t.Fatalf("settings=%+v graph=%+v status=%+v", settings, graph, status)
	}
}
