package install

import (
	"os"
	"path/filepath"
	"testing"
)

// TestThreeStatesOfAnInstallStayApart is the whole reason this command answers
// three fields instead of one.
//
// A package manager interrupted halfway leaves the library tree with no
// launcher; an upgrade that moved the library leaves a launcher pointing at
// nothing. Folded into one boolean both read as "missing", and the caller
// reinstalls — which is right for the second and fails with EEXIST for the
// first, because the leftover has to be removed first.
func TestThreeStatesOfAnInstallStayApart(t *testing.T) {
	home := t.TempDir()
	bin := filepath.Join(home, "bin")
	lib := filepath.Join(home, "lib")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatalf("making bin: %v", err)
	}

	installed := filepath.Join(bin, "installed")
	if err := os.WriteFile(installed, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("writing the launcher: %v", err)
	}
	tree := filepath.Join(lib, "node_modules", "half")
	if err := os.MkdirAll(tree, 0o755); err != nil {
		t.Fatalf("making the library tree: %v", err)
	}
	dangling := filepath.Join(bin, "dangling")
	if err := os.Symlink(filepath.Join(home, "gone"), dangling); err != nil {
		t.Fatalf("making the dangling launcher: %v", err)
	}

	for _, want := range []struct {
		what      string
		bin, lib  string
		integrity Integrity
	}{
		{"a launcher that is there", installed, tree, Integrity{Present: true}},
		{"a library tree with no launcher", filepath.Join(bin, "half"), tree, Integrity{Partial: true}},
		{"a launcher linked to nothing", dangling, tree, Integrity{Broken: true}},
		{"nothing at all", filepath.Join(bin, "absent"), filepath.Join(lib, "node_modules", "absent"), Integrity{}},
	} {
		got, err := binaryIntegrity(want.bin, want.lib)
		if err != nil {
			t.Fatalf("%s: %v", want.what, err)
		}
		if got != want.integrity {
			t.Errorf("%s: integrity = %+v, want %+v", want.what, got, want.integrity)
		}
	}
}

// TestAResolvingLinkIsPresent separates the two symlink cases. A version
// manager installs every global launcher as a link, so reading "symlink" as
// "broken" would report a working machine as entirely broken.
func TestAResolvingLinkIsPresent(t *testing.T) {
	home := t.TempDir()
	target := filepath.Join(home, "real")
	if err := os.WriteFile(target, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("writing the target: %v", err)
	}
	link := filepath.Join(home, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("linking: %v", err)
	}

	got, err := binaryIntegrity(link, filepath.Join(home, "lib"))
	if err != nil {
		t.Fatalf("reading: %v", err)
	}
	if got != (Integrity{Present: true}) {
		t.Fatalf("integrity = %+v, want present", got)
	}
}

// TestAPathThatCannotBeReadIsNotAbsence is an earlier build's defect, ported as
// a test rather than as code.
//
// Its Rust original folded every failure of the launcher stat into "not there", so a
// directory the user cannot traverse reported as an uninstalled tool and the
// repair offered was a reinstall that could not succeed.
//
// The unreadable path here is one that goes *through* a regular file, which is
// ENOTDIR — not ErrNotExist, and reproducible without changing any permission
// bits (running as root would defeat a chmod-based test).
func TestAPathThatCannotBeReadIsNotAbsence(t *testing.T) {
	home := t.TempDir()
	blocker := filepath.Join(home, "file")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatalf("writing the blocker: %v", err)
	}
	through := filepath.Join(blocker, "launcher")

	if _, err := binaryIntegrity(through, filepath.Join(home, "lib")); err == nil {
		t.Fatal("a path that could not be read answered as absence")
	}
	if _, err := binaryIntegrity(filepath.Join(home, "no-launcher"), through); err == nil {
		t.Fatal("an unreadable library path answered as absence")
	}
}

// TestAnEmptyPathIsRefusedByName stops the answer from being about the process's
// own directory. Empty is what a caller sends when a path it meant to compose
// came out blank, and "present" about the current directory is a wrong answer
// that looks like a fact.
func TestAnEmptyPathIsRefusedByName(t *testing.T) {
	if _, err := binaryIntegrity("", "/lib"); err == nil {
		t.Error("an empty binPath was accepted")
	}
	if _, err := binaryIntegrity("/bin/x", ""); err == nil {
		t.Error("an empty libPath was accepted")
	}
}
