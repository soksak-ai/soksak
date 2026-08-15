package install

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/soksak/soksak-core/core/control"
)

func devRegistry(t *testing.T, home string) *control.Registry {
	t.Helper()
	registry := control.NewRegistry()
	Register(registry, Deps{Home: home})
	return registry
}

// A home that was never written to answers an empty list, and a caller cannot
// tell that from a home whose declaration was deleted — both are "nothing is
// declared", which is an ordinary state and not an error.
func TestAHomeWithNoDeclarationAnswersAnEmptyList(t *testing.T) {
	got, err := devRegistry(t, t.TempDir()).Invoke("unit_source_list", nil)
	if err != nil {
		t.Fatalf("unit_source_list: %v", err)
	}
	sources, ok := got.([]DevSource)
	if !ok {
		t.Fatalf("unit_source_list answered %T, want []DevSource", got)
	}
	if len(sources) != 0 {
		t.Errorf("unit_source_list = %v, want an empty list", sources)
	}
}

// The declaration is written where the loader looks, in the shape it reads. A
// file at another path is a declaration nothing acts on.
func TestADeclarationIsWrittenWhereTheLoaderLooks(t *testing.T) {
	home := t.TempDir()
	tree, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("resolving the tree: %v", err)
	}

	if _, err := devRegistry(t, home).Invoke("unit_source_set",
		arguments(t, map[string]any{"kind": "plugin", "id": "soksak-plugin-demo", "source": tree})); err != nil {
		t.Fatalf("unit_source_set: %v", err)
	}

	body, err := os.ReadFile(filepath.Join(home, "config", "development-units.json"))
	if err != nil {
		t.Fatalf("reading the declaration: %v", err)
	}
	var file devSourceFileShape
	if err := json.Unmarshal(body, &file); err != nil {
		t.Fatalf("the declaration is not JSON: %v", err)
	}
	if file.Version != devSourceVersion {
		t.Errorf("version = %d, want %d", file.Version, devSourceVersion)
	}
	if len(file.Units) != 1 || file.Units[0].Source != tree {
		t.Errorf("units = %#v, want one entry with source %q", file.Units, tree)
	}
}

// Declaring the same unit twice replaces it. Two entries for one id would make
// the loader's answer depend on which it read first.
func TestDeclaringTheSameUnitTwiceReplacesIt(t *testing.T) {
	home := t.TempDir()
	first, _ := filepath.EvalSymlinks(t.TempDir())
	second, _ := filepath.EvalSymlinks(t.TempDir())
	registry := devRegistry(t, home)

	for _, source := range []string{first, second} {
		if _, err := registry.Invoke("unit_source_set",
			arguments(t, map[string]any{"kind": "plugin", "id": "soksak-plugin-demo", "source": source})); err != nil {
			t.Fatalf("unit_source_set %s: %v", source, err)
		}
	}
	got, err := registry.Invoke("unit_source_list", nil)
	if err != nil {
		t.Fatalf("unit_source_list: %v", err)
	}
	sources := got.([]DevSource)
	if len(sources) != 1 {
		t.Fatalf("unit_source_list = %v, want one entry", sources)
	}
	if sources[0].Source != second {
		t.Errorf("source = %q, want the second declaration %q", sources[0].Source, second)
	}
}

// Each refusal names what is wrong. A caller that receives one message for four
// different mistakes has to guess which one it made.
func TestEachRefusalNamesWhatIsWrong(t *testing.T) {
	home := t.TempDir()
	tree, _ := filepath.EvalSymlinks(t.TempDir())
	registry := devRegistry(t, home)

	for _, refusal := range []struct {
		what  string
		args  map[string]any
		names string
	}{
		{"an unknown kind", map[string]any{"kind": "widget", "id": "soksak-plugin-demo", "source": tree}, "widget"},
		{"an id that is not one", map[string]any{"kind": "plugin", "id": "Demo Plugin", "source": tree}, "Demo Plugin"},
		{"a relative source", map[string]any{"kind": "plugin", "id": "soksak-plugin-demo", "source": "./tree"}, "./tree"},
		{"a source that does not exist", map[string]any{"kind": "plugin", "id": "soksak-plugin-demo", "source": filepath.Join(tree, "absent")}, "absent"},
	} {
		_, err := registry.Invoke("unit_source_set", arguments(t, refusal.args))
		if err == nil {
			t.Errorf("%s was accepted", refusal.what)
			continue
		}
		if !strings.Contains(err.Error(), refusal.names) {
			t.Errorf("%s: the refusal does not name it: %v", refusal.what, err)
		}
	}

	// Nothing was written. A refused declaration that left a file behind would
	// be a half-applied change the caller was told did not happen.
	if _, err := os.Stat(filepath.Join(home, "config", "development-units.json")); !os.IsNotExist(err) {
		t.Errorf("a refused declaration wrote a file: %v", err)
	}
}

// A declaration from another version is refused rather than read as this one.
// Reading it as this shape would answer with a source nobody declared.
func TestADeclarationFromAnotherVersionIsRefused(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "config", "development-units.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("creating the config directory: %v", err)
	}
	if err := os.WriteFile(path, []byte(`{"version":99,"units":[]}`), 0o600); err != nil {
		t.Fatalf("writing the declaration: %v", err)
	}

	_, err := devRegistry(t, home).Invoke("unit_source_list", nil)
	if err == nil {
		t.Fatal("a declaration from version 99 was read")
	}
	if !strings.Contains(err.Error(), "99") {
		t.Errorf("the refusal does not name the version it found: %v", err)
	}
}

// A build with no home refuses by name rather than picking a directory. A
// declaration written somewhere nobody reads is a success that changes nothing.
func TestABuildWithNoHomeRefusesByName(t *testing.T) {
	registry := control.NewRegistry()
	Register(registry, Deps{})
	for _, name := range []string{"unit_source_list", "unit_source_set"} {
		_, err := registry.Invoke(name, arguments(t, map[string]any{
			"kind": "plugin", "id": "soksak-plugin-demo", "source": "<local-evidence>/tree",
		}))
		if err == nil {
			t.Errorf("%s answered with no home wired", name)
			continue
		}
		if !strings.Contains(err.Error(), "install.Deps.Home") {
			t.Errorf("%s: the refusal does not name what to supply: %v", name, err)
		}
	}
}
