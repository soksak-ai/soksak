package install

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/soksak/soksak-core/core/i18n"
	"github.com/soksak/soksak-core/core/scan"
)

// A development source points a unit id at a working tree.
//
// A committed unit is a directory under <home>/plugins holding plugin.json. A
// development source is the other case: the tree is somewhere the author works,
// and it must not be copied into the home, because a copy diverges from what the
// author edits and the divergence shows up as a plugin that ignores a fix.
//
// The declaration is one file rather than one file per unit. A reader that has
// to list a directory to learn what is declared cannot tell an empty
// declaration from a home that was never written to, and both answer "nothing
// is declared" while meaning different things.
const devSourceFile = "config/development-units.json"

// devSourceVersion is the shape this build writes and the only one it reads.
//
// A version that does not match is refused rather than migrated. This build
// ships to nobody, so a file from another version is a mistake rather than
// history, and reading it as if it were this shape would answer with a source
// nobody declared.
const devSourceVersion = 1

// DevSource is one declaration, and the shape the frontend already sends.
type DevSource struct {
	// Kind is what the tree is: "plugin", "sidecar" or "kit". The loader reads
	// a different manifest for each, so a wrong kind is not a smaller error.
	Kind string `json:"kind"`
	// ID is the unit id the source stands in for.
	ID string `json:"id"`
	// Source is the absolute path of the working tree, exactly as the caller
	// gave it — validateDevSource answers the path it judged, not a cleaned-up
	// one, so what was checked and what is stored are one string.
	Source string `json:"source"`
}

type devSourceFileShape struct {
	Version int         `json:"version"`
	Units   []DevSource `json:"units"`
}

var devSourceKinds = map[string]bool{"plugin": true, "sidecar": true, "kit": true}

// readDevSources answers what is declared.
//
// A home with no declaration answers an empty list, not an error: nothing
// declared is an ordinary state. A declaration that cannot be parsed is an
// error, because answering "nothing is declared" for a file that exists would
// hide the file from the person who wrote it.
func readDevSources(home string) ([]DevSource, error) {
	if home == "" {
		return nil, i18n.Errorf("install.devSource.noHome", nil)
	}
	path := filepath.Join(home, devSourceFile)
	body, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []DevSource{}, nil
		}
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	var file devSourceFileShape
	if err := json.Unmarshal(body, &file); err != nil {
		return nil, i18n.Wrap(err, "install.devSource.unreadable", map[string]string{"path": path})
	}
	if file.Version != devSourceVersion {
		return nil, i18n.Errorf("install.devSource.version", map[string]string{
			"path": path, "found": itoa(file.Version), "want": itoa(devSourceVersion),
		})
	}
	if file.Units == nil {
		file.Units = []DevSource{}
	}
	sort.Slice(file.Units, func(i, j int) bool {
		if file.Units[i].Kind != file.Units[j].Kind {
			return file.Units[i].Kind < file.Units[j].Kind
		}
		return file.Units[i].ID < file.Units[j].ID
	})
	return file.Units, nil
}

// writeDevSource declares one source, replacing any declaration for the same
// kind and id.
//
// The source is validated before anything is written. A declaration that names
// a tree with no manifest would be accepted by the loader and then produce
// nothing, and the author would look for the defect in the unit.
//
// The path is not required to hold a unit yet. An author declares the tree and
// then writes plugin.json into it, and refusing that order would make the
// declaration usable only after the work it is for is finished.
func writeDevSource(home string, entry DevSource) (DevSource, error) {
	if home == "" {
		return DevSource{}, i18n.Errorf("install.devSource.noHome", nil)
	}
	if !devSourceKinds[entry.Kind] {
		return DevSource{}, i18n.Errorf("install.devSource.kind", map[string]string{"kind": entry.Kind})
	}
	if err := scan.ValidUnitID(entry.ID); err != nil {
		return DevSource{}, err
	}
	source, err := validateDevSource(entry.Source)
	if err != nil {
		return DevSource{}, err
	}
	entry.Source = source

	existing, err := readDevSources(home)
	if err != nil {
		return DevSource{}, err
	}
	kept := existing[:0:0]
	for _, had := range existing {
		if had.Kind == entry.Kind && had.ID == entry.ID {
			continue
		}
		kept = append(kept, had)
	}
	kept = append(kept, entry)
	sort.Slice(kept, func(i, j int) bool {
		if kept[i].Kind != kept[j].Kind {
			return kept[i].Kind < kept[j].Kind
		}
		return kept[i].ID < kept[j].ID
	})

	path := filepath.Join(home, devSourceFile)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return DevSource{}, fmt.Errorf("creating %s: %w", filepath.Dir(path), err)
	}
	body, err := json.MarshalIndent(devSourceFileShape{Version: devSourceVersion, Units: kept}, "", "  ")
	if err != nil {
		return DevSource{}, fmt.Errorf("encoding %s: %w", path, err)
	}
	// Written whole, through a temporary file in the same directory, then
	// renamed. A partial write leaves a file that parses as nothing and takes
	// every other declaration with it.
	temporary := path + ".writing"
	if err := os.WriteFile(temporary, append(body, '\n'), 0o600); err != nil {
		return DevSource{}, fmt.Errorf("writing %s: %w", temporary, err)
	}
	if err := os.Rename(temporary, path); err != nil {
		return DevSource{}, fmt.Errorf("renaming %s: %w", temporary, err)
	}
	return entry, nil
}

func itoa(value int) string { return fmt.Sprintf("%d", value) }
