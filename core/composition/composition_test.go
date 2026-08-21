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

func fixture(t *testing.T) (string, contract.Settings, contract.UnitRef) {
	t.Helper()
	home := t.TempDir()
	unit := contract.UnitRef{Kind: contract.Plugin, ID: "demo", Version: "0.0.1"}
	root := filepath.Join(t.TempDir(), "demo")
	settings := contract.Settings{
		Spec: contract.SettingsSpec, Generation: 7,
		Installations: []contract.Installation{{
			UnitRef: unit, Mode: contract.Development, InstallPath: root,
			Manifest: contract.UnitManifestFile, Source: contract.Source{Type: contract.PathSource, Path: root},
		}},
		Plugins:  []contract.PluginSelection{{Plugin: unit, Enabled: true}},
		Bindings: []contract.Binding{},
	}
	manifest := contract.UnitManifest{
		Spec: contract.UnitSpec, UnitRef: unit,
		Dependencies: []contract.UnitRef{}, Implements: []contract.ContractRef{}, Consumes: []contract.Requirement{},
		Entrypoints: []contract.Entrypoint{{Role: "plugin", Path: "plugin.json"}},
	}
	writeJSON(t, filepath.Join(home, contract.SettingsFile), settings)
	writeJSON(t, filepath.Join(root, contract.UnitManifestFile), manifest)
	return home, settings, unit
}

func TestLoadReadsSettingsAndDeclaredManifests(t *testing.T) {
	home, settings, unit := fixture(t)
	result, err := Load(home)
	if err != nil {
		t.Fatal(err)
	}
	if result.Settings.Generation != settings.Generation {
		t.Fatalf("generation = %d", result.Settings.Generation)
	}
	if len(result.Graph.Nodes) != 1 || result.Graph.Nodes[0].UnitRef != unit || result.Graph.Nodes[0].Status != contract.Resolved {
		t.Fatalf("graph = %+v", result.Graph)
	}
}

func TestLoadRejectsSymlinkedInstallPaths(t *testing.T) {
	home, settings, _ := fixture(t)
	real := settings.Installations[0].InstallPath
	link := filepath.Join(t.TempDir(), "linked")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	settings.Installations[0].InstallPath = link
	settings.Installations[0].Source.Path = link
	writeJSON(t, filepath.Join(home, contract.SettingsFile), settings)
	result, err := Load(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Graph.Nodes) != 1 || result.Graph.Nodes[0].Status != contract.Rejected {
		t.Fatalf("symlinked unit graph = %+v", result.Graph)
	}
}

func TestLoadRefusesMissingSettings(t *testing.T) {
	if _, err := Load(t.TempDir()); err == nil {
		t.Fatal("missing settings answered an empty composition")
	}
}

func TestCommandsExposeOneCompositionResult(t *testing.T) {
	home, _, _ := fixture(t)
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
	if settings.Generation != 7 || status.Generation != 7 || len(graph.Nodes) != status.Units || status.Active != 1 || status.Development != 1 {
		t.Fatalf("settings=%+v graph=%+v status=%+v", settings, graph, status)
	}
}
