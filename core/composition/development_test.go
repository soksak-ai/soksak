package composition

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	contract "github.com/soksak-ai/soksak-contract-composition"
	"github.com/soksak-ai/soksak-core/core/control"
)

func TestDevelopmentSetCreatesAndUpdatesSettings(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(t.TempDir(), "plugin")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	unit := contract.UnitRef{Kind: contract.Plugin, ID: "demo", Version: "0.0.1"}
	manifest := contract.UnitManifest{Spec: contract.UnitSpec, UnitRef: unit, Dependencies: []contract.UnitRef{}, Implements: []contract.ContractRef{}, Consumes: []contract.Requirement{}, Entrypoints: []contract.Entrypoint{{Role: "plugin", Path: "plugin.json"}}}
	writeJSON(t, filepath.Join(root, contract.UnitManifestFile), manifest)
	if err := os.WriteFile(filepath.Join(root, "plugin.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	registry := control.NewRegistry()
	var events []string
	Register(registry, Deps{Home: home, Changed: func(event string, _ any) { events = append(events, event) }})
	value, err := registry.Invoke("composition_development_set", compositionArgs(t, map[string]any{"kind": "plugin", "id": "demo", "version": "0.0.1", "path": root, "enabled": true, "expectedGeneration": uint64(0)}))
	if err != nil {
		t.Fatal(err)
	}
	if value.(contract.Change).Generation != 1 || len(events) != 1 || events[0] != contract.ChangeEvent {
		t.Fatalf("value=%+v events=%v", value, events)
	}
	body, err := os.ReadFile(filepath.Join(home, contract.SettingsFile))
	if err != nil {
		t.Fatal(err)
	}
	settings, err := contract.ParseSettings(body)
	if err != nil {
		t.Fatal(err)
	}
	if settings.Installations[0].Mode != contract.Development || settings.Installations[0].Source.Path != root || !settings.Plugins[0].Enabled {
		t.Fatalf("settings=%+v", settings)
	}
}

func TestDevelopmentSetRejectsSymlinkAndIdentityMismatch(t *testing.T) {
	home := t.TempDir()
	real := filepath.Join(t.TempDir(), "plugin")
	if err := os.MkdirAll(real, 0o700); err != nil {
		t.Fatal(err)
	}
	unit := contract.UnitRef{Kind: contract.Plugin, ID: "actual", Version: "0.0.1"}
	manifest := contract.UnitManifest{Spec: contract.UnitSpec, UnitRef: unit, Dependencies: []contract.UnitRef{}, Implements: []contract.ContractRef{}, Consumes: []contract.Requirement{}, Entrypoints: []contract.Entrypoint{{Role: "plugin", Path: "plugin.json"}}}
	writeJSON(t, filepath.Join(real, contract.UnitManifestFile), manifest)
	link := filepath.Join(t.TempDir(), "linked")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	registry := control.NewRegistry()
	Register(registry, Deps{Home: home})
	for _, path := range []string{link, real} {
		_, err := registry.Invoke("composition_development_set", compositionArgs(t, map[string]any{"kind": "plugin", "id": "wrong", "version": "0.0.1", "path": path, "enabled": true, "expectedGeneration": uint64(0)}))
		if err == nil {
			t.Errorf("accepted path %s", path)
		}
	}
}

func compositionArgs(t *testing.T, values map[string]any) control.Args {
	t.Helper()
	args := control.Args{}
	for key, value := range values {
		body, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		args[key] = body
	}
	return args
}
