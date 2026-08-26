package repositorygate

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	platformspec "github.com/soksak-ai/soksak-spec/go/platformspec"
)

func TestGoAndFrontendSpecsAcceptSidecarPatchVersions(t *testing.T) {
	manifest := []byte(`{"id":"soksak-sidecar-terminal-vt100","version":"0.0.7","interface":{"id":"soksak-spec-sidecar-terminal","version":"0.0.1"},"process":"dist/soksak-sidecar-terminal-vt100"}`)
	parsed, err := platformspec.ParseSidecarManifest(manifest)
	if err != nil || parsed.Version != "0.0.7" {
		t.Fatalf("Go sidecar parser rejected patch version: %+v %v", parsed, err)
	}
	selectionBody, err := os.ReadFile("build/soksak-spec.json")
	if err != nil {
		t.Fatal(err)
	}
	var selection struct{ Version, Commit string }
	if err := json.Unmarshal(selectionBody, &selection); err != nil {
		t.Fatal(err)
	}
	packageJSON, err := os.ReadFile("frontend/package.json")
	if err != nil {
		t.Fatal(err)
	}
	want := `"@soksak-ai/plugin-spec": "` + selection.Version + `"`
	if !strings.Contains(string(packageJSON), want) {
		t.Fatal("frontend and Go do not use the same sidecar parser release")
	}
	module, err := os.ReadFile("go.mod")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(module), selection.Commit[:12]) {
		t.Fatal("Go does not consume the selected public spec commit")
	}
}
