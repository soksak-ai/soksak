package repositorygate

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var (
	declaredTest = regexp.MustCompile(`(?m)^func (Test[A-Za-z0-9_]+)\(`)
	invokedTest  = regexp.MustCompile(`(?:-run|--run)[= ]+'?\^?(Test[A-Za-z0-9_]+)`)
)

func TestEveryNamedGoTestTargetExists(t *testing.T) {
	declared := map[string]bool{}
	goFiles, err := trackedRecordFiles(repositoryRoot, map[string]bool{".go": true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range goFiles {
		body, readErr := os.ReadFile(filepath.Join(repositoryRoot, path))
		if readErr != nil {
			t.Fatal(readErr)
		}
		for _, match := range declaredTest.FindAllStringSubmatch(string(body), -1) {
			declared[match[1]] = true
		}
	}

	var missing []string
	for _, path := range []string{"Taskfile.yml", "scripts/ci/macos-link.sh"} {
		body, readErr := os.ReadFile(filepath.Join(repositoryRoot, path))
		if readErr != nil {
			t.Fatal(readErr)
		}
		for _, match := range invokedTest.FindAllStringSubmatch(string(body), -1) {
			if !declared[match[1]] {
				missing = append(missing, path+": "+match[1])
			}
		}
	}
	if len(missing) > 0 {
		t.Fatalf("named Go tests do not exist:\n%s", strings.Join(missing, "\n"))
	}
}
