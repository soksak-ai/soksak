package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// filesystemRoot walks up until the parent stops changing. Spelling the root as
// "/" would make this test a unix test; the walk names it on any volume.
func filesystemRoot(start string) string {
	root := start
	for filepath.Dir(root) != root {
		root = filepath.Dir(root)
	}
	return root
}

// resolved is what the implementation calls canonical: links resolved and
// nothing else. A helper that also made the path absolute would agree with an
// implementation that consults the working directory, and then the one thing
// this package must not do would have a witness saying it is fine.
func resolved(t *testing.T, path string) string {
	t.Helper()
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatalf("resolving %s: %v", path, err)
	}
	return real
}

// A root-init policy runs over the whole tree it is given. With the home as the
// root, that policy is a policy over every file the user owns.
func TestTheUserHomeIsNotAWorkspaceRoot(t *testing.T) {
	home := t.TempDir()
	if got, err := ValidateRoot(home, home); err == nil {
		t.Fatalf("the home was accepted as a workspace root: %q", got)
	}
}

// The returned string is the workspace's identity and the key every later claim
// compares, so it must come back canonical rather than as it was typed.
func TestADirectoryUnderTheHomeIsAcceptedCanonical(t *testing.T) {
	home := t.TempDir()
	work := filepath.Join(home, "work")
	if err := os.MkdirAll(work, 0o755); err != nil {
		t.Fatalf("creating the workspace directory: %v", err)
	}

	got, err := ValidateRoot(work, home)
	if err != nil {
		t.Fatalf("a directory under the home was refused: %v", err)
	}
	if want := resolved(t, work); got != want {
		t.Errorf("canonical = %q, want %q", got, want)
	}
}

func TestTheFilesystemRootIsNotAWorkspaceRoot(t *testing.T) {
	home := t.TempDir()
	root := filesystemRoot(home)
	if got, err := ValidateRoot(root, home); err == nil {
		t.Fatalf("the filesystem root was accepted as a workspace root: %q", got)
	}
}

// This is a verdict command, so "no" is the answer. The path has to appear in
// it: the caller shows the message and the user typed the path.
func TestAFileAndAMissingPathAreRefusedByName(t *testing.T) {
	home := t.TempDir()
	file := filepath.Join(home, "notes.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatalf("writing the file: %v", err)
	}
	missing := filepath.Join(home, "nope")

	for _, path := range []string{file, missing} {
		_, err := ValidateRoot(path, home)
		if err == nil {
			t.Fatalf("%s was accepted as a workspace root", path)
		}
		if !strings.Contains(err.Error(), path) {
			t.Errorf("refusing %s did not name it: %v", path, err)
		}
	}
}

// Skipping the home check on a home-less process silently admits ~ as a root,
// which is the one thing this verdict exists to stop.
func TestWithoutAUserHomeTheVerdictRefusesByName(t *testing.T) {
	dir := t.TempDir()
	_, err := ValidateRoot(dir, "")
	if err == nil {
		t.Fatal("a process with no user home judged a workspace root anyway")
	}
	// The wording separates this from the refusal a relative home gets. Both
	// name the user home, so "user home" alone cannot tell whether the
	// no-home branch still runs.
	if !strings.Contains(err.Error(), "was not given one") {
		t.Errorf("the refusal did not say what to supply: %v", err)
	}
}

// The home is here for one comparison. A home that cannot be canonicalized
// cannot be compared, and answering "allowed" then is the guard skipped rather
// than the guard passed — silently, on every root, including the home itself
// once it comes back.
func TestAUserHomeThatCannotBeResolvedRefusesRatherThanAllows(t *testing.T) {
	gone := filepath.Join(t.TempDir(), "not-mounted")
	work := t.TempDir()

	if got, err := ValidateRoot(work, gone); err == nil {
		t.Fatalf("a home that does not resolve accepted %q anyway", got)
	} else if !strings.Contains(err.Error(), gone) {
		t.Errorf("the refusal did not name the home it could not read: %v", err)
	}
}

