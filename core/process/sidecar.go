package process

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

const sidecarScheme = "sidecar:"

// resolveCommand turns "sidecar:<name>" into the staged entry point under the
// given home, and leaves every other command untouched.
//
// The home arrives as an argument. Reading it here would make this function
// assume it runs inside the app process, and the same spelling would then
// resolve differently in a daemon or a test.
func resolveCommand(home string, command string) (string, error) {
	name, scheme := strings.CutPrefix(command, sidecarScheme)
	if !scheme {
		return command, nil
	}
	if err := checkSidecarName(name); err != nil {
		return "", err
	}
	if home == "" {
		return "", fmt.Errorf("sidecar %s cannot be resolved: this process was given no home", name)
	}

	unit := "soksak-sidecar-" + name
	components := []string{"sidecars", unit, "dist", unit}
	// The whole path is named up front so a failure states where the sidecar
	// was expected, not only the first component that stopped the walk.
	target := filepath.Join(append([]string{home}, components...)...)

	// Every component is checked from the home downwards. The home itself is
	// not: on macOS the temporary and var trees are symlinks, and a rule that
	// refuses those refuses every legitimate installation.
	path := home
	var info fs.FileInfo
	for _, component := range components {
		path = filepath.Join(path, component)
		read, err := os.Lstat(path)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return "", fmt.Errorf("sidecar %s is not installed at %s: %s is missing — the home needs a staged dist", name, target, path)
			}
			return "", fmt.Errorf("sidecar %s: %s could not be read: %w", name, path, err)
		}
		// A named path wins. A plain is-file check follows links, so an
		// unnamed location could answer for the named one.
		if read.Mode()&fs.ModeSymlink != 0 {
			return "", fmt.Errorf("sidecar %s: %s is a symlink — a named path answers for itself or not at all", name, path)
		}
		info = read
	}

	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("sidecar %s: %s is not a regular file", name, path)
	}
	return path, nil
}

// checkSidecarName holds the whole traversal defence: the name is the only
// thing between a caller and an arbitrary path under the home.
func checkSidecarName(name string) error {
	legal := name != ""
	for index, character := range name {
		lower := character >= 'a' && character <= 'z'
		digit := character >= '0' && character <= '9'
		switch {
		case lower || digit:
		case character == '-' && index > 0:
		default:
			legal = false
		}
	}
	if !legal {
		return fmt.Errorf("sidecar name %q is illegal — it must match ^[a-z0-9][a-z0-9-]*$", name)
	}
	return nil
}
