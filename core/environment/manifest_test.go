package environment

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

// TestADevelopmentPluginManifestIsReadOncePerOperation rewrites plugin.json
// between operations: the next operation answers the new version, and a
// manifest that parses for id and version but not as a plugin manifest makes
// the record broken. No operation answers
// install.transaction.pluginManifestInvalid for a development record.
func TestADevelopmentPluginManifestIsReadOncePerOperation(t *testing.T) {
	home := t.TempDir()
	writeJSON(t, filepath.Join(home, File), Empty())
	base := pluginSource(t, map[string]any{"id": "base", "version": "1.0.0"})
	if _, err := SetPluginDevelopment(home, "base", base, 1); err != nil {
		t.Fatal(err)
	}
	writeJSON(t, filepath.Join(base, "plugin.json"), map[string]any{"id": "base", "version": "1.1.0"})
	if _, err := SetPluginsEnabled(home, []PluginRef{{ID: "base", Version: "1.0.0"}}, true, 2); !os.IsNotExist(err) {
		t.Fatalf("recorded version error = %v", err)
	}
	if _, err := SetPluginsEnabled(home, []PluginRef{{ID: "base", Version: "1.1.0"}}, true, 2); err != nil {
		t.Fatalf("rewritten version refused: %v", err)
	}
	other := componentRoot(home, "plugin", "other")
	current, _, err := Read(home)
	if err != nil {
		t.Fatal(err)
	}
	installedPlugin(t, &current, "other", "0.0.1", other)
	writeJSON(t, filepath.Join(home, File), current)
	// id and version parse; runtimeDependencies does not.
	writeJSON(t, filepath.Join(base, "plugin.json"), map[string]any{"id": "base", "version": "1.1.0", "runtimeDependencies": "broken"})
	operations := []struct {
		name    string
		run     func(expected uint64) error
		wantKey string
	}{
		{"remove an installed plugin", func(expected uint64) error { _, err := RemovePlugin(home, "other", expected); return err }, ""},
		{"develop another plugin", func(expected uint64) error {
			_, err := SetPluginDevelopment(home, "view", pluginSource(t, map[string]any{"id": "view", "version": "0.1.0"}), expected)
			return err
		}, ""},
		{"develop a sidecar", func(expected uint64) error {
			_, err := SetSidecarDevelopment(home, "terminal-state", sidecarSource(t, "terminal-state", true), "aarch64-apple-darwin", expected)
			return err
		}, ""},
		{"disable the broken plugin", func(expected uint64) error {
			_, err := SetPluginsEnabled(home, []PluginRef{{ID: "base", Version: "1.1.0"}}, false, expected)
			return err
		}, ""},
		{"enable the broken plugin", func(expected uint64) error {
			_, err := SetPluginsEnabled(home, []PluginRef{{ID: "base", Version: "1.1.0"}}, true, expected)
			return err
		}, "environment.develop.directoryUnavailable"},
		{"remove the broken plugin", func(expected uint64) error { _, err := RemovePlugin(home, "base", expected); return err }, ""},
	}
	for _, operation := range operations {
		before, _, err := Read(home)
		if err != nil {
			t.Fatal(err)
		}
		err = operation.run(before.Revision)
		var refusal *i18n.Error
		if errors.As(err, &refusal) && refusal.Key == "install.transaction.pluginManifestInvalid" {
			t.Fatalf("%s: development record answered pluginManifestInvalid: %v", operation.name, err)
		}
		if operation.wantKey == "" && err != nil {
			t.Fatalf("%s: %v", operation.name, err)
		}
		if operation.wantKey != "" {
			assertRefusalKey(t, err, operation.wantKey, "plugin", "base", base)
		}
	}
}

