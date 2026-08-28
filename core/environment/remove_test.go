package environment

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

// installedPlugin writes a local plugin record whose artifact directory is root.
func installedPlugin(t *testing.T, value *Environment, id, version, root string) {
	t.Helper()
	writeJSON(t, filepath.Join(root, "plugin.json"), map[string]any{"id": id, "version": version})
	value.Plugins[id] = Plugin{Component: Component{Version: version, Path: root, ArtifactSHA256: strings.Repeat("a", 64), Source: "local"}, Enabled: true}
}

func componentRoot(home, kind, id string) string {
	return filepath.Join(home, "components", kind, id, "0.0.1", strings.Repeat("a", 64))
}

func assertRemoved(t *testing.T, home string, change Change, wantChange Change, kind, id, root string, rootDeleted bool) {
	t.Helper()
	if change != wantChange {
		t.Fatalf("change=%+v want=%+v", change, wantChange)
	}
	after, _, err := Read(home)
	if err != nil {
		t.Fatal(err)
	}
	_, pluginFound := after.Plugins[id]
	_, sidecarFound := after.Sidecars[id]
	if pluginFound || sidecarFound {
		t.Fatalf("%s record remains: %+v", kind, after)
	}
	_, err = os.Stat(root)
	if rootDeleted && !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("artifact directory remains: err=%v", err)
	}
	if !rootDeleted && err != nil {
		t.Fatalf("source directory was touched: %v", err)
	}
}

func assertUnchanged(t *testing.T, home string, revision uint64, root string) {
	t.Helper()
	after, _, err := Read(home)
	if err != nil || after.Revision != revision {
		t.Fatalf("environment changed: %+v err=%v", after, err)
	}
	if _, err := os.Stat(root); err != nil {
		t.Fatalf("directory was touched: %v", err)
	}
}

func TestRemovePluginDevelopmentKeepsTheSourceDirectory(t *testing.T) {
	home := t.TempDir()
	writeJSON(t, filepath.Join(home, File), Empty())
	root := pluginSource(t, map[string]any{"id": "demo", "version": "0.1.0"})
	if _, err := SetPluginDevelopment(home, "demo", root, 1); err != nil {
		t.Fatal(err)
	}
	result, err := RemovePlugin(home, "demo", 2)
	if err != nil {
		t.Fatal(err)
	}
	assertRemoved(t, home, result.Change, Change{PreviousRevision: 2, Revision: 3}, "plugin", "demo", filepath.Join(root, "main.js"), false)
}

func TestRemovePluginLocalDeletesTheArtifactDirectoryUnderHome(t *testing.T) {
	home := t.TempDir()
	root := componentRoot(home, "plugin", "demo")
	value := Empty()
	installedPlugin(t, &value, "demo", "0.0.1", root)
	writeJSON(t, filepath.Join(home, File), value)
	result, err := RemovePlugin(home, "demo", 1)
	if err != nil {
		t.Fatal(err)
	}
	assertRemoved(t, home, result.Change, Change{PreviousRevision: 1, Revision: 2}, "plugin", "demo", root, true)
	if _, err := os.Stat(filepath.Join(home, "components", "plugin")); err != nil {
		t.Fatalf("parent directory was removed: %v", err)
	}
}

func TestRemovePluginRefusesAnArtifactPathOutsideHome(t *testing.T) {
	home := t.TempDir()
	for name, root := range map[string]string{
		"other directory": t.TempDir(),
		"components root": filepath.Join(home, "components"),
		"home":            home,
	} {
		t.Run(name, func(t *testing.T) {
			value := Empty()
			installedPlugin(t, &value, "demo", "0.0.1", root)
			writeJSON(t, filepath.Join(home, File), value)
			_, err := RemovePlugin(home, "demo", 1)
			if err == nil || !strings.Contains(err.Error(), root) {
				t.Fatalf("error = %v", err)
			}
			assertUnchanged(t, home, 1, filepath.Join(root, "plugin.json"))
		})
	}
}

