package store

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// A plugin's private storage — files, not the database.
//
// The layout is one flat plane: `<base>/<id>/<key>.json`. Nothing here touches
// the connection, so a plugin writing a megabyte of its own state does not sit
// in the same lock as everything else.

const pluginValueSuffix = ".json"

func pluginValuePath(base, id, key string) string {
	return filepath.Join(base, id, key+pluginValueSuffix)
}

// readPluginData answers the stored text, and whether there was any.
//
// Absence is not failure: the caller falls back to a default on absence, and if
// "not there" and "could not read" become the same value, a permissions problem
// looks like "never saved".
//
// The text is carried as it was written and never parsed and re-emitted: parse
// and re-print, and what you stored differs from what you get back — key order,
// number formatting — and only the plugin using it ever sees that.
func readPluginData(base, id, key string) (string, bool, error) {
	if err := validatePluginID(id); err != nil {
		return "", false, err
	}
	if err := validatePluginKey(key); err != nil {
		return "", false, err
	}
	contents, err := os.ReadFile(pluginValuePath(base, id, key))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("store: reading the %s value of %s: %w", key, id, err)
	}
	return string(contents), true, nil
}

// writePluginData stores the text as it arrived, creating its own parents. A
// first write that leaned on a layout boot had made would fail in a process
// that does not make one.
func writePluginData(base, id, key, value string) error {
	if err := validatePluginID(id); err != nil {
		return err
	}
	if err := validatePluginKey(key); err != nil {
		return err
	}
	directory := filepath.Join(base, id)
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return fmt.Errorf("store: could not create %s: %w", directory, err)
	}
	// Written to a neighbour and renamed over the target, never into the target. A reader that
	// arrives mid-write of a plain write sees a file that is half the old value and half the new
	// one, and a write that dies mid-way leaves that on disk permanently. Rename within one
	// directory is atomic, so a reader sees the whole old value or the whole new one.
	//
	// Each write gets its own neighbour rather than one name per process. Measured: with a shared
	// name, two writes of one key overwrite each other's neighbour and the rename publishes a file
	// that is half of each — the same splice the plain write produced, moved one step later.
	//
	// Two writers still race for which lands last, and that race the caller settles. What this
	// removes is the third outcome, where neither value is what is on disk.
	target := pluginValuePath(base, id, key)
	staged, err := os.CreateTemp(directory, key+pluginValueSuffix+".*.next")
	if err != nil {
		return fmt.Errorf("store: staging the %s value of %s: %w", key, id, err)
	}
	name := staged.Name()
	if _, err := staged.WriteString(value); err != nil {
		staged.Close()
		os.Remove(name)
		return fmt.Errorf("store: writing the %s value of %s: %w", key, id, err)
	}
	if err := staged.Close(); err != nil {
		os.Remove(name)
		return fmt.Errorf("store: writing the %s value of %s: %w", key, id, err)
	}
	if err := os.Chmod(name, 0o644); err != nil {
		os.Remove(name)
		return fmt.Errorf("store: writing the %s value of %s: %w", key, id, err)
	}
	if err := os.Rename(name, target); err != nil {
		os.Remove(name)
		return fmt.Errorf("store: publishing the %s value of %s: %w", key, id, err)
	}
	return nil
}

// listPluginData names what this plugin stored, sorted, with the suffix
// stripped so a listed name is directly a read argument.
//
// A directory that was never created is an empty list; a directory that cannot
// be read is an error. Reads never create it: that changes none of the three
// commands' answers, and only the side effect would differ per process.
func listPluginData(base, id string) ([]string, error) {
	if err := validatePluginID(id); err != nil {
		return nil, err
	}
	directory := filepath.Join(base, id)
	items, err := os.ReadDir(directory)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []string{}, nil
		}
		return nil, fmt.Errorf("store: reading the storage of %s: %w", id, err)
	}
	keys := make([]string, 0, len(items))
	for _, item := range items {
		if item.IsDir() || !strings.HasSuffix(item.Name(), pluginValueSuffix) {
			continue
		}
		keys = append(keys, strings.TrimSuffix(item.Name(), pluginValueSuffix))
	}
	sort.Strings(keys)
	return keys, nil
}

// deletePluginData takes back one value a plugin stored.
//
// Without it a record outlives the thing it was for and nothing addresses it — a session that
// closed, a view that is gone, a key a build stopped writing — and the store grows by everything
// that ever existed with no command able to shrink it.
//
// Deleting what was never written is not a failure: the outcome the caller wanted is the outcome it
// has, and a refusal would make a caller handle a case that is already what it asked for.
func deletePluginData(base, id, key string) error {
	if err := validatePluginID(id); err != nil {
		return err
	}
	if err := validatePluginKey(key); err != nil {
		return err
	}
	if err := os.Remove(pluginValuePath(base, id, key)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("store: removing the %s value of %s: %w", key, id, err)
	}
	return nil
}
