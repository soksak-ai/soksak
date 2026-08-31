package repositorygate

import (
	"os"
	"strings"
	"testing"
)

func TestWorkspaceLayoutSeparatesProviderSourcesLibrariesInputsAndTests(t *testing.T) {
	checks := map[string][]string{
		"docs/tech/REPO-LAYOUT.md": {
			"forks/", "preserved provider sources",
			"libraries/", "independently owned reusable libraries",
			"externals/", "declared external inputs",
			"tests/", "product-specific system and acceptance repositories",
			"source ref names the preserved revision", "revision name includes the source version",
		},
		"docs/tech/REPO-LAYOUT.ko.md": {
			"forks/", "libraries/", "externals/", "tests/",
			"revision", "workspace path", "manifest",
		},
	}
	for path, required := range checks {
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		text := string(body)
		for _, value := range required {
			if !strings.Contains(text, value) {
				t.Errorf("%s omits %q", path, value)
			}
		}
	}
}
