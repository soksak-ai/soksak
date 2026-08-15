package install

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// realDirectory answers a temporary directory with no link anywhere in it.
//
// macOS puts the temporary tree behind /var -> /private/var, and this rule
// refuses a path that resolves to its destination through a link. Resolving it here
// is what makes the fixture a directory rather than a link to one; a test that
// used the unresolved path would be asserting against the platform instead of
// against the rule.
func realDirectory(t *testing.T) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("resolving the temporary directory: %v", err)
	}
	return resolved
}

// TestAValidSourceIsAnsweredBackUnchanged. The caller stores what it gets and
// then reads plugin.json under it, so a rewritten path would mean the value
// that was judged and the value that is used are two different strings.
func TestAValidSourceIsAnsweredBackUnchanged(t *testing.T) {
	source := filepath.Join(realDirectory(t), "checkout")
	if err := os.MkdirAll(source, 0o755); err != nil {
		t.Fatalf("making the source: %v", err)
	}

	got, err := validateDevSource(source)
	if err != nil {
		t.Fatalf("validating: %v", err)
	}
	if got != source {
		t.Fatalf("answered %q, want the source it was given (%q)", got, source)
	}
}

// TestARelativeSourceIsRefused. A relative path is resolved against a working
// directory, and this process has no business having one: a window, a headless
// server and a test would each resolve it somewhere else, and the difference
// arrives as a plugin that loads for one of them.
func TestARelativeSourceIsRefused(t *testing.T) {
	if _, err := validateDevSource("checkout"); err == nil {
		t.Error("a relative source was accepted")
	}
	if _, err := validateDevSource("./checkout"); err == nil {
		t.Error("a relative source was accepted")
	}
	if _, err := validateDevSource(""); err == nil {
		t.Error("an empty source was accepted")
	}
}

// TestALinkAnywhereInThePathIsRefused is the rule that checking only the last
// component would miss. An intermediate link moves the whole subtree, and it
// moves it after the check passed.
func TestALinkAnywhereInThePathIsRefused(t *testing.T) {
	root := realDirectory(t)
	real := filepath.Join(root, "real")
	if err := os.MkdirAll(filepath.Join(real, "checkout"), 0o755); err != nil {
		t.Fatalf("making the tree: %v", err)
	}
	linked := filepath.Join(root, "linked")
	if err := os.Symlink(real, linked); err != nil {
		t.Fatalf("linking: %v", err)
	}

	through := filepath.Join(linked, "checkout")
	if _, err := validateDevSource(through); err == nil {
		t.Fatal("a source reached through a linked parent was accepted")
	}

	// The last component being the link is refused by the same walk, not by a
	// second rule.
	leaf := filepath.Join(root, "leaf")
	if err := os.Symlink(filepath.Join(real, "checkout"), leaf); err != nil {
		t.Fatalf("linking the leaf: %v", err)
	}
	if _, err := validateDevSource(leaf); err == nil {
		t.Fatal("a source that is itself a link was accepted")
	}

	// And the same tree named without the link still passes, so the refusal is
	// about the link rather than about the tree.
	if _, err := validateDevSource(filepath.Join(real, "checkout")); err != nil {
		t.Fatalf("the named path was refused too: %v", err)
	}
}

// TestATraversalIsRefusedRatherThanResolved. Resolving `..` makes the path that
// was judged and the path that is stored two different strings, and the caller
// stores the one it sent.
func TestATraversalIsRefusedRatherThanResolved(t *testing.T) {
	root := realDirectory(t)
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatalf("making the tree: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(root, "checkout"), 0o755); err != nil {
		t.Fatalf("making the source: %v", err)
	}

	if _, err := validateDevSource(root + "/sub/../checkout"); err == nil {
		t.Fatal("a source spelled through '..' was accepted")
	}
}

// TestAMissingOrNonDirectorySourceIsRefusedWithItsOwnName. "Not there" and "not
// a directory" are different repairs — one is a checkout that was never made,
// the other is a path that names the manifest instead of the tree.
func TestAMissingOrNonDirectorySourceIsRefusedWithItsOwnName(t *testing.T) {
	root := realDirectory(t)
	file := filepath.Join(root, "plugin.json")
	if err := os.WriteFile(file, []byte("{}"), 0o644); err != nil {
		t.Fatalf("writing the file: %v", err)
	}

	_, err := validateDevSource(filepath.Join(root, "absent"))
	if err == nil || !strings.Contains(err.Error(), "does not exist") {
		t.Errorf("a missing source: %v", err)
	}

	_, err = validateDevSource(file)
	if err == nil || !strings.Contains(err.Error(), "not a directory") {
		t.Errorf("a source that is a file: %v", err)
	}
}

// TestAnUnreadablePathIsNotAbsence. A component that does not exist is skipped
// because absence is not a link; a component that could not be read is neither,
// and folding it into "keep walking" would let the walk pass a link it never
// saw.
func TestAnUnreadablePathIsNotAbsence(t *testing.T) {
	root := realDirectory(t)
	blocker := filepath.Join(root, "file")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatalf("writing the blocker: %v", err)
	}

	// A path that goes through a regular file is ENOTDIR, not ErrNotExist —
	// reproducible without touching permission bits, which a root-run test
	// would defeat.
	if err := rejectLinkedComponents(filepath.Join(blocker, "checkout", "src")); err == nil {
		t.Fatal("a path that could not be read was walked past")
	}
}
