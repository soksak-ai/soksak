package environment

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func pluginSource(t *testing.T, manifest map[string]any) string {
	t.Helper()
	root := t.TempDir()
	writeJSON(t, filepath.Join(root, "plugin.json"), manifest)
	if err := os.WriteFile(filepath.Join(root, "main.js"), []byte("export default {}"), 0o600); err != nil {
		t.Fatal(err)
	}
	return root
}

func sidecarSource(t *testing.T, id string, withBinary bool) string {
	t.Helper()
	root := t.TempDir()
	writeJSON(t, filepath.Join(root, "sidecar.json"), map[string]any{"id": id, "version": "0.2.0", "interface": map[string]string{"id": "terminal-state", "version": "0.0.1"}, "process": "dist/" + id})
	if withBinary {
		if err := os.MkdirAll(filepath.Join(root, "dist"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "dist", id), []byte("binary"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestPluginDevelopCreatesRecord(t *testing.T) {
	home := t.TempDir()
	writeJSON(t, filepath.Join(home, File), Empty())
	root := pluginSource(t, map[string]any{"id": "demo", "version": "0.1.0"})
	change, err := SetPluginDevelopment(home, "demo", root, 1)
	if err != nil {
		t.Fatal(err)
	}
	if change != (Change{PreviousRevision: 1, Revision: 2}) {
		t.Fatalf("change=%+v", change)
	}
	value, _, err := Read(home)
	if err != nil {
		t.Fatal(err)
	}
	want := Plugin{Component: Component{Version: "0.1.0", Path: root, Source: "development"}}
	if value.Plugins["demo"] != want {
		t.Fatalf("record=%+v want=%+v", value.Plugins["demo"], want)
	}
}

func TestPluginDevelopRejectsManifestIDMismatch(t *testing.T) {
	home := t.TempDir()
	writeJSON(t, filepath.Join(home, File), Empty())
	root := pluginSource(t, map[string]any{"id": "other", "version": "0.1.0"})
	_, err := SetPluginDevelopment(home, "demo", root, 1)
	assertRefusalKey(t, err, "environment.develop.directoryUnavailable", "plugin", "demo", root, "plugin.json declares id other")
}

func TestPluginDevelopReplacesLocalRecord(t *testing.T) {
	home := t.TempDir()
	installed := t.TempDir()
	writeJSON(t, filepath.Join(installed, "plugin.json"), map[string]any{"id": "demo", "version": "0.0.1"})
	value := Empty()
	value.Plugins["demo"] = Plugin{Component: Component{Version: "0.0.1", Path: installed, ArtifactSHA256: strings.Repeat("a", 64), Source: "local"}, Enabled: true}
	writeJSON(t, filepath.Join(home, File), value)
	root := pluginSource(t, map[string]any{"id": "demo", "version": "0.1.0"})
	if _, err := SetPluginDevelopment(home, "demo", root, 1); err != nil {
		t.Fatal(err)
	}
	after, _, err := Read(home)
	if err != nil {
		t.Fatal(err)
	}
	want := Plugin{Component: Component{Version: "0.1.0", Path: root, Source: "development"}, Enabled: true}
	if after.Plugins["demo"] != want {
		t.Fatalf("record=%+v want=%+v", after.Plugins["demo"], want)
	}
	if _, err := os.Stat(filepath.Join(installed, "plugin.json")); err != nil {
		t.Fatalf("installed artifact directory was touched: %v", err)
	}
}

func TestPluginDevelopRejectsDependencyConflict(t *testing.T) {
	home := t.TempDir()
	writeJSON(t, filepath.Join(home, File), Empty())
	root := pluginSource(t, map[string]any{
		"id": "terminal", "version": "0.1.0",
		"runtimeDependencies": map[string]any{"sidecars": []map[string]any{{"id": "terminal-state", "version": "0.0.12"}}},
	})
	_, err := SetPluginDevelopment(home, "terminal", root, 1)
	if err == nil || !strings.Contains(err.Error(), "DEPENDENCY_VERSION_CONFLICT") || !strings.Contains(err.Error(), "terminal-state") {
		t.Fatalf("error = %v", err)
	}
	after, _, readErr := Read(home)
	if readErr != nil || after.Revision != 1 || len(after.Plugins) != 0 {
		t.Fatalf("environment changed after conflict: %+v err=%v", after, readErr)
	}
}

func TestSidecarDevelopRequiresDistBinary(t *testing.T) {
	home := t.TempDir()
	writeJSON(t, filepath.Join(home, File), Empty())
	missing := sidecarSource(t, "terminal-state", false)
	if _, err := SetSidecarDevelopment(home, "terminal-state", missing, "aarch64-apple-darwin", 1); err == nil {
		t.Fatal("sidecar without dist/<id> was accepted")
	}
	root := sidecarSource(t, "terminal-state", true)
	if _, err := SetSidecarDevelopment(home, "terminal-state", root, "aarch64-apple-darwin", 1); err != nil {
		t.Fatal(err)
	}
	after, _, err := Read(home)
	if err != nil {
		t.Fatal(err)
	}
	want := Component{Version: "0.2.0", Path: root, Source: "development", Target: "aarch64-apple-darwin"}
	if after.Sidecars["terminal-state"] != want {
		t.Fatalf("record=%+v want=%+v", after.Sidecars["terminal-state"], want)
	}
}

func TestDevelopRejectsARelativePath(t *testing.T) {
	home := t.TempDir()
	writeJSON(t, filepath.Join(home, File), Empty())
	if _, err := SetPluginDevelopment(home, "demo", "relative/plugin", 1); err == nil {
		t.Fatal("relative plugin path was accepted")
	}
	if _, err := SetSidecarDevelopment(home, "demo", "relative/sidecar", "aarch64-apple-darwin", 1); err == nil {
		t.Fatal("relative sidecar path was accepted")
	}
}

func TestDevelopRejectsARevisionConflict(t *testing.T) {
	home := t.TempDir()
	writeJSON(t, filepath.Join(home, File), Empty())
	root := pluginSource(t, map[string]any{"id": "demo", "version": "0.1.0"})
	var conflict ErrRevisionConflict
	if _, err := SetPluginDevelopment(home, "demo", root, 5); !errors.As(err, &conflict) {
		t.Fatalf("error = %v", err)
	}
	if _, err := SetPluginDevelopment(home, "demo", root, 1); err != nil {
		t.Fatal(err)
	}
	after, _, err := Read(home)
	if err != nil || after.Revision != 2 || after.Plugins["demo"].Source != "development" {
		t.Fatalf("environment changed: %+v err=%v", after, err)
	}
}

func TestValidatePluginDependenciesReadsStagedRoots(t *testing.T) {
	installed := t.TempDir()
	writeJSON(t, filepath.Join(installed, "plugin.json"), map[string]any{"id": "view", "version": "0.0.1"})
	staged := t.TempDir()
	writeJSON(t, filepath.Join(staged, "plugin.json"), map[string]any{
		"id": "view", "version": "0.0.2",
		"runtimeDependencies": map[string]any{"plugins": []map[string]any{{"id": "base", "version": "1.0.0"}}},
	})
	value := Empty()
	value.Plugins["view"] = Plugin{Component: Component{Version: "0.0.2", Path: installed, ArtifactSHA256: strings.Repeat("a", 64), Source: "local"}}
	err := ValidatePluginDependencies(value, map[string]string{"view": staged})
	if err == nil || !strings.Contains(err.Error(), "DEPENDENCY_VERSION_CONFLICT") || !strings.Contains(err.Error(), "base") {
		t.Fatalf("error = %v", err)
	}
	value.Plugins["base"] = Plugin{Component: Component{Version: "1.0.0", Path: pluginSource(t, map[string]any{"id": "base", "version": "1.0.0"}), Source: "development"}}
	if err := ValidatePluginDependencies(value, map[string]string{"view": staged}); err != nil {
		t.Fatal(err)
	}
}

func TestValidatePluginDependenciesUsesTheDiskVersionOfADevelopmentRecord(t *testing.T) {
	base := pluginSource(t, map[string]any{"id": "base", "version": "1.1.0"})
	value := Empty()
	// The record keeps the version read at develop time; plugin.json moved on afterwards.
	value.Plugins["base"] = Plugin{Component: Component{Version: "1.0.0", Path: base, Source: "development"}}
	value.Plugins["view"] = Plugin{Component: Component{Version: "0.1.0", Path: pluginSource(t, map[string]any{
		"id": "view", "version": "0.1.0",
		"runtimeDependencies": map[string]any{"plugins": []map[string]any{{"id": "base", "version": "1.1.0"}}},
	}), Source: "development"}}
	if err := ValidatePluginDependencies(value, nil); err != nil {
		t.Fatalf("dependent on the disk version refused: %v", err)
	}
	value.Plugins["view"] = Plugin{Component: Component{Version: "0.1.0", Path: pluginSource(t, map[string]any{
		"id": "view", "version": "0.1.0",
		"runtimeDependencies": map[string]any{"plugins": []map[string]any{{"id": "base", "version": "1.0.0"}}},
	}), Source: "development"}}
	err := ValidatePluginDependencies(value, nil)
	if err == nil || !strings.Contains(err.Error(), "DEPENDENCY_VERSION_CONFLICT") || !strings.Contains(err.Error(), "1.1.0") {
		t.Fatalf("dependent on the recorded version accepted: %v", err)
	}
}

func TestValidatePluginDependenciesKeepsTheIdentityCheckForInstalledRecords(t *testing.T) {
	base := pluginSource(t, map[string]any{"id": "base", "version": "1.1.0"})
	value := Empty()
	value.Plugins["base"] = Plugin{Component: Component{Version: "1.0.0", Path: base, ArtifactSHA256: strings.Repeat("a", 64), Source: "local"}}
	err := ValidatePluginDependencies(value, nil)
	assertRefusalKey(t, err, "install.transaction.pluginManifestInvalid", "base")
}

func TestValidatePluginDependenciesUsesTheDiskVersionOfADevelopmentSidecar(t *testing.T) {
	sidecar := sidecarSource(t, "terminal-state", true)
	value := Empty()
	// The record keeps the version read at develop time; sidecar.json moved on afterwards.
	value.Sidecars["terminal-state"] = Component{Version: "0.1.0", Path: sidecar, Source: "development", Target: "aarch64-apple-darwin"}
	value.Plugins["terminal"] = Plugin{Component: Component{Version: "0.1.0", Path: pluginSource(t, map[string]any{
		"id": "terminal", "version": "0.1.0",
		"runtimeDependencies": map[string]any{"sidecars": []map[string]any{{"id": "terminal-state", "version": "0.2.0"}}},
	}), Source: "development"}}
	if err := ValidatePluginDependencies(value, nil); err != nil {
		t.Fatalf("dependent on the disk version refused: %v", err)
	}
	value.Plugins["terminal"] = Plugin{Component: Component{Version: "0.1.0", Path: pluginSource(t, map[string]any{
		"id": "terminal", "version": "0.1.0",
		"runtimeDependencies": map[string]any{"sidecars": []map[string]any{{"id": "terminal-state", "version": "0.1.0"}}},
	}), Source: "development"}}
	err := ValidatePluginDependencies(value, nil)
	if err == nil || !strings.Contains(err.Error(), "DEPENDENCY_VERSION_CONFLICT") || !strings.Contains(err.Error(), "0.2.0") {
		t.Fatalf("dependent on the recorded version accepted: %v", err)
	}
}

// brokenDevelopmentPlugin registers plugin id from a development directory and deletes that directory.
func brokenDevelopmentPlugin(t *testing.T, home, id string, expected uint64) string {
	t.Helper()
	root := pluginSource(t, map[string]any{"id": id, "version": "1.0.0"})
	if _, err := SetPluginDevelopment(home, id, root, expected); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(root); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestABrokenDevelopmentPluginIsAbsentForDependentsAndBlocksNoOtherWrite(t *testing.T) {
	home := t.TempDir()
	writeJSON(t, filepath.Join(home, File), Empty())
	root := brokenDevelopmentPlugin(t, home, "base", 1)
	other := componentRoot(home, "plugin", "other")
	current, _, err := Read(home)
	if err != nil {
		t.Fatal(err)
	}
	installedPlugin(t, &current, "other", "0.0.1", other)
	writeJSON(t, filepath.Join(home, File), current)
	if _, err := RemovePlugin(home, "other", 2); err != nil {
		t.Fatalf("unrelated remove refused: %v", err)
	}
	sidecar := sidecarSource(t, "terminal-state", true)
	if _, err := SetSidecarDevelopment(home, "terminal-state", sidecar, "aarch64-apple-darwin", 3); err != nil {
		t.Fatalf("unrelated sidecar develop refused: %v", err)
	}
	_, err = SetPluginsEnabled(home, []PluginRef{{ID: "base", Version: "1.0.0"}}, true, 4)
	assertRefusalKey(t, err, "environment.develop.directoryUnavailable", "plugin", "base", root)
	view := pluginSource(t, map[string]any{
		"id": "view", "version": "0.1.0",
		"runtimeDependencies": map[string]any{"plugins": []map[string]any{{"id": "base", "version": "1.0.0"}}},
	})
	_, err = SetPluginDevelopment(home, "view", view, 4)
	assertRefusalKey(t, err, "install.transaction.dependencyVersionConflict", "DEPENDENCY_VERSION_CONFLICT", "base", "missing")
	after, _, readErr := Read(home)
	if readErr != nil || after.Revision != 4 || after.Plugins["base"].Path != root {
		t.Fatalf("environment=%+v err=%v", after, readErr)
	}
}

func TestADevelopmentRecordWhoseManifestDeclaresAnotherIDIsBroken(t *testing.T) {
	moved := pluginSource(t, map[string]any{"id": "other", "version": "1.0.0"})
	value := Empty()
	value.Plugins["base"] = Plugin{Component: Component{Version: "1.0.0", Path: moved, Source: "development"}}
	if err := ValidatePluginDependencies(value, nil); err != nil {
		t.Fatalf("broken record blocked validation: %v", err)
	}
	value.Plugins["view"] = Plugin{Component: Component{Version: "0.1.0", Path: pluginSource(t, map[string]any{
		"id": "view", "version": "0.1.0",
		"runtimeDependencies": map[string]any{"plugins": []map[string]any{{"id": "base", "version": "1.0.0"}}},
	}), Source: "development"}}
	err := ValidatePluginDependencies(value, nil)
	assertRefusalKey(t, err, "install.transaction.dependencyVersionConflict", "base", "missing")
}

// pluginSourceWithoutMain writes plugin.json only.
func pluginSourceWithoutMain(t *testing.T, manifest map[string]any) string {
	t.Helper()
	root := t.TempDir()
	writeJSON(t, filepath.Join(root, "plugin.json"), manifest)
	return root
}

func TestPluginDevelopFollowsTheManifestEntry(t *testing.T) {
	home := t.TempDir()
	writeJSON(t, filepath.Join(home, File), Empty())
	t.Run("absent key requires main.js", func(t *testing.T) {
		root := pluginSourceWithoutMain(t, map[string]any{"id": "demo", "version": "0.1.0"})
		if _, err := SetPluginDevelopment(home, "demo", root, 1); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("null entry needs no file", func(t *testing.T) {
		root := pluginSourceWithoutMain(t, map[string]any{"id": "demo", "version": "0.1.0", "entry": nil})
		if _, err := SetPluginDevelopment(home, "demo", root, 1); err != nil {
			t.Fatal(err)
		}
		if _, err := RemovePlugin(home, "demo", 2); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("string entry requires that file", func(t *testing.T) {
		root := pluginSourceWithoutMain(t, map[string]any{"id": "demo", "version": "0.1.0", "entry": "dist/main.js"})
		if _, err := SetPluginDevelopment(home, "demo", root, 3); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("error = %v", err)
		}
		if err := os.MkdirAll(filepath.Join(root, "dist"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "dist", "main.js"), []byte("export default {}"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := SetPluginDevelopment(home, "demo", root, 3); err != nil {
			t.Fatal(err)
		}
		if _, err := RemovePlugin(home, "demo", 4); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("string entry is trimmed", func(t *testing.T) {
		root := pluginSource(t, map[string]any{"id": "demo", "version": "0.1.0", "entry": " main.js "})
		if _, err := SetPluginDevelopment(home, "demo", root, 5); err != nil {
			t.Fatal(err)
		}
		if _, err := RemovePlugin(home, "demo", 6); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("mjs entry requires that file", func(t *testing.T) {
		root := pluginSourceWithoutMain(t, map[string]any{"id": "demo", "version": "0.1.0", "entry": "dist/app.mjs"})
		if _, err := SetPluginDevelopment(home, "demo", root, 7); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("error = %v", err)
		}
		if err := os.MkdirAll(filepath.Join(root, "dist"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "dist", "app.mjs"), []byte("export default {}"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := SetPluginDevelopment(home, "demo", root, 7); err != nil {
			t.Fatal(err)
		}
		if _, err := RemovePlugin(home, "demo", 8); err != nil {
			t.Fatal(err)
		}
	})
	for name, entry := range map[string]any{
		"parent segment":   "../x.js",
		"nested parent":    "dist/../../x.js",
		"absolute":         "/etc/main.js",
		"backslash root":   "\\main.js",
		"drive letter":     "C:main.js",
		"empty":            "",
		"blank":            "   ",
		"number":           3,
		"not a js bundle":  "plugin.json",
		"js suffix inside": "main.js.map",
	} {
		t.Run("refuses "+name, func(t *testing.T) {
			root := pluginSource(t, map[string]any{"id": "demo", "version": "0.1.0", "entry": entry})
			_, err := SetPluginDevelopment(home, "demo", root, 9)
			assertRefusalKey(t, err, "environment.develop.entryInvalid", "demo")
			after, _, readErr := Read(home)
			if readErr != nil || after.Revision != 9 || len(after.Plugins) != 0 {
				t.Fatalf("environment changed: %+v err=%v", after, readErr)
			}
		})
	}
}

func TestDevelopRefusesAnUnavailableManifestByName(t *testing.T) {
	home := t.TempDir()
	writeJSON(t, filepath.Join(home, File), Empty())
	unparseable := func(name string) string {
		root := t.TempDir()
		if err := os.WriteFile(filepath.Join(root, name), []byte("{"), 0o600); err != nil {
			t.Fatal(err)
		}
		return root
	}
	otherSidecar := t.TempDir()
	writeJSON(t, filepath.Join(otherSidecar, "sidecar.json"), map[string]any{"id": "other", "version": "0.2.0", "interface": map[string]string{"id": "terminal-state", "version": "0.0.1"}, "process": "dist/other"})
	cases := map[string]struct {
		kind, root string
	}{
		"plugin manifest missing":              {"plugin", t.TempDir()},
		"plugin manifest unparseable":          {"plugin", unparseable("plugin.json")},
		"plugin manifest declares another id":  {"plugin", pluginSource(t, map[string]any{"id": "other", "version": "0.1.0"})},
		"sidecar manifest missing":             {"sidecar", t.TempDir()},
		"sidecar manifest unparseable":         {"sidecar", unparseable("sidecar.json")},
		"sidecar manifest outside the spec":    {"sidecar", unparseableSidecar(t, "demo")},
		"sidecar manifest declares another id": {"sidecar", otherSidecar},
	}
	for name, value := range cases {
		t.Run(name, func(t *testing.T) {
			var err error
			if value.kind == "plugin" {
				_, err = SetPluginDevelopment(home, "demo", value.root, 1)
			} else {
				_, err = SetSidecarDevelopment(home, "demo", value.root, "aarch64-apple-darwin", 1)
			}
			assertRefusalKey(t, err, "environment.develop.directoryUnavailable", value.kind, "demo", value.root)
			if errors.Is(err, os.ErrNotExist) {
				t.Fatalf("os.ErrNotExist was returned to the caller: %v", err)
			}
			after, _, readErr := Read(home)
			if readErr != nil || after.Revision != 1 || len(after.Plugins) != 0 || len(after.Sidecars) != 0 {
				t.Fatalf("environment changed: %+v err=%v", after, readErr)
			}
		})
	}
}

// unparseableSidecar writes a sidecar.json for id that parses as JSON and fails the spec parse.
func unparseableSidecar(t *testing.T, id string) string {
	t.Helper()
	root := t.TempDir()
	writeJSON(t, filepath.Join(root, "sidecar.json"), map[string]any{"id": id, "version": "0.2.0", "interface": map[string]string{"id": "terminal-state", "version": "0.0.2"}, "process": "dist/" + id})
	return root
}
