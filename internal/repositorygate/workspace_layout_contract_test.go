package repositorygate

import (
	"os"
	"strings"
	"testing"
)

func TestWorkspaceLayoutSeparatesForksLibrariesExternalsAndTests(t *testing.T) {
	checks := map[string][]string{
		"docs/tech/REPO-LAYOUT.md": {
			"forks/", "maintained upstream forks",
			"libraries/", "independently authored reusable libraries",
			"externals/", "unmodified third-party source",
			"tests/", "product-specific system and acceptance repositories",
			"origin` names the maintained fork", "upstream` names the original repository",
			"branch name includes the upstream version",
		},
		"docs/tech/REPO-LAYOUT.ko.md": {
			"forks/", "libraries/", "externals/", "tests/",
			"`origin`", "`upstream`", "upstream version",
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
