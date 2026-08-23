package repositorygate

import (
	"os"
	"strings"
	"testing"
)

func TestWailsReleasePublishesTheCompleteVerifiedMatrix(t *testing.T) {
	body, err := os.ReadFile(".github/workflows/wails-release.yml")
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	for _, required := range []string{
		"tags: [\"v*\"]", "github.sha", "github.ref_name",
		"actions/workflows/multiplatform-system.yml/runs?head_sha=$SOURCE_COMMIT", ".head_sha", ".conclusion",
		"core-windows-artifact", "core-darwin-artifact", "core-linux-amd64-artifact", "core-linux-arm64-artifact", "cmd/package-release",
		"go -C source run ./cmd/package-release",
		"SOKSAK_RELEASE_CLIENT_ID", "SOKSAK_RELEASE_PRIVATE_KEY",
		"immutable-releases", "publish-release",
	} {
		if !strings.Contains(text, required) {
			t.Errorf("Wails release workflow omits %s", required)
		}
	}
	for _, archive := range []string{"windows-x86_64.zip", "darwin-universal.tar.gz", "linux-x86_64.tar.gz", "linux-arm64.tar.gz"} {
		if !strings.Contains(text, archive) {
			t.Errorf("release workflow omits %s", archive)
		}
	}
	for _, forbidden := range []string{"version: 0.0.1", "tag: v0.0.1", "300aa63f"} {
		if strings.Contains(text, forbidden) {
			t.Errorf("Wails release workflow duplicates release identity: %s", forbidden)
		}
	}
}