// One home reached by two spellings is one home. On darwin <local-evidence>/x is
// <local-evidence>/x, so an uncanonicalized comparison admits the home itself.
func TestTwoSpellingsOfOneHomeAgree(t *testing.T) {
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "home-link")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("this filesystem does not create symlinks: %v", err)
	}

	if got, err := ValidateRoot(real, link); err == nil {
		t.Fatalf("the home spelled another way was accepted as a workspace root: %q", got)
	}
}

// Link rejection is the installer surface's, which materializes files in
// our own tree. This surface is the user browsing their own disk: refusing
// links makes a symlinked work folder unopenable.
func TestASymlinkedDirectoryIsAcceptedNotRefused(t *testing.T) {
	home := t.TempDir()
	real := filepath.Join(home, "real")
	if err := os.MkdirAll(real, 0o755); err != nil {
		t.Fatalf("creating the workspace directory: %v", err)
	}
	link := filepath.Join(home, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("this filesystem does not create symlinks: %v", err)
	}

	got, err := ValidateRoot(link, home)
	if err != nil {
		t.Fatalf("a symlinked workspace directory was refused: %v", err)
	}
	if want := resolved(t, real); got != want {
		t.Errorf("canonical = %q, want the link resolved to %q", got, want)
	}
}

// Expansion is the caller's, not this command's: the home here is needed for
// the verdict alone.
func TestATildePathIsJudgedLiterally(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, "proj"), 0o755); err != nil {
		t.Fatalf("creating the workspace directory: %v", err)
	}

	_, err := ValidateRoot("~/proj", home)
	if err == nil {
		t.Fatal("~/proj was expanded; expansion here would make the answer depend on the caller")
	}
	if !strings.Contains(err.Error(), "~/proj") {
		t.Errorf("the refusal did not name the literal path: %v", err)
	}
}

// The rule is asked without a disk so a headless process, a window, and a test
// give one answer. The paths below exist nowhere.
func TestVerdictNeedsNoDisk(t *testing.T) {
	// Not filesystemRoot(".") — filepath.Dir(".") is "." already, so that walk
	// answers "." and the case would never reach a real volume root.
	root := filesystemRoot(t.TempDir())
	home := filepath.Join(root, "home", "someone")
	if err := Verdict(home, home); err == nil {
		t.Error("the home passed the verdict")
	}
	if err := Verdict(root, home); err == nil {
		t.Error("the filesystem root passed the verdict")
	}
	if err := Verdict(filepath.Join(home, "work"), home); err != nil {
		t.Errorf("a directory under the home was refused by the verdict: %v", err)
	}
}

// The canonical string is the workspace's identity and the key the claim table
// uses. A relative one would be resolved against whichever directory the
// process was started in, so the app and a headless process would answer with
// two different roots for one argument — and two roots are two workspaces.
func TestARelativePathIsRefusedRatherThanResolvedAgainstTheWorkingDirectory(t *testing.T) {
	home := t.TempDir()
	work := filepath.Join(home, "work")
	if err := os.MkdirAll(work, 0o755); err != nil {
		t.Fatalf("creating the workspace directory: %v", err)
	}

	// Reached from inside the home, "work" names a real directory; the answer
	// must still be a refusal rather than that directory.
	if got, err := ValidateRoot("work", home); err == nil {
		t.Fatalf("a relative path was resolved to %q instead of refused", got)
	} else if !strings.Contains(err.Error(), "absolute") {
		t.Errorf("the refusal did not say what was wrong: %v", err)
	}
}

// A relative home canonicalizes to a relative string, which never equals the
// absolute canonical root. The home check would then pass for every path,
// including the home itself, and nothing would report that it had stopped
// running.
func TestARelativeUserHomeIsRefusedRatherThanCompared(t *testing.T) {
	dir := t.TempDir()
	if got, err := ValidateRoot(dir, "some/home"); err == nil {
		t.Fatalf("a relative user home judged a workspace root anyway: %q", got)
	} else if !strings.Contains(err.Error(), "absolute") {
		t.Errorf("the refusal did not say what was wrong: %v", err)
	}
}
