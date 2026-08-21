package composition

import (
	"os"
	"path/filepath"
	"testing"

	contract "github.com/soksak-ai/soksak-contract-composition"
)

func TestPluginManifestsReadOnlyDeclaredSettingsPaths(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	body := []byte(`{"spec":"soksak-spec-plugin@0.0.1","id":"view","version":"0.0.1"}`)
	if err := os.WriteFile(filepath.Join(root, "plugin.json"), body, 0o600); err != nil {
		t.Fatal(err)
	}
	settings := contract.Settings{
		Spec: contract.SettingsSpec, Generation: 3,
		Plugins: []contract.Plugin{{
			PluginRef: contract.PluginRef{ID: "view", Version: "0.0.1"}, Enabled: true, Development: true,
			InstallPath: root, Manifest: "plugin.json", Source: contract.Source{Type: contract.PathSource, Path: root},
		}},
		Sidecars: []contract.Sidecar{}, Kits: []contract.Kit{}, Bindings: []contract.Binding{},
	}
	writeJSON(t, filepath.Join(home, contract.SettingsFile), settings)
	records, err := PluginManifests(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 || records[0].ID != "view" || records[0].InstallPath != root || records[0].Manifest == nil || *records[0].Manifest != string(body) || records[0].Error != nil {
		t.Fatalf("records=%+v", records)
	}
}

func TestPluginManifestsReportBrokenDeclaredPathWithoutSubstitution(t *testing.T) {
	home := t.TempDir()
	missing := filepath.Join(t.TempDir(), "missing")
	settings := contract.Settings{
		Spec: contract.SettingsSpec, Generation: 1,
		Plugins: []contract.Plugin{{
			PluginRef: contract.PluginRef{ID: "missing", Version: "0.0.1"}, InstallPath: missing, Manifest: "plugin.json",
			Source: contract.Source{Type: contract.PathSource, Path: missing},
		}},
		Sidecars: []contract.Sidecar{}, Kits: []contract.Kit{}, Bindings: []contract.Binding{},
	}
	writeJSON(t, filepath.Join(home, contract.SettingsFile), settings)
	records, err := PluginManifests(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 || records[0].Manifest != nil || records[0].Error == nil {
		t.Fatalf("records=%+v", records)
	}
}
