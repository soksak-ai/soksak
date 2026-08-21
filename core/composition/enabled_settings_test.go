package composition

import (
	"encoding/json"
	"path/filepath"
	"testing"

	contract "github.com/soksak-ai/soksak-contract-composition"
	"github.com/soksak-ai/soksak-core/core/control"
)

func TestSetPluginsEnabledUpdatesExactPluginsInOneGeneration(t *testing.T) {
	home := t.TempDir()
	firstRoot := fixtureDirectory(t, "plugin.json")
	secondRoot := fixtureDirectory(t, "plugin.json")
	settings := contract.Settings{
		Spec: contract.SettingsSpec, Generation: 4,
		Plugins: []contract.Plugin{
			{PluginRef: contract.PluginRef{ID: "first", Version: "0.0.1"}, InstallPath: firstRoot, Manifest: "plugin.json", Source: contract.Source{Type: contract.PathSource, Path: firstRoot}},
			{PluginRef: contract.PluginRef{ID: "second", Version: "0.0.1"}, InstallPath: secondRoot, Manifest: "plugin.json", Source: contract.Source{Type: contract.PathSource, Path: secondRoot}},
		},
		Sidecars: []contract.Sidecar{}, Kits: []contract.Kit{}, Bindings: []contract.Binding{},
	}
	writeJSON(t, filepath.Join(home, contract.SettingsFile), settings)
	change, err := SetPluginsEnabled(home, []contract.PluginRef{settings.Plugins[0].PluginRef, settings.Plugins[1].PluginRef}, true, 4)
	if err != nil {
		t.Fatal(err)
	}
	if change.PreviousGeneration != 4 || change.Generation != 5 {
		t.Fatalf("change=%+v", change)
	}
	result, err := Load(home)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Settings.Plugins[0].Enabled || !result.Settings.Plugins[1].Enabled {
		t.Fatalf("plugins=%+v", result.Settings.Plugins)
	}
}

func TestPluginEnabledCommandPublishesOneSettingsChange(t *testing.T) {
	home, plugin := fixture(t)
	registry := control.NewRegistry()
	var events []contract.Change
	Register(registry, Deps{Home: home, Changed: func(event string, payload any) {
		if event != contract.ChangeEvent {
			t.Fatalf("event=%s", event)
		}
		events = append(events, payload.(contract.Change))
	}})
	encode := func(value any) json.RawMessage {
		body, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return body
	}
	value, err := registry.Invoke("plugin_enabled_set", control.Args{
		"plugins": encode([]contract.PluginRef{plugin.PluginRef}),
		"enabled": encode(false), "expectedGeneration": encode(uint64(7)),
	})
	if err != nil {
		t.Fatal(err)
	}
	change := value.(contract.Change)
	if len(events) != 1 || events[0] != change || change.Generation != 8 {
		t.Fatalf("events=%+v change=%+v", events, change)
	}
}

func TestSetPluginsEnabledRejectsMissingExactPluginWithoutWriting(t *testing.T) {
	home, plugin := fixture(t)
	_, err := SetPluginsEnabled(home, []contract.PluginRef{
		plugin.PluginRef,
		{ID: plugin.ID, Version: "0.0.2"},
	}, false, 7)
	if err == nil {
		t.Fatal("missing exact plugin was accepted")
	}
	result, loadErr := Load(home)
	if loadErr != nil {
		t.Fatal(loadErr)
	}
	if result.Settings.Generation != 7 || !result.Settings.Plugins[0].Enabled {
		t.Fatalf("settings changed after rejection: %+v", result.Settings)
	}
}
