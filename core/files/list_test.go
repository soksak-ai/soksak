package files

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestChildrenAreFoldersFirstThenCaseInsensitiveByName(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "Zeta"), 0o755); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}
	write(t, filepath.Join(dir, "apple"), "a")
	write(t, filepath.Join(dir, "Banana"), "b")

	got, err := listChildren(dir, false, "")
	if err != nil {
		t.Fatalf("listing: %v", err)
	}
	if names := nameList(got); !equal(names, []string{"Zeta", "apple", "Banana"}) {
		t.Errorf("names = %v, want folders first then case-insensitive", names)
	}
}

// Rust's sort_by is stable, so an earlier build got tie order for free.
// sort.Slice is not, and two readings of one unchanged directory would hand the
// tree a different order — which redraws as rows jumping with nothing changed.
// The tie is broken on the raw name so the order is total.
//
// The fixture is built in memory rather than on disk because this host's volume
// is case-insensitive: F00.MD and f00.md cannot both exist there, while a Linux
// checkout or a case-sensitive APFS volume holds both. The rule under test is
// the comparator, and it must answer the same on every one of them.
func TestNamesThatDifferOnlyInCaseHaveOneSettledOrder(t *testing.T) {
	var children []Child
	var want []string
	// os.ReadDir hands entries back sorted by raw name, so every upper-case
	// spelling arrives before every lower-case one — the arrangement that makes
	// an unstable sort visible.
	for i := 0; i < 10; i++ {
		children = append(children, Child{Name: fmt.Sprintf("F%02d.MD", i)})
	}
	for i := 0; i < 10; i++ {
		children = append(children, Child{Name: fmt.Sprintf("f%02d.md", i)})
	}
	for i := 0; i < 10; i++ {
		want = append(want, fmt.Sprintf("F%02d.MD", i), fmt.Sprintf("f%02d.md", i))
	}

	sortChildren(children)
	if names := namesOf(children); !equal(names, want) {
		t.Errorf("names = %v,\nwant %v", names, want)
	}
}

// Folders come first whatever the names say.
func TestAFolderOutranksAFileWithAnEarlierName(t *testing.T) {
	children := []Child{{Name: "aaa"}, {Name: "zzz", Dir: true}}
	sortChildren(children)
	if names := namesOf(children); !equal(names, []string{"zzz", "aaa"}) {
		t.Errorf("names = %v", names)
	}
}

// macOS TCC: a stat inside Desktop, Documents, or Downloads raises a permission
// prompt, and merely listing a folder must never raise one. os.ReadDir answers
// Type() from the dirent; Info() is the stat. So meta is off by default.
func TestNoChildIsStattedUnlessMetaIsAsked(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "a"), "x")
	write(t, filepath.Join(dir, "b"), "x")

	plain, err := listChildren(dir, false, "")
	if err != nil {
		t.Fatalf("listing: %v", err)
	}
	for _, child := range plain.Children {
		if child.Modified != nil {
			t.Errorf("%s carries a modified time with meta off", child.Name)
		}
	}
	// The absent field must not reach the caller as `"modified":null`, which a
	// renderer reads as "the file has no modification time".
	encoded, err := json.Marshal(plain.Children[0])
	if err != nil {
		t.Fatalf("encoding: %v", err)
	}
	if strings.Contains(string(encoded), "modified") {
		t.Errorf("the unasked field crossed the boundary: %s", encoded)
	}

	withMeta, err := listChildren(dir, true, "")
	if err != nil {
		t.Fatalf("listing with meta: %v", err)
	}
	for _, child := range withMeta.Children {
		if child.Modified == nil {
			t.Errorf("%s has no modified time with meta on", child.Name)
		}
	}
}

// A symlinked child is the one entry that is stat'd, because the dirent says
// "symlink" and the tree needs to know whether it opens.
func TestASymlinkedChildIsReportedByWhatItPointsAt(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}
	write(t, filepath.Join(dir, "file"), "x")
	if err := os.Symlink(target, filepath.Join(dir, "toDir")); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}
	if err := os.Symlink(filepath.Join(dir, "file"), filepath.Join(dir, "toFile")); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}

	got, err := listChildren(dir, false, "")
	if err != nil {
		t.Fatalf("listing: %v", err)
	}
	kinds := map[string]bool{}
	for _, child := range got.Children {
		kinds[child.Name] = child.Dir
	}
	if !kinds["toDir"] {
		t.Error("a link to a directory must list as a directory")
	}
	if kinds["toFile"] {
		t.Error("a link to a file must not list as a directory")
	}
}

