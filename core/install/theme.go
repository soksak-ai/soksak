package install

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

// themesDirectory is the one place a theme is loaded from.
//
// It is spelled here because this command writes exactly where themes_scan
// reads. If the two ever disagree the install answers a path, the scan answers
// an empty list, and nothing reports a failure.
const themesDirectory = "themes"

// installTheme copies one theme file into the installation's themes directory
// and answers where it landed.
//
// A theme with the same file name is replaced, because installing the same
// theme again is what updating one looks like from the outside.
//
// The destination directory is created here. That is where reading and writing
// part company: a scan of a home with no themes answers an empty list and
// touches nothing, while a write has to have somewhere to write. Leaving the
// creation to the caller makes it happen in the windowed process and not in a
// headless one, and that difference does not travel in the answer.
func installTheme(home string, source string) (string, error) {
	if home == "" {
		return "", i18n.Errorf("install.themeInstall.noHome", nil)
	}
	if source == "" {
		return "", i18n.Errorf("install.themeInstall.noPath", nil)
	}
	if !strings.HasSuffix(source, ".json") {
		return "", i18n.Errorf("install.themeInstall.notJSONFile", map[string]string{"path": source})
	}

	// The file name is taken from the source and nothing else, so the
	// destination cannot leave the themes directory however the source is
	// spelled.
	name := filepath.Base(source)
	if name == "." || name == string(filepath.Separator) {
		return "", i18n.Errorf("install.themeInstall.noFileName", map[string]string{"path": source})
	}

	body, err := os.ReadFile(source)
	if err != nil {
		return "", fmt.Errorf("theme_install could not read %s: %w", source, err)
	}

	directory := filepath.Join(home, themesDirectory)
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return "", fmt.Errorf("theme_install could not create %s: %w", directory, err)
	}

	// Written beside the destination and renamed onto it. A theme is read by
	// the whole application at once, so a half-written file is not a failed
	// install — it is a parse error against a theme the user already had. The
	// staging file shares the destination's directory, so the rename is on one
	// filesystem and is atomic.
	destination := filepath.Join(directory, name)
	staging := destination + ".staging"
	if err := os.WriteFile(staging, body, 0o644); err != nil {
		return "", fmt.Errorf("theme_install could not write %s: %w", staging, err)
	}
	if err := os.Rename(staging, destination); err != nil {
		// A staging file left behind would be scanned as a theme on the next
		// read if it ever ended in .json, and would be debris either way.
		_ = os.Remove(staging)
		return "", fmt.Errorf("theme_install could not place %s: %w", destination, err)
	}
	return destination, nil
}