func TestRemovePluginRefusesABrokenDependency(t *testing.T) {
	home := t.TempDir()
	writeJSON(t, filepath.Join(home, File), Empty())
	base := pluginSource(t, map[string]any{"id": "base", "version": "1.0.0"})
	if _, err := SetPluginDevelopment(home, "base", base, 1); err != nil {
		t.Fatal(err)
	}
	view := pluginSource(t, map[string]any{
		"id": "view", "version": "0.1.0",
		"runtimeDependencies": map[string]any{"plugins": []map[string]any{{"id": "base", "version": "1.0.0"}}},
	})
	if _, err := SetPluginDevelopment(home, "view", view, 2); err != nil {
		t.Fatal(err)
	}
	_, err := RemovePlugin(home, "base", 3)
	if err == nil || !strings.Contains(err.Error(), "DEPENDENCY_VERSION_CONFLICT") || !strings.Contains(err.Error(), "base") {
		t.Fatalf("error = %v", err)
	}
	assertUnchanged(t, home, 3, filepath.Join(base, "plugin.json"))
}

func TestRemovePluginRejectsARevisionConflictAndAnAbsentRecord(t *testing.T) {
	home := t.TempDir()
	root := componentRoot(home, "plugin", "demo")
	value := Empty()
	installedPlugin(t, &value, "demo", "0.0.1", root)
	writeJSON(t, filepath.Join(home, File), value)
	var conflict ErrRevisionConflict
	if _, err := RemovePlugin(home, "demo", 5); !errors.As(err, &conflict) {
		t.Fatalf("error = %v", err)
	}
	_, err := RemovePlugin(home, "absent", 1)
	assertRefusalKey(t, err, "environment.remove.notFound", "plugin", "absent")
	assertUnchanged(t, home, 1, filepath.Join(root, "plugin.json"))
}

func TestRemoveSidecarDevelopmentKeepsTheSourceDirectory(t *testing.T) {
	home := t.TempDir()
	writeJSON(t, filepath.Join(home, File), Empty())
	root := sidecarSource(t, "terminal-state", true)
	if _, err := SetSidecarDevelopment(home, "terminal-state", root, "aarch64-apple-darwin", "soksakv3", 1); err != nil {
		t.Fatal(err)
	}
	result, err := RemoveSidecar(home, "terminal-state", 2)
	if err != nil {
		t.Fatal(err)
	}
	assertRemoved(t, home, result.Change, Change{PreviousRevision: 2, Revision: 3}, "sidecar", "terminal-state", filepath.Join(root, "dist", "soksakv3-sidecar-terminal-state"), false)
}

func TestRemoveSidecarLocalDeletesTheArtifactDirectoryUnderHome(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(componentRoot(home, "sidecar", "state"), "aarch64-apple-darwin")
	writeJSON(t, filepath.Join(root, "sidecar.json"), map[string]any{"id": "state", "version": "0.0.1"})
	value := Empty()
	value.Sidecars["state"] = Component{Version: "0.0.1", Path: root, Process: filepath.Join(root, "dist", "soksakv3-sidecar-state"), ArtifactSHA256: strings.Repeat("a", 64), Source: "local", Target: "aarch64-apple-darwin"}
	writeJSON(t, filepath.Join(home, File), value)
	result, err := RemoveSidecar(home, "state", 1)
	if err != nil {
		t.Fatal(err)
	}
	assertRemoved(t, home, result.Change, Change{PreviousRevision: 1, Revision: 2}, "sidecar", "state", root, true)
}

func TestRemoveSidecarRefusesAnArtifactPathOutsideHome(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	writeJSON(t, filepath.Join(root, "sidecar.json"), map[string]any{"id": "state", "version": "0.0.1"})
	value := Empty()
	value.Sidecars["state"] = Component{Version: "0.0.1", Path: root, Process: filepath.Join(root, "dist", "soksakv3-sidecar-state"), ArtifactSHA256: strings.Repeat("a", 64), Source: "registry", Registry: "official", Target: "aarch64-apple-darwin"}
	writeJSON(t, filepath.Join(home, File), value)
	_, err := RemoveSidecar(home, "state", 1)
	if err == nil || !strings.Contains(err.Error(), root) {
		t.Fatalf("error = %v", err)
	}
	assertUnchanged(t, home, 1, filepath.Join(root, "sidecar.json"))
}

