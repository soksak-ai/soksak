package install

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
)

// Integrity is what one installed binary looks like on disk.
//
// Three fields rather than one boolean because "installed" is not one fact and
// the repairs differ. A package manager interrupted halfway leaves the library
// tree with no launcher; an upgrade that moved the library leaves a launcher
// pointing at nothing. Through a single boolean both read as "missing", and the
// caller reinstalls — which is right for the second and fails with EEXIST for
// the first, because the leftover has to be removed before anything can be
// written over it.
type Integrity struct {
	// Present is a launcher that exists and resolves.
	Present bool `json:"present"`
	// Partial is the library tree standing with no launcher beside it.
	Partial bool `json:"partial"`
	// Broken is a launcher that is a symlink to nothing.
	Broken bool `json:"broken"`
}

// binaryIntegrity reads the two named paths and says which of the three it is.
//
// Both paths arrive as arguments. Deriving them from a home here would make the
// answer depend on which process asked, and that difference does not arrive as
// an error — it arrives as a different verdict about the same machine.
//
// A path that cannot be read is an error, never absence. Folding
// every failure of the launcher stat into "not there" makes a directory the user
// cannot traverse report as an uninstalled tool, and the repair is a reinstall
// that could not succeed.
func binaryIntegrity(binPath string, libPath string) (Integrity, error) {
	if binPath == "" {
		return Integrity{}, errors.New("binary_integrity needs binPath; an empty path would answer about the current directory")
	}
	if libPath == "" {
		return Integrity{}, errors.New("binary_integrity needs libPath; an empty path would answer about the current directory")
	}

	// Lstat, not Stat: the question about the launcher is what the named path
	// *is*, and following the link first would make a dangling launcher
	// indistinguishable from no launcher at all.
	launcher, err := os.Lstat(binPath)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			return Integrity{}, fmt.Errorf("binary_integrity could not read %s: %w", binPath, err)
		}
		// No launcher. The library tree decides between "nothing is installed"
		// and "an install stopped halfway".
		library, err := libraryStands(libPath)
		if err != nil {
			return Integrity{}, err
		}
		return Integrity{Partial: library}, nil
	}

	if launcher.Mode()&fs.ModeSymlink == 0 {
		return Integrity{Present: true}, nil
	}

	// A symlink resolves or it does not. Stat follows it, so this is the one
	// place the target matters.
	if _, err := os.Stat(binPath); err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			return Integrity{}, fmt.Errorf("binary_integrity could not follow %s: %w", binPath, err)
		}
		return Integrity{Broken: true}, nil
	}
	return Integrity{Present: true}, nil
}

// libraryStands answers whether the library tree is there.
//
// Stat rather than Lstat: a package manager is free to place the tree behind a
// link of its own, and the question here is whether the files are reachable,
// not what the named path is. Unreadable is an error for the same reason as
// above.
func libraryStands(libPath string) (bool, error) {
	if _, err := os.Stat(libPath); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return false, nil
		}
		return false, fmt.Errorf("binary_integrity could not read %s: %w", libPath, err)
	}
	return true, nil
}
