package environment

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/soksak-ai/soksak-core/core/i18n"
	platformspec "github.com/soksak-ai/soksak-spec/go/platformspec"
)

func installInterfaceFixture(t *testing.T, environment *Environment, id string, ref platformspec.Reference) {
	t.Helper()
	root := t.TempDir()
	process := filepath.Join(root, "dist", id)
	if err := os.MkdirAll(filepath.Dir(process), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(process, []byte("fixture"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeJSON(t, filepath.Join(root, "sidecar.json"), map[string]any{
		"id": id, "version": "0.0.1", "processRole": "sidecar-fixture",
		"interface": []platformspec.Reference{ref}, "process": "dist/" + id,
	})
	environment.Sidecars[id] = Component{
		Version: "0.0.1", Path: root, Process: process, ArtifactSHA256: strings.Repeat("a", 64),
		Source: RegistrySource, Registry: "official", Target: "aarch64-apple-darwin",
	}
}

func TestSelectedSidecarInterfaceResolvesTheManifestDeclarationWithoutAComponentName(t *testing.T) {
	home := t.TempDir()
	value := Empty()
	wanted := platformspec.Reference{ID: "fixture-process-owner", Version: "0.0.2"}
	installInterfaceFixture(t, &value, "unrelated-provider", platformspec.Reference{ID: "fixture-other", Version: "0.0.1"})
	installInterfaceFixture(t, &value, "selected-provider", wanted)
	writeJSON(t, filepath.Join(home, File), value)

	runtime, err := ResolveSelectedSidecarInterface(home, wanted.ID, wanted.Version)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.ID != "selected-provider" || runtime.Interfaces[0] != wanted {
		t.Fatalf("runtime=%+v", runtime)
	}
}

func TestSelectedSidecarInterfaceRefusesAmbiguousProviders(t *testing.T) {
	home := t.TempDir()
	value := Empty()
	wanted := platformspec.Reference{ID: "fixture-process-owner", Version: "0.0.2"}
	installInterfaceFixture(t, &value, "provider-a", wanted)
	installInterfaceFixture(t, &value, "provider-b", wanted)
	writeJSON(t, filepath.Join(home, File), value)

	_, err := ResolveSelectedSidecarInterface(home, wanted.ID, wanted.Version)
	refusal, ok := err.(*i18n.Error)
	if !ok || refusal.Key != "environment.sidecar.interfaceAmbiguous" {
		t.Fatalf("error=%v", err)
	}
}

func TestSidecarDependencyInterfaceUsesTheConsumerManifest(t *testing.T) {
	home := t.TempDir()
	value := Empty()
	pty := platformspec.Reference{ID: "soksak-spec-sidecar-pty", Version: "0.0.2"}
	installInterfaceFixture(t, &value, "pty-provider", pty)
	consumerRoot := t.TempDir()
	consumerProcess := filepath.Join(consumerRoot, "dist", "terminal-provider")
	if err := os.MkdirAll(filepath.Dir(consumerProcess), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(consumerProcess, []byte("fixture"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeJSON(t, filepath.Join(consumerRoot, "sidecar.json"), map[string]any{
		"id": "terminal-provider", "version": "0.0.1", "processRole": "sidecar-terminal-provider",
		"interface":           []platformspec.Reference{{ID: "soksak-spec-sidecar-terminal", Version: "0.0.5"}},
		"runtimeDependencies": map[string]any{"sidecars": []platformspec.Reference{{ID: "pty-provider", Version: "0.0.1"}}},
		"process":             "dist/terminal-provider",
	})
	value.Sidecars["terminal-provider"] = Component{Version: "0.0.1", Path: consumerRoot, Process: consumerProcess, ArtifactSHA256: strings.Repeat("b", 64), Source: RegistrySource, Registry: "official", Target: "aarch64-apple-darwin"}
	writeJSON(t, filepath.Join(home, File), value)

	runtime, err := ResolveSidecarDependencyInterface(home, "terminal-provider", pty.ID, pty.Version)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.ID != "pty-provider" {
		t.Fatalf("runtime=%+v", runtime)
	}
}
