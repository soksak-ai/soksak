package repositorygate

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCoreDoesNotOwnThePTYImplementationID(t *testing.T) {
	implementationID := strings.Join([]string{"soksak", "sidecar", "pty"}, "-")
	for _, root := range []string{"core", "frameworks", "internal"} {
		err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() || filepath.Ext(path) != ".go" || path == "internal/repositorygate/component_identity_test.go" {
				return nil
			}
			body, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			if strings.Contains(string(body), implementationID) {
				t.Errorf("%s owns PTY implementation identity; discover the selected manifest by interface", path)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}
