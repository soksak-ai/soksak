package application

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	coreenvironment "github.com/soksak-ai/soksak-core/core/environment"
)

func TestInstalledPluginAssetsAreReadableBeforeEnablement(t *testing.T) {
	home := t.TempDir()
	plugin := t.TempDir()
	if err := os.WriteFile(filepath.Join(plugin, "plugin.json"), []byte(`{"id":"demo"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	environment := coreenvironment.Empty()
	environment.Plugins["demo"] = coreenvironment.Plugin{
		Component: coreenvironment.Component{Version: "0.0.1", Path: plugin, ArtifactSHA256: strings.Repeat("a", 64), Source: "registry", Registry: "official"},
		Enabled:   false,
	}
	if _, err := coreenvironment.Write(home, coreenvironment.Environment{}, false, environment, 0); err != nil {
		t.Fatal(err)
	}
	roots, err := installedPluginRoots(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(roots) != 1 || roots[0] != plugin {
		t.Fatalf("asset roots = %v", roots)
	}
}
