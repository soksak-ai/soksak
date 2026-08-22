package settings

import (
	"encoding/json"
	"testing"
)

func TestSettingsRejectInstallResults(t *testing.T) {
	raw := map[string]any{"revision": 1, "plugins": map[string]any{"demo": map[string]any{"enabled": true, "installPath": "/installed"}}, "sidecars": map[string]any{}, "kits": map[string]any{}, "contracts": map[string]any{}, "specs": map[string]any{}}
	body, _ := json.Marshal(raw)
	if _, err := Parse(body); err == nil {
		t.Fatal("settings accepted install result")
	}
}

func TestInstalledRejectsUserChoices(t *testing.T) {
	raw := map[string]any{"revision": 1, "plugins": map[string]any{"demo": map[string]any{"version": "0.0.1", "path": "/installed", "registryId": "official", "repository": "https://github.com/example/demo", "sourceCommit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "manifestSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "artifactSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", "enabled": true}}, "sidecars": map[string]any{}, "kits": map[string]any{}, "contracts": map[string]any{}, "specs": map[string]any{}}
	body, _ := json.Marshal(raw)
	if _, err := ParseInstalled(body); err == nil {
		t.Fatal("installed state accepted user choice")
	}
}

func TestEmptyDocumentsValidate(t *testing.T) {
	if err := Validate(Empty()); err != nil {
		t.Fatal(err)
	}
	if err := ValidateInstalled(EmptyInstalled()); err != nil {
		t.Fatal(err)
	}
}

func TestInstalledAcceptsStrictComponentPatchVersions(t *testing.T) {
	raw := map[string]any{"revision": 1, "plugins": map[string]any{"terminal-ghostty": map[string]any{"version": "0.0.2", "path": "/installed/ghostty", "registryId": "official", "repository": "https://github.com/example/ghostty", "sourceCommit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "manifestSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "artifactSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}}, "sidecars": map[string]any{}, "kits": map[string]any{}, "contracts": map[string]any{}, "specs": map[string]any{}}
	body, _ := json.Marshal(raw)
	if _, err := ParseInstalled(body); err != nil {
		t.Fatal(err)
	}
}