func TestADevelopmentSidecarWhoseManifestFailsTheSpecParseIsBroken(t *testing.T) {
	home := t.TempDir()
	root := sidecarSource(t, "terminal-state", true)
	value := Empty()
	value.Sidecars["terminal-state"] = Component{Version: "0.2.0", Path: root, Source: "development", Target: "aarch64-apple-darwin"}
	value.Plugins["terminal"] = Plugin{Component: Component{Version: "0.1.0", Path: pluginSource(t, map[string]any{
		"id": "terminal", "version": "0.1.0",
		"runtimeDependencies": map[string]any{"sidecars": []map[string]any{{"id": "terminal-state", "version": "0.2.0"}}},
	}), Source: "development"}}
	writeJSON(t, filepath.Join(home, File), value)
	if err := ValidatePluginDependencies(value, nil); err != nil {
		t.Fatalf("valid sidecar manifest refused: %v", err)
	}
	// id and version parse; the interface version is not strict SemVer.
	writeJSON(t, filepath.Join(root, "sidecar.json"), map[string]any{"id": "terminal-state", "version": "0.2.0", "interface": []map[string]string{{"id": "terminal-state", "version": "v0.0.2"}}, "process": "dist/terminal-state"})
	_, err := ResolveSidecarVersion(home, "terminal-state", "0.2.0")
	assertRefusalKey(t, err, "environment.develop.directoryUnavailable", "sidecar", "terminal-state", root)
	err = ValidatePluginDependencies(value, nil)
	assertRefusalKey(t, err, "install.transaction.dependencyVersionConflict", "terminal-state", "missing")
}
func TestReadRecordManifestNeverAnswersARawFileError(t *testing.T) {
	for _, kind := range []string{"plugin", "sidecar"} {
		root := t.TempDir()
		_, err := readRecordManifest(kind, "demo", Component{Path: root, Source: "development"})
		assertRefusalKey(t, err, "environment.develop.directoryUnavailable", kind, "demo", root)
		if errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s: os.ErrNotExist was returned to the caller: %v", kind, err)
		}
		if !strings.Contains(err.Error(), kind+".json") {
			t.Fatalf("%s: error does not name the manifest: %v", kind, err)
		}
	}
}

// A conflict the environment already holds (a development manifest edited on disk after its record
// was written) is reported by the runtime; it does not block an unrelated write. A write that
// introduces a conflict is refused.
func TestDependencyTransitionRefusesOnlyTheConflictItIntroduces(t *testing.T) {
	before := Empty()
	before.Sidecars["terminal-state"] = Component{Version: "0.0.7", Path: "/installed/terminal-state", Source: "local", Target: "aarch64-apple-darwin"}
	before.Plugins["terminal"] = Plugin{Component: Component{Version: "0.1.0", Path: pluginSource(t, map[string]any{
		"id": "terminal", "version": "0.1.0",
		"runtimeDependencies": map[string]any{"sidecars": []map[string]any{{"id": "terminal-state", "version": "0.0.8"}}},
	}), Source: "development"}}
	before.Plugins["other"] = Plugin{Component: Component{Version: "1.0.0", Path: pluginSource(t, map[string]any{"id": "other", "version": "1.0.0"}), ArtifactSHA256: strings.Repeat("a", 64), Source: "local"}}
	after := before
	after.Plugins = map[string]Plugin{"terminal": before.Plugins["terminal"]}
	if err := ValidateDependencyTransition(before, after, nil); err != nil {
		t.Fatalf("removing an unrelated plugin was refused for a conflict the environment already held: %v", err)
	}
	if err := ValidatePluginDependencies(after, nil); err == nil {
		t.Fatal("the conflict itself is not reported")
	}
	introduced := before
	introduced.Sidecars = map[string]Component{}
	introduced.Plugins = map[string]Plugin{"other": before.Plugins["other"], "viewer": {Component: Component{Version: "0.2.0", Path: pluginSource(t, map[string]any{
		"id": "viewer", "version": "0.2.0",
		"runtimeDependencies": map[string]any{"plugins": []map[string]any{{"id": "other", "version": "2.0.0"}}},
	}), ArtifactSHA256: strings.Repeat("b", 64), Source: "local"}}}
	err := ValidateDependencyTransition(before, introduced, nil)
	assertRefusalKey(t, err, "install.transaction.dependencyVersionConflict", "viewer", "other")
}

func TestCloneSharesNoMapWithItsSource(t *testing.T) {
	value := Empty()
	value.Plugins["a"] = Plugin{Component: Component{Version: "1.0.0"}}
	next := Clone(value)
	delete(next.Plugins, "a")
	next.Sidecars["s"] = Component{Version: "1.0.0"}
	if _, kept := value.Plugins["a"]; !kept || len(value.Sidecars) != 0 {
		t.Fatalf("source changed through the clone: %+v", value)
	}
}
