package repositorygate

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnvironmentIsTheOnlyPersistentLocalComponentState(t *testing.T) {
	for _, path := range []string{
		"core/environment/platform.go",
		"core/environment/register.go",
		"core/environment/store.go",
		"core/install/install.go",
		"core/install/environment_commit.go",
		"docs/tech/ENVIRONMENT-AND-INSTALLATION.md",
		"frontend/src/plugins/host.ts",
		"frontend/src/plugins/registryInstallRuntimeNative.ts",
	} {
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		text := string(body)
		for _, obsolete := range []string{"settings.json", "installed.json", "settings_get", "installed_get", "settings.changed", "installed.changed"} {
			if strings.Contains(text, obsolete) {
				t.Errorf("%s contains retired local state %q", path, obsolete)
			}
		}
	}
}

func TestExecutableSourceDoesNotDiscoverSiblingRepositories(t *testing.T) {
	for _, root := range []string{"core", "frameworks", "frontend/src", "scripts", ".github/workflows"} {
		err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() || filepath.Ext(path) == ".md" {
				return nil
			}
			body, readErr := os.ReadFile(path)
			if readErr != nil {
				return readErr
			}
			text := string(body)
			for _, forbidden := range []string{"SOKSAK_CORE_WORKTREE", "GITHUB_WORKSPACE/soksak-", "../soksak-"} {
				if strings.Contains(text, forbidden) {
					t.Errorf("%s discovers another repository through %q", path, forbidden)
				}
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestEveryComponentKindHasAnEnvironmentSourceSurface(t *testing.T) {
	body, err := os.ReadFile("frontend/src/commands/catalogSource.ts")
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	for _, kind := range []string{"plugin", "sidecar", "kit", "contract", "spec"} {
		wanted := "registerKind(\"" + kind + "\")"
		if !strings.Contains(text, wanted) {
			t.Errorf("environment source catalogue does not register %s", kind)
		}
	}
	for _, operation := range []string{"source.list", "source.set"} {
		if !strings.Contains(text, operation) {
			t.Errorf("environment source catalogue does not expose %s", operation)
		}
	}
}

func TestDevelopmentCandidateAndReleaseShareOneComponentContract(t *testing.T) {
	body, err := os.ReadFile("docs/tech/ENVIRONMENT-AND-INSTALLATION.md")
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	for _, rule := range []string{
		"## One component contract, three acquisition modes",
		"Development source, candidate artifact, and registry release differ only in how bytes are acquired and what evidence they provide.",
		"A local runtime source is selected only through the kind-specific `source_set` command",
		"Candidate artifacts are installed into an isolated identity home through the same installer transaction used for releases.",
		"A registry release is the only input accepted as final publication evidence.",
		"A source change never edits dependency metadata, copies files into another repository, or discovers a sibling checkout.",
	} {
		if !strings.Contains(text, rule) {
			t.Errorf("environment contract lacks %q", rule)
		}
	}
}

func TestEnvironmentDoesNotOwnPluginSidecarBindings(t *testing.T) {
	body, err := os.ReadFile("docs/tech/COMPONENT-OWNERSHIP.md")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "sidecar role bindings") {
		t.Fatal("component ownership assigns plugin dependency bindings to environment.json")
	}
}
