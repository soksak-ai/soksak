package repositorygate

import (
	"os"
	"strings"
	"testing"
)

func TestWorkspaceLayoutDescribesProductRepositories(t *testing.T) {
	checks := map[string][]string{
		"docs/tech/REPO-LAYOUT.md": {
			"soksak-plugins/", "soksak-kits/", "soksak-sidecars/", "soksak-contracts/",
			"libraries/", "tests/", "environment.json",
		},
		"docs/tech/REPO-LAYOUT.ko.md": {
			"soksak-plugins/", "soksak-kits/", "soksak-sidecars/", "soksak-contracts/",
			"libraries/", "tests/", "manifest",
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
		for _, forbidden := range []string{"forks/", "externals/", "preserved provider", "declared external input", "source ref"} {
			if strings.Contains(strings.ToLower(text), strings.ToLower(forbidden)) {
				t.Errorf("%s contains obsolete external-source wording %q", path, forbidden)
			}
		}
	}
}
