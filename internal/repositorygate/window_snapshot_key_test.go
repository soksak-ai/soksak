package repositorygate

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/soksak-ai/soksak-core/core/workspace"
)

// One key, written in one language and read in another.
//
// The window this application saves is written by the renderer and read by commands on this side.
// The two name the same key in two places, and nothing but this compares them: a prefix that
// drifted would have the reader looking at a key nobody writes, answering an empty result with no
// error — the same silent failure the manifest pair is guarded against.
func TestTheWindowSnapshotKeyIsOneKey(t *testing.T) {
	source, err := os.ReadFile("frontend/src/state/windowBoot.ts")
	if err != nil {
		t.Fatal(err)
	}
	written := regexp.MustCompile("key: `([^`$]*)\\$\\{label\\}`").FindSubmatch(source)
	if written == nil {
		t.Fatal("the renderer names no window snapshot key, so nothing here can be compared")
	}
	if prefix := string(written[1]); prefix != workspace.WindowSnapshotPrefix {
		t.Errorf("the renderer writes %q and this side reads %q",
			prefix, workspace.WindowSnapshotPrefix)
	}
}

// A store key workspace owns is declared once. A second declaration is a second answer, and the two
// agree only until one of them changes — after which the reader is on a key nobody writes and
// answers empty with no error.
//
// The literal alone is not the test. "windows" is also this platform's name, and a check on the
// word would fire on every file that names the operating system: a gate with false positives is one
// that gets worked around rather than obeyed. What names a store key is the pair reaching a store
// call, so the pair is what this compares.
func TestNothingRedeclaresTheStoreKeysWorkspaceOwns(t *testing.T) {
	pairs := map[*regexp.Regexp]string{
		regexp.MustCompile(`"core"\s*,\s*"windows"`): "workspace.ManifestNamespace and workspace.ManifestKey",
		regexp.MustCompile(`"window/"`):              "workspace.WindowSnapshotPrefix",
	}
	var found []string
	for _, root := range []string{"core", "internal"} {
		walkGoFiles(t, root, func(path string, body string) {
			if strings.HasPrefix(path, "core/workspace/") {
				return
			}
			for pattern, owner := range pairs {
				if pattern.MatchString(body) {
					found = append(found, path+" names the key itself rather than "+owner)
				}
			}
		})
	}
	if len(found) > 0 {
		sort.Strings(found)
		t.Errorf("%d places redeclare a key workspace owns:\n%s",
			len(found), strings.Join(found, "\n"))
	}
}

// walkGoFiles hands every Go source under one root to a reader, skipping tests: a test names a
// literal to build the case it is testing, and that is not a second declaration.
func walkGoFiles(t *testing.T, root string, read func(path, body string)) {
	t.Helper()
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		read(filepath.ToSlash(path), string(body))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
