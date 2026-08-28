package repositorygate

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"

	platformspec "github.com/soksak-ai/soksak-spec/go/platformspec"
)

type selectedSpecRelease struct {
	Version string
	Commit  string
}

func readSelectedSpecRelease(t *testing.T) selectedSpecRelease {
	t.Helper()
	body, err := os.ReadFile("build/soksak-spec.json")
	if err != nil {
		t.Fatal(err)
	}
	var selection selectedSpecRelease
	if err := json.Unmarshal(body, &selection); err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^0\.0\.[1-9][0-9]*$`).MatchString(selection.Version) {
		t.Fatalf("selected Spec version is not an exact pre-1.0 release: %q", selection.Version)
	}
	if !regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(selection.Commit) {
		t.Fatalf("selected Spec commit is not exact: %q", selection.Commit)
	}
	return selection
}

func requireSelectedGoSpec(t *testing.T, selection selectedSpecRelease) {
	t.Helper()
	module, err := os.ReadFile("go.mod")
	if err != nil {
		t.Fatal(err)
	}
	match := regexp.MustCompile(`(?m)^\s*github\.com/soksak-ai/soksak-spec/go/platformspec\s+v\S+-([0-9a-f]{12})$`).FindStringSubmatch(string(module))
	if len(match) != 2 || match[1] != selection.Commit[:12] {
		t.Fatalf("Go Spec commit is %q, selected commit is %s", strings.Join(match, " "), selection.Commit)
	}
}

func TestGoSidecarSpecAcceptsPatchVersions(t *testing.T) {
	manifest := []byte(`{"id":"soksak-sidecar-terminal-vt100","version":"0.0.7","interface":[{"id":"soksak-spec-sidecar-terminal","version":"0.0.1"}],"process":"dist/soksak-sidecar-terminal-vt100"}`)
	parsed, err := platformspec.ParseSidecarManifest(manifest)
	if err != nil || parsed.Version != "0.0.7" {
		t.Fatalf("Go sidecar parser rejected patch version: %+v %v", parsed, err)
	}
}

func TestCoreUsesOneSelectedSpecRelease(t *testing.T) {
	selection := readSelectedSpecRelease(t)
	packageJSON, err := os.ReadFile("frontend/package.json")
	if err != nil {
		t.Fatal(err)
	}
	want := `"@soksak/soksak-spec": "` + selection.Version + `"`
	if !strings.Contains(string(packageJSON), want) {
		t.Fatalf("frontend Spec dependency does not match the selected release %s", selection.Version)
	}
	lockfile, err := os.ReadFile("frontend/pnpm-lock.yaml")
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"'@soksak/soksak-spec':\n        specifier: " + selection.Version,
		"'@soksak/soksak-spec@" + selection.Version + "':",
	} {
		if !strings.Contains(string(lockfile), required) {
			t.Fatalf("frontend lockfile does not contain selected Spec release %q", required)
		}
	}
	for name, source := range map[string][]byte{
		"frontend/package.json":              packageJSON,
		"frontend/pnpm-lock.yaml":            lockfile,
		"frontend/vite.config.ts":            mustRead(t, "frontend/vite.config.ts"),
		"scripts/check-registry-install.mjs": mustRead(t, "scripts/check-registry-install.mjs"),
	} {
		if strings.Contains(string(source), "@soksak-ai/plugin-spec") {
			t.Errorf("%s still uses the removed Spec package name", name)
		}
	}
	requireSelectedGoSpec(t, selection)
}

func mustRead(t *testing.T, name string) []byte {
	t.Helper()
	body, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	return body
}
