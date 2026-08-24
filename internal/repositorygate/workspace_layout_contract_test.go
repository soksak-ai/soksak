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
			"forks/", "직접 유지하는 upstream fork",
			"libraries/", "직접 만든 재사용 library",
			"externals/", "수정하지 않는 제3자 source",
			"tests/", "제품 전용 system 및 acceptance repository",
			"origin`은 유지하는 fork", "upstream`은 원본 repository",
			"branch 이름에는 upstream version",
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
