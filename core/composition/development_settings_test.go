package composition

import (
	"os"
	"path/filepath"
	"testing"

	contract "github.com/soksak-ai/soksak-contract-composition"
)

func TestDevelopmentSettingsAreKindSpecific(t *testing.T) {
	home := t.TempDir()
	pluginRoot := fixtureDirectory(t, "plugin.json")
	sidecarRoot := fixtureDirectory(t, "sidecar.json")
	kitRoot := fixtureDirectory(t, "package.json")
	plugin := contract.Plugin{PluginRef: contract.PluginRef{ID: "p", Version: "0.0.1"}, Enabled: true, Development: true, InstallPath: pluginRoot, Manifest: "plugin.json", Source: contract.Source{Type: contract.PathSource, Path: pluginRoot}}
	change, err := SetPluginDevelopment(home, plugin, 0)
	if err != nil {
		t.Fatal(err)
	}
	sidecar := contract.Sidecar{SidecarRef: contract.SidecarRef{ID: "s", Version: "0.0.1"}, Enabled: true, Development: true, InstallPath: sidecarRoot, Manifest: "sidecar.json", Source: contract.Source{Type: contract.PathSource, Path: sidecarRoot}}
	change, err = SetSidecarDevelopment(home, sidecar, change.Generation)
	if err != nil {
		t.Fatal(err)
	}
	kit := contract.Kit{KitRef: contract.KitRef{ID: "k", Version: "0.0.1"}, Enabled: true, Development: true, InstallPath: kitRoot, Manifest: "package.json", Source: contract.Source{Type: contract.PathSource, Path: kitRoot}}
	change, err = SetKitDevelopment(home, kit, change.Generation)
	if err != nil {
		t.Fatal(err)
	}
	result, err := Load(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Settings.Plugins) != 1 || len(result.Settings.Sidecars) != 1 || len(result.Settings.Kits) != 1 {
		t.Fatalf("settings=%+v", result.Settings)
	}
}

func TestDevelopmentSettingPreservesExistingEnabledState(t *testing.T) {
	home := t.TempDir()
	pluginRoot := fixtureDirectory(t, "plugin.json")
	sidecarRoot := fixtureDirectory(t, "sidecar.json")
	kitRoot := fixtureDirectory(t, "package.json")
	settings := contract.Settings{
		Spec: contract.SettingsSpec, Generation: 1,
		Plugins:  []contract.Plugin{{PluginRef: contract.PluginRef{ID: "p", Version: "0.0.1"}, Enabled: true, InstallPath: pluginRoot, Manifest: "plugin.json", Source: contract.Source{Type: contract.PathSource, Path: pluginRoot}}},
		Sidecars: []contract.Sidecar{{SidecarRef: contract.SidecarRef{ID: "s", Version: "0.0.1"}, Enabled: true, InstallPath: sidecarRoot, Manifest: "sidecar.json", Source: contract.Source{Type: contract.PathSource, Path: sidecarRoot}}},
		Kits:     []contract.Kit{{KitRef: contract.KitRef{ID: "k", Version: "0.0.1"}, Enabled: true, InstallPath: kitRoot, Manifest: "package.json", Source: contract.Source{Type: contract.PathSource, Path: kitRoot}}},
		Bindings: []contract.Binding{},
	}
	writeJSON(t, filepath.Join(home, contract.SettingsFile), settings)
	pluginDevelopment := fixtureDirectory(t, "plugin.json")
	change, err := SetPluginDevelopment(home, contract.Plugin{PluginRef: settings.Plugins[0].PluginRef, Development: true, InstallPath: pluginDevelopment, Manifest: "plugin.json", Source: contract.Source{Type: contract.PathSource, Path: pluginDevelopment}}, 1)
	if err != nil {
		t.Fatal(err)
	}
	sidecarDevelopment := fixtureDirectory(t, "sidecar.json")
	change, err = SetSidecarDevelopment(home, contract.Sidecar{SidecarRef: settings.Sidecars[0].SidecarRef, Development: true, InstallPath: sidecarDevelopment, Manifest: "sidecar.json", Source: contract.Source{Type: contract.PathSource, Path: sidecarDevelopment}}, change.Generation)
	if err != nil {
		t.Fatal(err)
	}
	kitDevelopment := fixtureDirectory(t, "package.json")
	if _, err := SetKitDevelopment(home, contract.Kit{KitRef: settings.Kits[0].KitRef, Development: true, InstallPath: kitDevelopment, Manifest: "package.json", Source: contract.Source{Type: contract.PathSource, Path: kitDevelopment}}, change.Generation); err != nil {
		t.Fatal(err)
	}
	result, err := Load(home)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Settings.Plugins[0].Enabled || !result.Settings.Sidecars[0].Enabled || !result.Settings.Kits[0].Enabled {
		t.Fatalf("development setting changed enabled state: %+v", result.Settings)
	}
}

func TestNewDevelopmentSettingDoesNotEnablePlugin(t *testing.T) {
	home := t.TempDir()
	root := fixtureDirectory(t, "plugin.json")
	plugin := contract.Plugin{
		PluginRef: contract.PluginRef{ID: "p", Version: "0.0.1"}, Development: true,
		InstallPath: root, Manifest: "plugin.json", Source: contract.Source{Type: contract.PathSource, Path: root},
	}
	if _, err := SetPluginDevelopment(home, plugin, 0); err != nil {
		t.Fatal(err)
	}
	result, err := Load(home)
	if err != nil {
		t.Fatal(err)
	}
	if result.Settings.Plugins[0].Enabled {
		t.Fatal("development setting enabled a new plugin")
	}
}
func fixtureDirectory(t *testing.T, manifest string) string {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, manifest), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	return root
}
