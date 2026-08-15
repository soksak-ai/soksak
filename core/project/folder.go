package project

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"

	"github.com/soksak/soksak-core/core/i18n"
)

// folderPattern is the directory-name contract for an app-made project folder.
//
// A slug and nothing else: `a/b` and `../etc` would both let the argument leave
// projects/, and the folder is created from it without a second look.
var folderPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

// EnsureDir creates <identity home>/projects/<folder> and answers with it.
//
// The identity home, not the user home: a folder the app made is in the area
// the app manages. This is the one place in this package that wants that home,
// and passing the wrong one puts a project root inside the app's own tree.
//
// Repeating the call is an ordinary answer, not a conflict — restore and retry
// paths reach it more than once for one project.
func EnsureDir(folder string, identityHome string) (string, error) {
	if identityHome == "" {
		// Joining onto "" would create projects/ relative to whatever directory
		// this process was started in, so the same call would land in a
		// different tree per process.
		return "", i18n.Errorf("project.ensureDir.noIdentityHome", nil)
	}
	if !filepath.IsAbs(identityHome) {
		// A relative one lands in that same different tree per process; only
		// the empty case is loud about it. And the path returned from here is
		// handed straight to the root verdict, which judges absolute paths.
		return "", i18n.Errorf("project.ensureDir.relativeIdentityHome", map[string]string{"home": identityHome})
	}
	if !folderPattern.MatchString(folder) {
		return "", i18n.Errorf("project.ensureDir.notASlug", map[string]string{"folder": folder})
	}

	dir := filepath.Join(identityHome, "projects", folder)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("could not create %s: %w", dir, err)
	}
	return dir, nil
}
