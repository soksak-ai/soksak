package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

type Change struct {
	PreviousRevision uint64 `json:"previousRevision"`
	Revision         uint64 `json:"revision"`
}
type ErrRevisionConflict struct {
	Expected uint64
	Actual   uint64
}

func (err ErrRevisionConflict) Error() string {
	return fmt.Sprintf("settings revision conflict: expected %d, actual %d", err.Expected, err.Actual)
}

func Read(home string) (Document, bool, error) {
	body, err := os.ReadFile(filepath.Join(home, File))
	if errors.Is(err, os.ErrNotExist) {
		return Document{}, false, nil
	}
	if err != nil {
		return Document{}, false, err
	}
	value, err := Parse(body)
	return value, err == nil, err
}
func ReadInstalled(home string) (Installed, bool, error) {
	body, err := os.ReadFile(filepath.Join(home, InstalledFile))
	if errors.Is(err, os.ErrNotExist) {
		return Installed{}, false, nil
	}
	if err != nil {
		return Installed{}, false, err
	}
	value, err := ParseInstalled(body)
	return value, err == nil, err
}
func Write(home string, current Document, exists bool, next Document, expected uint64) (Change, error) {
	actual := uint64(0)
	if exists {
		actual = current.Revision
	}
	if actual != expected {
		return Change{}, ErrRevisionConflict{Expected: expected, Actual: actual}
	}
	if exists {
		next.Revision = actual + 1
	} else {
		next.Revision = 1
	}
	if err := Validate(next); err != nil {
		return Change{}, err
	}
	if err := atomicWrite(home, File, next); err != nil {
		return Change{}, err
	}
	return Change{PreviousRevision: actual, Revision: next.Revision}, nil
}
func WriteInstalled(home string, current Installed, exists bool, next Installed, expected uint64, suffix string) (Change, string, error) {
	actual := uint64(0)
	if exists {
		actual = current.Revision
	}
	if actual != expected {
		return Change{}, "", ErrRevisionConflict{Expected: expected, Actual: actual}
	}
	if exists {
		next.Revision = actual + 1
	} else {
		next.Revision = 1
	}
	if err := ValidateInstalled(next); err != nil {
		return Change{}, "", err
	}
	temporary, err := prepare(home, InstalledFile, next, suffix)
	if err != nil {
		return Change{}, "", err
	}
	return Change{PreviousRevision: actual, Revision: next.Revision}, temporary, nil
}
func PublishInstalled(home, temporary string) error {
	return os.Rename(temporary, filepath.Join(home, InstalledFile))
}
func atomicWrite(home, name string, value any) error {
	temporary, err := prepare(home, name, value, "next")
	if err != nil {
		return err
	}
	return os.Rename(temporary, filepath.Join(home, name))
}
func prepare(home, name string, value any, suffix string) (string, error) {
	if !filepath.IsAbs(home) {
		return "", i18n.Errorf("settings.home.absolute", nil)
	}
	body, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		return "", err
	}
	temporary := filepath.Join(home, name) + "." + suffix
	if err := os.WriteFile(temporary, append(body, byte(10)), 0o600); err != nil {
		return "", err
	}
	return temporary, nil
}

func sortedKeys[T any](values map[string]T) []string {
	result := make([]string, 0, len(values))
	for key := range values {
		result = append(result, key)
	}
	sort.Strings(result)
	return result
}
