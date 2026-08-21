package boot

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/soksak-ai/soksak-core/core/control"

	"github.com/soksak-ai/soksak-core/core/identity"
	"github.com/soksak-ai/soksak-core/core/store"
)

// booted builds the same registry the application builds, with no window
// anywhere. Everything registered here must answer headlessly, which is what
// makes a second host — or no host — possible at all.
func booted(t *testing.T) *control.Registry {
	t.Helper()
	home := t.TempDir()
	kv, err := store.OpenKV(filepath.Join(home, "soksak.db"))
	if err != nil {
		t.Fatalf("opening the store: %v", err)
	}
	t.Cleanup(func() { _ = kv.Close() })

	registry := control.NewRegistry()
	// No Emit, no LiveWindows, no spawner, no watcher: this is a process with
	// no host at all, which is the condition the test exists to hold. The
	// groups that need one declare their refusal rather than failing here.
	RegisterCore(registry, Boot{
		Identity:     identity.Resolve("com.soksak.dev", identity.Environment{Home: home}),
		BuildProfile: "debug",
		KV:           kv,
		UserHome:     t.TempDir(),
		Now:          func() int64 { return 0 },
		PidAlive:     func(int) bool { return false },
	})
	return registry
}

func args(t *testing.T, pairs map[string]any) control.Args {
	t.Helper()
	out := control.Args{}
	for name, value := range pairs {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("encoding %s: %v", name, err)
		}
		out[name] = encoded
	}
	return out
}

func TestBootCommandsAnswerWithNoWindow(t *testing.T) {
	registry := booted(t)

	// These are the calls the frontend makes before the first frame. If any of
	// them needed a window, headless would be impossible rather than unbuilt.
	for _, name := range []string{"app_environment", "app_is_release", "themes_scan"} {
		if _, err := registry.Invoke(name, nil); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestCompositionCommandsAreHeadlessAndNameMissingSettings(t *testing.T) {
	registry := booted(t)
	for _, name := range []string{"composition_settings", "composition_graph", "composition_status", "plugin_manifest_list"} {
		if _, err := registry.Invoke(name, nil); err == nil {
			t.Errorf("%s accepted a home with no settings.json", name)
		}
	}
}

func TestEnvironmentCarriesTheResolvedIdentity(t *testing.T) {
	got, err := booted(t).Invoke("app_environment", nil)
	if err != nil {
		t.Fatalf("app_environment: %v", err)
	}
	encoded, _ := json.Marshal(got)
	var env struct {
		Identity  string `json:"identity"`
		CoreBuild string `json:"coreBuild"`
		CLI       string `json:"cli"`
	}
	if err := json.Unmarshal(encoded, &env); err != nil {
		t.Fatalf("decoding: %v", err)
	}
	if env.Identity != "com.soksak.dev" || env.CoreBuild != "dev" || env.CLI != "sok-dev" {
		t.Errorf("environment = %+v", env)
	}
}

func TestScanningAFreshHomeIsEmptyNotAFailure(t *testing.T) {
	// A fresh home has no themes directory. A read command does not create it,
	// so absence must be an ordinary answer.
	got, err := booted(t).Invoke("themes_scan", nil)
	if err != nil {
		t.Fatalf("themes_scan on a fresh home: %v", err)
	}
	encoded, _ := json.Marshal(got)
	if string(encoded) != "[]" {
		t.Errorf("themes_scan = %s, want an empty list", encoded)
	}
}

func TestMissingKeyReadsAsNull(t *testing.T) {
	got, err := booted(t).Invoke("data_kv_get", args(t, map[string]any{"ns": "ui", "key": "theme"}))
	if err != nil {
		t.Fatalf("data_kv_get: %v", err)
	}
	if got != nil {
		t.Errorf("a key never written = %v, want null", got)
	}
}

func TestAValueSurvivesTheRoundTrip(t *testing.T) {
	registry := booted(t)
	if _, err := registry.Invoke("data_kv_set", args(t, map[string]any{
		"ns": "ui", "key": "theme", "value": "Midnight",
	})); err != nil {
		t.Fatalf("data_kv_set: %v", err)
	}

	got, err := registry.Invoke("data_kv_get", args(t, map[string]any{"ns": "ui", "key": "theme"}))
	if err != nil {
		t.Fatalf("data_kv_get: %v", err)
	}
	// The value returns as it was written, not through a second encoding.
	if got != "Midnight" {
		t.Errorf("round trip = %#v, want the value as written", got)
	}
}

func TestAMissingArgumentIsNamed(t *testing.T) {
	_, err := booted(t).Invoke("data_kv_get", args(t, map[string]any{"ns": "ui"}))
	if err == nil {
		t.Fatal("a missing key argument must fail")
	}
}

func TestTheTableSeparatesCoreFromFramework(t *testing.T) {
	table := booted(t).Describe()
	if len(table.Commands) == 0 {
		t.Fatal("the table is empty")
	}
	for _, command := range table.Commands {
		// Everything registered here is host-independent. A framework-owned
		// entry appearing in this set would mean the split had leaked.
		if command.Owner != control.OwnerCore {
			t.Errorf("%s is owned by %q in the core registration", command.Name, command.Owner)
		}
	}
}
