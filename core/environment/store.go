package environment

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
	return fmt.Sprintf("environment revision conflict: expected %d, actual %d", err.Expected, err.Actual)
}

func Read(home string) (Environment, bool, error) {
	body, err := os.ReadFile(filepath.Join(home, File))
	if errors.Is(err, os.ErrNotExist) {
		return Environment{}, false, nil
	}
	if err != nil {
		return Environment{}, false, err
	}
	value, err := Parse(body)
	if err != nil {
		// Include the document path because Parse errors contain only shape details.
		return Environment{}, false, fmt.Errorf("%s: %w", filepath.Join(home, File), err)
	}
	return value, true, nil
}
func Initialize(home string) error {
	_, exists, err := Read(home)
	if err != nil || exists {
		return err
	}
	_, err = Write(home, Environment{}, false, Empty(), 0)
	return err
}
func Write(home string, current Environment, exists bool, next Environment, expected uint64) (Change, error) {
	change, temporary, err := PrepareWrite(home, current, exists, next, expected, "next")
	if err != nil {
		return Change{}, err
	}
	if err := Publish(home, temporary); err != nil {
		return Change{}, err
	}
	return change, nil
}
func PrepareWrite(home string, current Environment, exists bool, next Environment, expected uint64, suffix string) (Change, string, error) {
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
	if err := Validate(next); err != nil {
		return Change{}, "", err
	}
	temporary, err := prepare(home, File, next, suffix)
	if err != nil {
		return Change{}, "", err
	}
	return Change{PreviousRevision: actual, Revision: next.Revision}, temporary, nil
}
func Publish(home, temporary string) error {
	return os.Rename(temporary, filepath.Join(home, File))
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
		return "", i18n.Errorf("environment.home.absolute", nil)
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
