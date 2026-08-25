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

func TestEnvironmentHasNoRawSourcePathSurface(t *testing.T) {
	for _, path := range []string{"core/environment/register.go", "frontend/src/commands/catalog.ts"} {
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		for _, forbidden := range []string{"source_set", "source.set", "catalogSource"} {
			if strings.Contains(string(body), forbidden) {
				t.Errorf("%s exposes retired raw source operation %q", path, forbidden)
			}
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
		"## One release contract, two transports",
		"Local and registry releases use the same closure resolver and installer transaction.",
		"Raw source paths are never installation inputs.",
		"The environment records only Plugin and Sidecar runtime selections.",
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
