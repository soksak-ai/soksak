package environment

import (
	"encoding/json"
	"testing"
)

func TestEnvironmentRejectsRegistryProvenance(t *testing.T) {
	raw := map[string]any{"revision": 1, "plugins": map[string]any{"demo": map[string]any{"version": "0.0.1", "path": "/installed", "source": "registry", "registry": "official", "repository": "https://github.com/example/demo", "enabled": true}}, "sidecars": map[string]any{}, "kits": map[string]any{}, "contracts": map[string]any{}, "specs": map[string]any{}}
	body, _ := json.Marshal(raw)
	if _, err := Parse(body); err == nil {
		t.Fatal("environment accepted registry provenance")
	}
}

func TestEnvironmentAcceptsLocalMaterializationAndUserChoices(t *testing.T) {
	raw := map[string]any{"revision": 1, "plugins": map[string]any{"demo": map[string]any{"version": "0.0.1", "path": "/installed", "source": "registry", "registry": "official", "enabled": true}}, "sidecars": map[string]any{}, "kits": map[string]any{}, "contracts": map[string]any{}, "specs": map[string]any{}}
	body, _ := json.Marshal(raw)
	if _, err := Parse(body); err != nil {
		t.Fatal(err)
	}
}

func TestEmptyEnvironmentValidates(t *testing.T) {
	if err := Validate(Empty()); err != nil {
		t.Fatal(err)
	}
}
