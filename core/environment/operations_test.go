package environment

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

func writeJSON(t *testing.T, path string, value any) {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
}
func TestPluginManifestsReadOneEnvironmentRecord(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	manifest := []byte("{\"id\":\"demo\",\"version\":\"0.0.1\"}")
	if err := os.WriteFile(filepath.Join(root, "plugin.json"), manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	environment := Empty()
	environment.Plugins["demo"] = Plugin{Component: Component{Version: "0.0.1", Path: root, ArtifactSHA256: strings.Repeat("a", 64), Source: "registry", Registry: "official"}, Enabled: true}
	writeJSON(t, filepath.Join(home, File), environment)
	records, err := PluginManifests(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 || !records[0].Enabled || records[0].InstallPath != root || records[0].Manifest == nil || *records[0].Manifest != string(manifest) {
		t.Fatalf("records=%+v", records)
	}
}

// A record whose manifest readRecordManifest refuses is listed with the
// refusal sentence in Error and no Manifest: the development sentence for a
// development record, the install sentence for a registry record. No os error
// string is listed.
func TestPluginManifestsListABrokenRecordWithTheRefusalSentence(t *testing.T) {
	home := t.TempDir()
	development := t.TempDir()
	registry := t.TempDir()
	environment := Empty()
	environment.Plugins["broken"] = Plugin{Component: Component{Version: "0.1.0", Path: development, Source: DevelopmentSource}, Enabled: true}
	environment.Plugins["stale"] = Plugin{Component: Component{Version: "0.0.1", Path: registry, ArtifactSHA256: strings.Repeat("a", 64), Source: "registry", Registry: "official"}, Enabled: true}
	writeJSON(t, filepath.Join(home, File), environment)
	records, err := PluginManifests(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 2 {
		t.Fatalf("records=%+v", records)
	}
	broken, stale := records[0], records[1]
	if broken.ID != "broken" || broken.Manifest != nil || broken.Error == nil {
		t.Fatalf("broken=%+v", broken)
	}
	want := i18n.Errorf("environment.develop.directoryUnavailable", map[string]string{"kind": "plugin", "id": "broken", "path": development, "error": "plugin.json: open " + filepath.Join(development, "plugin.json") + ": no such file or directory"}).Error()
	if *broken.Error != want {
		t.Fatalf("broken.Error = %q, want %q", *broken.Error, want)
	}
	if strings.HasPrefix(*broken.Error, "open ") {
		t.Fatalf("broken.Error is a raw os string: %q", *broken.Error)
	}
	if stale.ID != "stale" || stale.Manifest != nil || stale.Error == nil {
		t.Fatalf("stale=%+v", stale)
	}
	if want := i18n.Errorf("install.transaction.pluginManifestInvalid", map[string]string{"plugin": "stale"}).Error(); *stale.Error != want {
		t.Fatalf("stale.Error = %q, want %q", *stale.Error, want)
	}
}

func TestInitializePublishesTheFirstEnvironmentRevision(t *testing.T) {
	home := t.TempDir()
	if err := Initialize(home); err != nil {
		t.Fatal(err)
	}
	value, exists, err := Read(home)
	if err != nil || !exists || value.Revision != 1 {
		t.Fatalf("environment=%+v exists=%v err=%v", value, exists, err)
	}
}

func TestExactSidecarReferenceResolvesEnvironmentSidecar(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	process := filepath.Join(root, "dist", "terminal-sidecar")
	if err := os.MkdirAll(filepath.Dir(process), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(process, []byte("binary"), 0o700); err != nil {
		t.Fatal(err)
	}
	manifest := map[string]any{"id": "terminal-sidecar", "version": "0.0.1", "interface": map[string]string{"id": "terminal-state", "version": "0.0.1"}, "process": "dist/terminal-sidecar"}
	writeJSON(t, filepath.Join(root, "sidecar.json"), manifest)
	environment := Empty()
	environment.Plugins["terminal-view"] = Plugin{Component: Component{Version: "0.0.1", Path: t.TempDir(), ArtifactSHA256: strings.Repeat("a", 64), Source: "registry", Registry: "official"}, Enabled: true}
	environment.Sidecars["terminal-sidecar"] = Component{Version: "0.0.1", Path: root, ArtifactSHA256: strings.Repeat("b", 64), Source: "registry", Registry: "official", Target: "aarch64-apple-darwin"}
	writeJSON(t, filepath.Join(home, File), environment)
	runtime, err := ResolveSidecarForPlugin(home, PluginRef{ID: "terminal-view", Version: "0.0.1"}, PluginRef{ID: "terminal-sidecar", Version: "0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	if runtime.Process != process || runtime.InterfaceID != "terminal-state" {
		t.Fatalf("runtime=%+v", runtime)
	}
}

func TestSidecarSelectionResolvesAWindowsSidecarExecutable(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	process := filepath.Join(root, "dist", "terminal-sidecar.exe")
	if err := os.MkdirAll(filepath.Dir(process), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(process, []byte("binary"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeJSON(t, filepath.Join(root, "sidecar.json"), map[string]any{
		"id": "terminal-sidecar", "version": "0.0.1",
		"interface": map[string]string{"id": "terminal-state", "version": "0.0.1"},
		"process":   "dist/terminal-sidecar.exe",
	})
	environment := Empty()
	environment.Sidecars["terminal-sidecar"] = Component{Version: "0.0.1", Path: root, ArtifactSHA256: strings.Repeat("a", 64), Source: "registry", Registry: "official", Target: "x86_64-pc-windows-msvc"}
	writeJSON(t, filepath.Join(home, File), environment)
	runtime, err := ResolveSidecarVersion(home, "terminal-sidecar", "0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	if runtime.Process != process {
		t.Fatalf("process = %s", runtime.Process)
	}
}

func TestEnvironmentChangesAdvanceOneRevision(t *testing.T) {
	home := t.TempDir()
	value := Empty()
	value.Plugins["demo"] = Plugin{Component: Component{Version: "0.0.1", Path: t.TempDir(), ArtifactSHA256: strings.Repeat("a", 64), Source: "registry", Registry: "official"}}
	writeJSON(t, filepath.Join(home, File), value)
	change, err := SetPluginsEnabled(home, []PluginRef{{ID: "demo", Version: "0.0.1"}}, true, 1)
	if err != nil {
		t.Fatal(err)
	}
	if change != (Change{PreviousRevision: 1, Revision: 2}) {
		t.Fatalf("change=%+v", change)
	}
}

func TestPluginEnablementUsesTheInstalledReleaseVersion(t *testing.T) {
	home := t.TempDir()
	value := Empty()
	value.Plugins["demo"] = Plugin{Component: Component{Version: "0.0.3", Path: t.TempDir(), ArtifactSHA256: strings.Repeat("a", 64), Source: "registry", Registry: "official"}}
	writeJSON(t, filepath.Join(home, File), value)
	if _, err := SetPluginsEnabled(home, []PluginRef{{ID: "demo", Version: "0.0.3"}}, true, 1); err != nil {
		t.Fatalf("installed version was refused: %v", err)
	}
	if _, err := SetPluginsEnabled(home, []PluginRef{{ID: "demo", Version: "0.0.2"}}, true, 2); !os.IsNotExist(err) {
		t.Fatalf("mismatched version on enable error = %v", err)
	}
	// Disable names the record only; the version field is not compared.
	if _, err := SetPluginsEnabled(home, []PluginRef{{ID: "demo", Version: "0.0.2"}}, false, 2); err != nil {
		t.Fatalf("disable with another version refused: %v", err)
	}
}

func TestPluginEnablementUsesTheDiskVersionOfADevelopmentRecord(t *testing.T) {
	home := t.TempDir()
	writeJSON(t, filepath.Join(home, File), Empty())
	root := pluginSource(t, map[string]any{"id": "demo", "version": "0.1.0"})
	if _, err := SetPluginDevelopment(home, "demo", root, 1); err != nil {
		t.Fatal(err)
	}
	writeJSON(t, filepath.Join(root, "plugin.json"), map[string]any{"id": "demo", "version": "0.2.0"})
	if _, err := SetPluginsEnabled(home, []PluginRef{{ID: "demo", Version: "0.1.0"}}, true, 2); !os.IsNotExist(err) {
		t.Fatalf("recorded version error = %v", err)
	}
	if _, err := SetPluginsEnabled(home, []PluginRef{{ID: "demo", Version: "0.2.0"}}, true, 2); err != nil {
		t.Fatalf("disk version refused: %v", err)
	}
	after, _, err := Read(home)
	if err != nil || !after.Plugins["demo"].Enabled || after.Plugins["demo"].Version != "0.1.0" {
		t.Fatalf("environment=%+v err=%v", after, err)
	}
}

func TestPluginDisableIgnoresTheVersionField(t *testing.T) {
	home := t.TempDir()
	writeJSON(t, filepath.Join(home, File), Empty())
	root := pluginSource(t, map[string]any{"id": "demo", "version": "0.1.0"})
	if _, err := SetPluginDevelopment(home, "demo", root, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := SetPluginsEnabled(home, []PluginRef{{ID: "demo", Version: "0.1.0"}}, true, 2); err != nil {
		t.Fatal(err)
	}
	// The developer moved plugin.json to 0.2.0; the caller still holds the recorded 0.1.0.
	writeJSON(t, filepath.Join(root, "plugin.json"), map[string]any{"id": "demo", "version": "0.2.0"})
	if _, err := SetPluginsEnabled(home, []PluginRef{{ID: "demo", Version: "0.1.0"}}, false, 3); err != nil {
		t.Fatalf("disable with the recorded version refused: %v", err)
	}
	after, _, err := Read(home)
	if err != nil || after.Plugins["demo"].Enabled {
		t.Fatalf("environment=%+v err=%v", after, err)
	}
}

// registrySidecar writes a registry sidecar record whose artifact directory holds sidecar.json and its process.
func registrySidecar(t *testing.T, value *Environment, id, version string) string {
	t.Helper()
	root := t.TempDir()
	process := filepath.Join(root, "dist", id)
	if err := os.MkdirAll(filepath.Dir(process), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(process, []byte("binary"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeJSON(t, filepath.Join(root, "sidecar.json"), map[string]any{"id": id, "version": version, "interface": map[string]string{"id": "terminal-state", "version": "0.0.1"}, "process": "dist/" + id})
	value.Sidecars[id] = Component{Version: version, Path: root, ArtifactSHA256: strings.Repeat("b", 64), Source: "registry", Registry: "official", Target: "aarch64-apple-darwin"}
	return process
}

func TestResolveSidecarForPluginUsesTheDiskVersionOfADevelopmentPlugin(t *testing.T) {
	home := t.TempDir()
	root := pluginSource(t, map[string]any{"id": "terminal", "version": "0.1.0"})
	value := Empty()
	value.Plugins["terminal"] = Plugin{Component: Component{Version: "0.1.0", Path: root, Source: "development"}, Enabled: true}
	process := registrySidecar(t, &value, "terminal-sidecar", "0.0.1")
	writeJSON(t, filepath.Join(home, File), value)
	writeJSON(t, filepath.Join(root, "plugin.json"), map[string]any{"id": "terminal", "version": "0.2.0"})
	if _, err := ResolveSidecarForPlugin(home, PluginRef{ID: "terminal", Version: "0.1.0"}, PluginRef{ID: "terminal-sidecar", Version: "0.0.1"}); !os.IsNotExist(err) {
		t.Fatalf("recorded version error = %v", err)
	}
	runtime, err := ResolveSidecarForPlugin(home, PluginRef{ID: "terminal", Version: "0.2.0"}, PluginRef{ID: "terminal-sidecar", Version: "0.0.1"})
	if err != nil {
		t.Fatalf("disk version refused: %v", err)
	}
	if runtime.Process != process {
		t.Fatalf("runtime=%+v", runtime)
	}
	if err := os.RemoveAll(root); err != nil {
		t.Fatal(err)
	}
	_, err = ResolveSidecarForPlugin(home, PluginRef{ID: "terminal", Version: "0.2.0"}, PluginRef{ID: "terminal-sidecar", Version: "0.0.1"})
	assertRefusalKey(t, err, "environment.develop.directoryUnavailable", "plugin", "terminal", root)
}

func TestResolveSidecarVersionUsesTheDiskVersionOfADevelopmentSidecar(t *testing.T) {
	home := t.TempDir()
	root := sidecarSource(t, "terminal-state", true)
	value := Empty()
	value.Sidecars["terminal-state"] = Component{Version: "0.2.0", Path: root, Source: "development", Target: "aarch64-apple-darwin"}
	writeJSON(t, filepath.Join(home, File), value)
	writeJSON(t, filepath.Join(root, "sidecar.json"), map[string]any{"id": "terminal-state", "version": "0.3.0", "interface": map[string]string{"id": "terminal-state", "version": "0.0.1"}, "process": "dist/terminal-state"})
	if _, err := ResolveSidecarVersion(home, "terminal-state", "0.2.0"); !os.IsNotExist(err) {
		t.Fatalf("recorded version error = %v", err)
	}
	runtime, err := ResolveSidecarVersion(home, "terminal-state", "0.3.0")
	if err != nil {
		t.Fatalf("disk version refused: %v", err)
	}
	if runtime.Version != "0.3.0" || runtime.Process != filepath.Join(root, "dist", "terminal-state") || runtime.InterfaceID != "terminal-state" {
		t.Fatalf("runtime=%+v", runtime)
	}
	if err := os.RemoveAll(root); err != nil {
		t.Fatal(err)
	}
	_, err = ResolveSidecarVersion(home, "terminal-state", "0.3.0")
	assertRefusalKey(t, err, "environment.develop.directoryUnavailable", "sidecar", "terminal-state", root)
}

func TestABrokenDevelopmentPluginIsDisabledWithoutAVersionAndNotEnabled(t *testing.T) {
	home := t.TempDir()
	writeJSON(t, filepath.Join(home, File), Empty())
	root := pluginSource(t, map[string]any{"id": "base", "version": "1.0.0"})
	if _, err := SetPluginDevelopment(home, "base", root, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := SetPluginsEnabled(home, []PluginRef{{ID: "base", Version: "1.0.0"}}, true, 2); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(root); err != nil {
		t.Fatal(err)
	}
	if _, err := SetPluginsEnabled(home, []PluginRef{{ID: "base", Version: "1.0.0"}}, false, 3); err != nil {
		t.Fatalf("broken plugin was not disabled: %v", err)
	}
	after, _, err := Read(home)
	if err != nil || after.Revision != 4 || after.Plugins["base"].Enabled {
		t.Fatalf("environment=%+v err=%v", after, err)
	}
	_, err = SetPluginsEnabled(home, []PluginRef{{ID: "base", Version: "1.0.0"}}, true, 4)
	assertRefusalKey(t, err, "environment.develop.directoryUnavailable", "plugin", "base", root)
	after, _, err = Read(home)
	if err != nil || after.Revision != 4 || after.Plugins["base"].Enabled {
		t.Fatalf("environment=%+v err=%v", after, err)
	}
}