func TestRemoveSidecarRefusesABrokenPluginDependency(t *testing.T) {
	home := t.TempDir()
	writeJSON(t, filepath.Join(home, File), Empty())
	sidecar := sidecarSource(t, "terminal-state", true)
	if _, err := SetSidecarDevelopment(home, "terminal-state", sidecar, "aarch64-apple-darwin", "soksakv3", 1); err != nil {
		t.Fatal(err)
	}
	plugin := pluginSource(t, map[string]any{
		"id": "terminal", "version": "0.1.0",
		"runtimeDependencies": map[string]any{"sidecars": []map[string]any{{"id": "terminal-state", "version": "0.2.0"}}},
	})
	if _, err := SetPluginDevelopment(home, "terminal", plugin, 2); err != nil {
		t.Fatal(err)
	}
	_, err := RemoveSidecar(home, "terminal-state", 3)
	if err == nil || !strings.Contains(err.Error(), "DEPENDENCY_VERSION_CONFLICT") {
		t.Fatalf("error = %v", err)
	}
	assertUnchanged(t, home, 3, filepath.Join(sidecar, "sidecar.json"))
}

func TestRemoveSidecarRejectsARevisionConflictAndAnAbsentRecord(t *testing.T) {
	home := t.TempDir()
	writeJSON(t, filepath.Join(home, File), Empty())
	root := sidecarSource(t, "terminal-state", true)
	if _, err := SetSidecarDevelopment(home, "terminal-state", root, "aarch64-apple-darwin", "soksakv3", 1); err != nil {
		t.Fatal(err)
	}
	var conflict ErrRevisionConflict
	if _, err := RemoveSidecar(home, "terminal-state", 5); !errors.As(err, &conflict) {
		t.Fatalf("error = %v", err)
	}
	_, err := RemoveSidecar(home, "absent", 2)
	assertRefusalKey(t, err, "environment.remove.notFound", "sidecar", "absent")
	assertUnchanged(t, home, 2, filepath.Join(root, "sidecar.json"))
}

// assertRefusalKey checks that err is an i18n refusal with key and that its English sentence names every fragment.
func assertRefusalKey(t *testing.T, err error, key string, fragments ...string) {
	t.Helper()
	var refusal *i18n.Error
	if !errors.As(err, &refusal) || refusal.Key != key {
		t.Fatalf("error = %v, want key %s", err, key)
	}
	for _, fragment := range fragments {
		if !strings.Contains(err.Error(), fragment) {
			t.Fatalf("error = %v, want %q", err, fragment)
		}
	}
}

func TestRemovePluginRefusesASymlinkedComponentDirectory(t *testing.T) {
	home := t.TempDir()
	outside := t.TempDir()
	target := filepath.Join(outside, "0.0.1", strings.Repeat("a", 64))
	writeJSON(t, filepath.Join(target, "plugin.json"), map[string]any{"id": "demo", "version": "0.0.1"})
	if err := os.MkdirAll(filepath.Join(home, "components", "plugin"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(home, "components", "plugin", "demo")); err != nil {
		t.Fatal(err)
	}
	root := componentRoot(home, "plugin", "demo")
	value := Empty()
	value.Plugins["demo"] = Plugin{Component: Component{Version: "0.0.1", Path: root, ArtifactSHA256: strings.Repeat("a", 64), Source: "local"}, Enabled: true}
	writeJSON(t, filepath.Join(home, File), value)
	_, err := RemovePlugin(home, "demo", 1)
	if err == nil || !strings.Contains(err.Error(), root) {
		t.Fatalf("error = %v", err)
	}
	assertUnchanged(t, home, 1, filepath.Join(target, "plugin.json"))
	if _, err := os.Lstat(filepath.Join(home, "components", "plugin", "demo")); err != nil {
		t.Fatalf("symlink was removed: %v", err)
	}
}

func TestRemovePluginDeletesThroughASymlinkedComponentsRoot(t *testing.T) {
	home := t.TempDir()
	real := t.TempDir()
	if err := os.Symlink(real, filepath.Join(home, "components")); err != nil {
		t.Fatal(err)
	}
	root := componentRoot(home, "plugin", "demo")
	value := Empty()
	installedPlugin(t, &value, "demo", "0.0.1", root)
	writeJSON(t, filepath.Join(home, File), value)
	result, err := RemovePlugin(home, "demo", 1)
	if err != nil {
		t.Fatal(err)
	}
	assertRemoved(t, home, result.Change, Change{PreviousRevision: 1, Revision: 2}, "plugin", "demo", root, true)
	if _, err := os.Stat(filepath.Join(real, "plugin", "demo", "0.0.1", strings.Repeat("a", 64))); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("real directory remains: err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(real, "plugin")); err != nil {
		t.Fatalf("parent directory was removed: %v", err)
	}
	if info, err := os.Lstat(filepath.Join(home, "components")); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("components root symlink was touched: info=%v err=%v", info, err)
	}
}

