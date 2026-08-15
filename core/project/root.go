// Package project determines what may be a project root, where app-made project
// folders live, which window holds which root, and what a window leaves behind
// for the next boot.
//
// Nothing here reads the process environment. The two homes it needs — the OS
// user home and the identity home — arrive as arguments, because a rule that
// reads its own home answers differently in a window, in a headless server, and
// in a test, and that difference surfaces as a different answer rather than as
// an error.
package project

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/soksak/soksak-core/core/i18n"
)

// Verdict reports whether a canonical path may be a project root.
//
// It touches no disk: existence and canonicalization are the caller's, so the
// same rule can be asked from any process and give the same answer.
func Verdict(canonical string, home string) error {
	if canonical == home {
		// A root-init policy (git init and the rest, once per project.created)
		// runs over the whole root. With the home as the root, that policy runs
		// over every file the user owns.
		return i18n.Errorf("project.root.home", map[string]string{"path": canonical})
	}
	if filepath.Dir(canonical) == canonical {
		// True for "/" and for "C:\\" alike, so the filesystem root is refused
		// on every platform by one line and no branch on which one we are.
		return i18n.Errorf("project.root.filesystemRoot", map[string]string{"path": canonical})
	}
	return nil
}

// ValidateRoot answers whether path may be a project root, and returns the
// canonical spelling of it.
//
// That returned string is the project's identity: duplicate checks and claims
// key on it, so two spellings of one directory must not become two projects.
// Both path and the home must be absolute for that to hold — see below.
//
// Symlinks are resolved, not refused. Refusing them is the installer's
// surface, which materializes files in our own tree and has to care that a
// planted link redirects a write. Here the user is browsing their own disk, and
// a refusal makes a whole tree with a symlinked work folder unopenable.
func ValidateRoot(path string, userHome string) (string, error) {
	if userHome == "" {
		// Named rather than guessed. A process that reads its own home walks a
		// different tree, and skipping the check instead would quietly admit
		// the home itself.
		return "", i18n.Errorf("project.validateRoot.noUserHome", nil)
	}

	if !filepath.IsAbs(userHome) {
		// A relative home canonicalizes to a relative string, which can never
		// equal the absolute canonical root, so the home comparison would pass
		// every time instead of failing — the check would be gone and nothing
		// would say so.
		return "", i18n.Errorf("project.validateRoot.relativeUserHome", map[string]string{"home": userHome})
	}
	if !filepath.IsAbs(path) {
		// Resolving it against the working directory instead is the one ambient
		// read this package would still have: the app process and a headless
		// one are started in different directories, so the same argument would
		// name two different roots, and the claim table keys on that string.
		// Two spellings of one directory then become two projects.
		return "", i18n.Errorf("project.validateRoot.relativePath", map[string]string{"path": path})
	}

	// No tilde expansion, here or anywhere in this package. The home is needed
	// for the verdict alone; expanding as well would make one path mean two
	// things depending on who asked.
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		return "", i18n.Errorf("project.validateRoot.notDirectory", map[string]string{"path": path})
	}

	canonical, err := canonicalize(path)
	if err != nil {
		return "", fmt.Errorf("could not canonicalize %s: %w", path, err)
	}
	// The home is canonicalized too: on darwin <local-evidence>/x is <local-evidence>/x, and two
	// spellings of one home must not disagree about whether this is the home.
	home, err := canonicalize(userHome)
	if err != nil {
		// An unreadable home is not a verdict of "allowed" — the comparison it
		// was needed for cannot be made.
		return "", fmt.Errorf("could not canonicalize the user home %s: %w", userHome, err)
	}

	if err := Verdict(canonical, home); err != nil {
		return "", err
	}
	return canonical, nil
}

// canonicalize resolves links and nothing else. Both arguments are absolute
// before they get here, so there is no working directory to consult — and
// consulting one is what would make this package answer differently per
// process.
func canonicalize(path string) (string, error) {
	return filepath.EvalSymlinks(path)
}
