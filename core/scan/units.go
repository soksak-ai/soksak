package scan

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

// Unit is one installed unit directory and the two files inside it.
//
// Both file contents are raw text. Validation is the frontend spec's, and it is
// the only one — a second parser here would accept a manifest the spec refuses,
// or refuse one it accepts, and only one of the two ever reports to the user.
type Unit struct {
	Dir      string  `json:"dir"`
	DirName  string  `json:"dir_name"`
	Manifest *string `json:"manifest"`
	State    *string `json:"state"`
	Error    *string `json:"error"`
}

// manifestFile is the unit's declaration. stateFile is the install record
// written at install time; a development checkout has none.
const (
	manifestFile = "plugin.json"
	stateFile    = ".soksak.json"
)

// Units lists the immediate subdirectories of base, sorted by name.
//
// Files and names starting with "." are skipped, which is what excludes an
// install's staging directories (.tmp-*) without a second rule for them.
//
// A unit whose plugin.json cannot be read stays in the list with the reason in
// Error. Removing it from the list shows the user "not installed", and that
// wrong answer arrives with nothing to look at.
//
// A base that does not exist is an empty list; a base that cannot be read is an
// error. Collapsing the two makes a permissions problem look like an empty
// catalogue, and it makes one command name answer differently depending on
// which process called it (measured 2026-07-28: the app creates its home before
// scanning, a daemon reading another home does not).
func Units(base string) ([]Unit, error) {
	items, err := os.ReadDir(base)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []Unit{}, nil
		}
		return nil, fmt.Errorf("scan could not read %s: %w", base, err)
	}

	units := make([]Unit, 0, len(items))
	for _, item := range items {
		name := item.Name()
		if !item.IsDir() || strings.HasPrefix(name, ".") {
			continue
		}
		dir := filepath.Join(base, name)
		unit := Unit{Dir: dir, DirName: name}
		if contents, readErr := os.ReadFile(filepath.Join(dir, manifestFile)); readErr == nil {
			text := string(contents)
			unit.Manifest = &text
		} else {
			reason := fmt.Sprintf("%s could not be read: %v", manifestFile, readErr)
			unit.Error = &reason
		}
		// Absence of the install record is ordinary: a development checkout has
		// no install to record.
		if contents, readErr := os.ReadFile(filepath.Join(dir, stateFile)); readErr == nil {
			text := string(contents)
			unit.State = &text
		}
		units = append(units, unit)
	}

	sort.Slice(units, func(i, j int) bool { return units[i].DirName < units[j].DirName })
	return units, nil
}

// ValidUnitID refuses an id that cannot name a directory under the home.
//
// The rule is ^[a-z0-9][a-z0-9-]*$. Path escape is blocked by the charset
// itself: neither "." nor "/" is a legal character, so "..", "a/b" and absolute
// paths are already outside it. Keep this check in one place — a second, looser
// copy opens the home on that side only, and the difference is invisible from
// the side that refused.
func ValidUnitID(id string) error {
	if id == "" {
		return i18n.Errorf("scan.unitId.empty", nil)
	}
	for index, char := range id {
		lower := char >= 'a' && char <= 'z'
		digit := char >= '0' && char <= '9'
		hyphen := char == '-' && index > 0
		if !lower && !digit && !hyphen {
			return i18n.Errorf("scan.unitId.illegal", map[string]string{"id": id})
		}
	}
	return nil
}

// RemoveUnit deletes an installed unit directory under base.
//
// Absence is refused rather than reported as success: a typo would otherwise
// pass as a removal that never happened.
//
// A unit's private data directory is outside base and is left alone. Deleting
// it here would make a reinstall start empty, and the user's loss shows up as a
// plugin with default settings rather than as an error.
//
// Installed trees in this build are writable. When the install transaction
// lands it will lock them read-only (chmod -R a-w), and removal will have to
// unlock before deleting — a locked tree refuses remove_dir_all, and the
// failure reads as a permissions problem with no sign that order is the cause.
func RemoveUnit(base, id string) error {
	if err := ValidUnitID(id); err != nil {
		return err
	}
	dir := filepath.Join(base, id)
	if _, err := os.Stat(dir); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return i18n.Errorf("scan.removeUnit.notInstalled", map[string]string{"dir": dir})
		}
		return err
	}
	return os.RemoveAll(dir)
}