func TestRemovePluginWithAMissingArtifactDirectoryRemovesTheRecord(t *testing.T) {
	home := t.TempDir()
	root := componentRoot(home, "plugin", "demo")
	value := Empty()
	value.Plugins["demo"] = Plugin{Component: Component{Version: "0.0.1", Path: root, ArtifactSHA256: strings.Repeat("a", 64), Source: "local"}, Enabled: true}
	writeJSON(t, filepath.Join(home, File), value)
	result, err := RemovePlugin(home, "demo", 1)
	if err != nil {
		t.Fatal(err)
	}
	assertRemoved(t, home, result.Change, Change{PreviousRevision: 1, Revision: 2}, "plugin", "demo", root, true)
}

func TestRemovePluginSucceedsWithTheFailedDeletionAsData(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses directory permissions")
	}
	// The result names the resolved directory; the temporary root is a symlink on macOS.
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	root := componentRoot(home, "plugin", "demo")
	value := Empty()
	installedPlugin(t, &value, "demo", "0.0.1", root)
	writeJSON(t, filepath.Join(home, File), value)
	// A subdirectory without write permission refuses the unlink of its entries;
	// the rename of root itself succeeds because the parent stays writable.
	locked := filepath.Join(root, "assets")
	if err := os.MkdirAll(locked, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(locked, "icon.svg"), []byte("<svg/>"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(locked, 0o500); err != nil {
		t.Fatal(err)
	}
	removing := root + ".removing"
	t.Cleanup(func() {
		_ = os.Chmod(locked, 0o700)
		_ = os.Chmod(filepath.Join(removing, "assets"), 0o700)
	})
	result, err := RemovePlugin(home, "demo", 1)
	if err != nil {
		t.Fatalf("deletion failure returned as an error: %v", err)
	}
	if result.Change != (Change{PreviousRevision: 1, Revision: 2}) {
		t.Fatalf("result=%+v", result)
	}
	if result.ArtifactDeleteFailed == nil || result.ArtifactDeleteFailed.Path != removing || result.ArtifactDeleteFailed.Error == "" {
		t.Fatalf("result=%+v failure=%+v", result, result.ArtifactDeleteFailed)
	}
	after, _, readErr := Read(home)
	if readErr != nil || after.Revision != 2 {
		t.Fatalf("environment=%+v err=%v", after, readErr)
	}
	if _, found := after.Plugins["demo"]; found {
		t.Fatalf("record remains: %+v", after)
	}
	if _, err := os.Lstat(root); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("content-addressed path still exists: err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(removing, "assets", "icon.svg")); err != nil {
		t.Fatalf("renamed directory was deleted: %v", err)
	}
}

func TestRemovePluginDeletesAStaleRemovingDirectoryFirst(t *testing.T) {
	home := t.TempDir()
	root := componentRoot(home, "plugin", "demo")
	value := Empty()
	installedPlugin(t, &value, "demo", "0.0.1", root)
	writeJSON(t, filepath.Join(home, File), value)
	// The remainder of an earlier removal whose record is already gone.
	stale := root + ".removing"
	if err := os.WriteFile(filepath.Join(stale, "plugin.json"), nil, 0o600); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale directory exists before the test: err=%v", err)
	}
	writeJSON(t, filepath.Join(stale, "plugin.json"), map[string]any{"id": "demo", "version": "0.0.1"})
	result, err := RemovePlugin(home, "demo", 1)
	if err != nil {
		t.Fatal(err)
	}
	if result.ArtifactDeleteFailed != nil {
		t.Fatalf("result=%+v", result)
	}
	assertRemoved(t, home, result.Change, Change{PreviousRevision: 1, Revision: 2}, "plugin", "demo", root, true)
	if _, err := os.Lstat(stale); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf(".removing directory remains: err=%v", err)
	}
}

