package files

import (
	"fmt"
	"path/filepath"
	"strings"
)

// noUserHome is the refusal a call that needs a home gets when it was not given
// one.
//
// It names what to supply because the alternative — reading this process's own
// home — makes the same command answer with a different tree depending on which
// process asked, and that wrong answer arrives as a different listing rather
// than as a failure.
//
// The value asked for is deliberately not the identity home. Two homes exist:
// the OS user's (`~`), which the file tree and `~` expansion see, and the
// installation's (`~/.soksak-wails`), where the app keeps what it owns. main.go
// already reads HOME into identity.Environment, so both values are in the
// wiring's hand and passing identity.Resolved.Home here would root the whole
// file tree inside the app's own folder.
const noUserHome = "this call needs the OS user home and this process was not given one — set files.Deps.UserHome (never identity.Resolved.Home)"

// requireHome answers the home or refuses by name.
func requireHome(home string) (string, error) {
	if home == "" {
		return "", fmt.Errorf("%s", noUserHome)
	}
	return home, nil
}

// expand resolves a leading `~` against the injected home.
//
// The home is only required when the path actually uses it: a process that was
// given no home still answers absolute paths, so one thing it cannot do does
// not block the rest.
//
// `~someone/x` is left literal. Resolving another user's home needs the user
// database, and guessing it as <home>/someone would read a tree nobody named.
func expand(path string, home string) (string, error) {
	if path != "~" && !strings.HasPrefix(path, "~/") {
		return path, nil
	}
	resolved, err := requireHome(home)
	if err != nil {
		return "", err
	}
	if path == "~" {
		return resolved, nil
	}
	return filepath.Join(resolved, strings.TrimPrefix(path, "~/")), nil
}