// The TCC rule, made checkable rather than only stated.
//
// A directory with read but no search permission still hands out dirents —
// name and type — while every stat inside it is denied. So this fixture
// separates the two sources: an implementation that reached for a stat gets
// nothing and reports the subdirectory as a file, and on a real macOS Desktop
// that same stat is what raises the permission prompt this rule exists to
// avoid. Asserting only that `modified` is absent, as the meta test does, would
// pass for an implementation that stats every child and throws the answer away.
func TestAListingReadsTheDirentAndNeverStatsAChild(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}
	write(t, filepath.Join(dir, "f"), "x")
	// r without x: readdir still answers, every stat inside is denied.
	if err := os.Chmod(dir, 0o444); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })
	if _, err := os.Stat(filepath.Join(dir, "sub")); err == nil {
		t.Skip("this host stats inside a search-denied directory, so the fixture cannot separate dirent from stat")
	}

	got, err := listChildren(dir, false, "")
	if err != nil {
		t.Fatalf("listing: %v", err)
	}
	kinds := map[string]bool{}
	for _, child := range got.Children {
		kinds[child.Name] = child.Dir
	}
	if len(kinds) != 2 {
		t.Fatalf("listed %v, want both entries from the dirent", kinds)
	}
	if !kinds["sub"] {
		t.Error("the subdirectory read as a file — its kind came from a stat, not the dirent")
	}
	if kinds["f"] {
		t.Error("the file read as a directory")
	}
}

// The explorer sends `path: null` and expects the user home. The tree's root
// must never slide to the identity home, so the home is the injected one.
func TestNoPathListsTheInjectedHome(t *testing.T) {
	home := t.TempDir()
	write(t, filepath.Join(home, "only-here"), "x")

	got, err := listChildren("", false, home)
	if err != nil {
		t.Fatalf("listing the home: %v", err)
	}
	if names := nameList(got); !equal(names, []string{"only-here"}) {
		t.Errorf("names = %v", names)
	}
}

func TestNoPathAndNoHomeRefusesByName(t *testing.T) {
	_, err := listChildren("", false, "")
	if err == nil {
		t.Fatal("with no path and no home there is nothing to list")
	}
	if !strings.Contains(err.Error(), "UserHome") {
		t.Errorf("the refusal does not name what to supply: %v", err)
	}
}

// An empty listing would render a deleted folder as an existing empty one, and
// the tree would keep the row. Unreadable is a third answer again, or a
// permissions problem reads as an empty folder.
func TestMissingUnreadableAndNotADirectoryAreThreeAnswers(t *testing.T) {
	dir := t.TempDir()

	_, missing := listChildren(filepath.Join(dir, "gone"), false, "")
	if missing == nil {
		t.Fatal("a missing directory must fail rather than list as empty")
	}
	if !strings.Contains(missing.Error(), "gone") {
		t.Errorf("the refusal does not name the path: %v", missing)
	}

	file := filepath.Join(dir, "a.txt")
	write(t, file, "x")
	_, notDir := listChildren(file, false, "")
	if notDir == nil {
		t.Fatal("a file is not a directory")
	}
	if !strings.Contains(notDir.Error(), "not a directory") {
		t.Errorf("a file must be refused as not a directory: %v", notDir)
	}
	// The refusal has to be ours, not the errno text: os.ReadDir on a file also
	// ends in "not a directory", so the check above passes even with the stat
	// branch deleted. What separates them is that we never tried to read it.
	if strings.Contains(notDir.Error(), "could not read") {
		t.Errorf("a file was refused only after the read was attempted: %v", notDir)
	}

	sealed := filepath.Join(dir, "sealed")
	if err := os.Mkdir(sealed, 0o000); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(sealed, 0o755) })
	_, unreadable := listChildren(sealed, false, "")
	if unreadable == nil {
		t.Fatal("an unreadable directory must fail rather than list as empty")
	}

	if missing.Error() == unreadable.Error() || notDir.Error() == unreadable.Error() {
		t.Error("absence, not-a-directory, and unreadable collapsed")
	}
}

// The tree feeds `root` straight back into watch_dir, so the two have to
// resolve a path the same way or `changed === dir` never matches.
func TestTheRootComesBackResolved(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "real")
	if err := os.Mkdir(real, 0o755); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}
	resolved, err := filepath.EvalSymlinks(real)
	if err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}

	got, err := listChildren(link, false, "")
	if err != nil {
		t.Fatalf("listing through the link: %v", err)
	}
	if got.Root != resolved {
		t.Errorf("root = %q, want the resolved %q", got.Root, resolved)
	}
	if got.Children == nil {
		t.Error("children must be an empty list, never null")
	}
}

func TestTheTildeReachesTheListing(t *testing.T) {
	home := t.TempDir()
	if err := os.Mkdir(filepath.Join(home, "work"), 0o755); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}
	write(t, filepath.Join(home, "work", "note.txt"), "x")

	got, err := listChildren("~/work", false, home)
	if err != nil {
		t.Fatalf("listing through the tilde: %v", err)
	}
	if names := nameList(got); !equal(names, []string{"note.txt"}) {
		t.Errorf("names = %v", names)
	}
}

func nameList(listing ChildListing) []string { return namesOf(listing.Children) }

func namesOf(children []Child) []string {
	names := make([]string, 0, len(children))
	for _, child := range children {
		names = append(names, child.Name)
	}
	return names
}

func equal(got []string, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}