func TestRemoveDevelopmentRecordAnswersNoDeletionFailure(t *testing.T) {
	home := t.TempDir()
	writeJSON(t, filepath.Join(home, File), Empty())
	root := pluginSource(t, map[string]any{"id": "demo", "version": "0.1.0"})
	if _, err := SetPluginDevelopment(home, "demo", root, 1); err != nil {
		t.Fatal(err)
	}
	result, err := RemovePlugin(home, "demo", 2)
	if err != nil || result.ArtifactDeleteFailed != nil {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	body, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != `{"previousRevision":2,"revision":3}` {
		t.Fatalf("result json=%s", body)
	}
}

func TestRemovePluginRenamesTheArtifactBackWhenTheWriteFails(t *testing.T) {
	home := t.TempDir()
	root := componentRoot(home, "plugin", "demo")
	value := Empty()
	installedPlugin(t, &value, "demo", "0.0.1", root)
	writeJSON(t, filepath.Join(home, File), value)
	var conflict ErrRevisionConflict
	if _, err := RemovePlugin(home, "demo", 5); !errors.As(err, &conflict) {
		t.Fatalf("error = %v", err)
	}
	assertUnchanged(t, home, 1, filepath.Join(root, "plugin.json"))
	if _, err := os.Lstat(root + ".removing"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf(".removing directory remains: err=%v", err)
	}
}

func TestRemovePluginAcceptsADevelopmentRecordWhoseManifestVersionMoved(t *testing.T) {
	home := t.TempDir()
	writeJSON(t, filepath.Join(home, File), Empty())
	base := pluginSource(t, map[string]any{"id": "base", "version": "1.0.0"})
	if _, err := SetPluginDevelopment(home, "base", base, 1); err != nil {
		t.Fatal(err)
	}
	root := componentRoot(home, "plugin", "other")
	current, _, err := Read(home)
	if err != nil {
		t.Fatal(err)
	}
	installedPlugin(t, &current, "other", "0.0.1", root)
	writeJSON(t, filepath.Join(home, File), current)
	// The development directory is the truth: a version bump after develop is not a refusal.
	writeJSON(t, filepath.Join(base, "plugin.json"), map[string]any{"id": "base", "version": "1.1.0"})
	result, err := RemovePlugin(home, "other", 2)
	if err != nil {
		t.Fatal(err)
	}
	assertRemoved(t, home, result.Change, Change{PreviousRevision: 2, Revision: 3}, "plugin", "other", root, true)
	after, _, err := Read(home)
	if err != nil || after.Plugins["base"].Version != "1.0.0" {
		t.Fatalf("development record changed: %+v err=%v", after, err)
	}
}

func TestRemovePluginDeletesTheRenamedDirectoryLeftByACrashBeforeTheWrite(t *testing.T) {
	home := t.TempDir()
	root := componentRoot(home, "plugin", "demo")
	value := Empty()
	installedPlugin(t, &value, "demo", "0.0.1", root)
	writeJSON(t, filepath.Join(home, File), value)
	// A crash between the rename and the write: <dir>.removing exists, <dir> does not, the record remains.
	if err := os.Rename(root, root+".removing"); err != nil {
		t.Fatal(err)
	}
	result, err := RemovePlugin(home, "demo", 1)
	if err != nil {
		t.Fatal(err)
	}
	if result.ArtifactDeleteFailed != nil {
		t.Fatalf("result=%+v", result)
	}
	assertRemoved(t, home, result.Change, Change{PreviousRevision: 1, Revision: 2}, "plugin", "demo", root, true)
	if _, err := os.Lstat(root + ".removing"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf(".removing directory remains: err=%v", err)
	}
}
