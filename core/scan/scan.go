// Package scan reads installation directories.
//
// One rule shapes everything here: a directory that does not exist is an empty
// list, and a directory that cannot be read is an error. Collapsing the two
// makes a permissions problem look like an empty catalogue, and it makes one
// command name answer differently depending on which process asked — the app
// creates its home before scanning, a daemon reading someone else's home does
// not, so only one of them ever meets absence.
package scan

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Entry is one file found by a scan, with what it contained.
type Entry struct {
	Path     string `json:"path"`
	Contents string `json:"contents"`
}

// Directory lists files under dir whose name ends with suffix.
//
// Results are sorted by name: the caller renders them, and directory order is
// not stable across filesystems.
func Directory(dir string, suffix string) ([]Entry, error) {
	items, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			// Nothing installed. A read command never creates the directory,
			// so absence is an ordinary answer rather than a failure.
			return []Entry{}, nil
		}
		return nil, fmt.Errorf("scan could not read %s: %w", dir, err)
	}

	entries := make([]Entry, 0, len(items))
	for _, item := range items {
		if item.IsDir() || !strings.HasSuffix(item.Name(), suffix) {
			continue
		}
		path := filepath.Join(dir, item.Name())
		contents, err := os.ReadFile(path)
		if err != nil {
			// One unreadable file does not make the rest unreadable, and the
			// caller can still see what is installed.
			continue
		}
		entries = append(entries, Entry{Path: path, Contents: string(contents)})
	}

	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	return entries, nil
}
