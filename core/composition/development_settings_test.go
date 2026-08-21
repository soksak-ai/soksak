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
func fixtureDirectory(t *testing.T, manifest string) string {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, manifest), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	return root
}
