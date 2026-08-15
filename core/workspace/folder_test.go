package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Restore and retry paths call this more than once for one workspace, so the
// second call has to be an ordinary answer rather than "it already exists".
func TestAWorkspaceFolderIsCreatedUnderTheIdentityHomeAndIsIdempotent(t *testing.T) {
	home := t.TempDir()
	want := filepath.Join(home, "workspaces", "my-app")

	got, err := EnsureDir("my-app", home)
	if err != nil {
		t.Fatalf("creating the workspace folder: %v", err)
	}
	if got != want {
		t.Errorf("path = %q, want %q", got, want)
	}
	info, err := os.Stat(want)
	if err != nil || !info.IsDir() {
		t.Fatalf("the folder was not created: err=%v", err)
	}

	again, err := EnsureDir("my-app", home)
	if err != nil {
		t.Fatalf("the second call failed: %v", err)
	}
	if again != got {
		t.Errorf("the second call answered %q, want %q", again, got)
	}
}

// A slash lets the argument leave workspaces/ entirely, which is the reason the
// contract is a slug and not a name.
func TestAFolderNameThatIsNotASlugIsRefusedWithThePattern(t *testing.T) {
	home := t.TempDir()
	for _, folder := range []string{"", "-lead", "My App", "a_b", "a/b", "../etc"} {
		got, err := EnsureDir(folder, home)
		if err == nil {
			t.Errorf("%q was accepted and created %q", folder, got)
			continue
		}
		if !strings.Contains(err.Error(), "^[a-z0-9][a-z0-9-]*$") {
			t.Errorf("refusing %q did not carry the pattern: %v", folder, err)
		}
	}
	if entries, err := os.ReadDir(filepath.Join(home, "workspaces")); err == nil && len(entries) > 0 {
		t.Errorf("a refused name still created something: %v", entries)
	}
}

// With no identity home this would create workspaces/ beside whatever directory
// the process happens to be in, and that is a different tree per process.
func TestWithoutAnIdentityHomeTheFolderIsRefusedByName(t *testing.T) {
	_, err := EnsureDir("my-app", "")
	if err == nil {
		t.Fatal("a process with no identity home created a workspace folder anyway")
	}
	if !strings.Contains(err.Error(), "identity home") {
		t.Errorf("the refusal did not say what to supply: %v", err)
	}
}

// The empty case is refused loudly and the relative case lands in exactly the
// same place — workspaces/ beside whichever directory the process was started
// in. One of the two being caught is not the rule being kept.
func TestARelativeIdentityHomeIsRefusedByName(t *testing.T) {
	// The working directory is moved somewhere disposable first. A relative
	// home is resolved against it, so a run where the rule is broken writes
	// into that directory — and without this it is the package source tree.
	t.Chdir(t.TempDir())

	got, err := EnsureDir("my-app", filepath.Join("relative", "home"))
	if err == nil {
		t.Fatalf("a relative identity home created %q", got)
	}
	if !strings.Contains(err.Error(), "absolute") {
		t.Errorf("the refusal did not say what was wrong: %v", err)
	}
	if entries, err := os.ReadDir(filepath.Join("relative", "home", "workspaces")); err == nil && len(entries) > 0 {
		t.Errorf("a refused identity home still created something: %v", entries)
	}
}
