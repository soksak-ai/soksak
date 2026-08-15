package install

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// validateDevSource judges a directory offered as a development source and
// answers it back unchanged.
//
// It answers the source rather than a cleaned-up version of it because the
// caller stores what it gets and then reads plugin.json under it. Returning a
// rewritten path would mean the value that was judged and the value that is
// used are two different strings.
//
// Three rules, each failing with its own name:
//
//   - Absolute. A relative source is resolved against a working directory, and
//     this process has no business having one — a window, a headless server and
//     a test would each resolve it somewhere else.
//   - No link in any component. A named path answers for itself or not at all
//     (AGENTS.md). Checking only the last component is not a check: an
//     intermediate link moves the whole subtree, and it moves it after the
//     check passed.
//   - It exists and is a directory. A source that is a file is not half-valid.
func validateDevSource(source string) (string, error) {
	if source == "" {
		return "", errors.New("unit_dev_validate_path needs source; an empty path names no directory")
	}
	if !filepath.IsAbs(source) {
		return "", fmt.Errorf("unit_dev_validate_path: %s is relative — a development source is an absolute path, because a relative one is resolved against a working directory this process does not have", source)
	}
	if err := rejectLinkedComponents(source); err != nil {
		return "", err
	}

	read, err := os.Stat(source)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", fmt.Errorf("unit_dev_validate_path: %s does not exist", source)
		}
		return "", fmt.Errorf("unit_dev_validate_path could not read %s: %w", source, err)
	}
	if !read.IsDir() {
		return "", fmt.Errorf("unit_dev_validate_path: %s is not a directory", source)
	}
	return source, nil
}

// rejectLinkedComponents refuses a path that reaches its destination through a
// link, and refuses `..` outright.
//
// `..` is refused rather than resolved. Resolving it makes the path that was
// judged and the path that is stored two different strings, and the caller
// stores the one it sent.
//
// A component that does not exist is skipped rather than refused. Absence is
// not a link, and the walk has to continue so a link further along is still
// found — existence is the last rule's question, not this one's.
func rejectLinkedComponents(path string) error {
	// The path is split as it was written, never cleaned first: Clean resolves
	// `..` away, and a walk over the cleaned form would never meet the
	// component this rule exists to refuse.
	volume := filepath.VolumeName(path)
	walk := volume + string(filepath.Separator)

	for _, component := range pathComponents(path[len(volume):]) {
		if component == ".." {
			return fmt.Errorf("unit_dev_validate_path: %s walks through '..' — a development source names where it is, so the path that is judged is the path that is stored", path)
		}
		walk = filepath.Join(walk, component)
		read, err := os.Lstat(walk)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			return fmt.Errorf("unit_dev_validate_path could not read %s: %w", walk, err)
		}
		if read.Mode()&fs.ModeSymlink != 0 {
			return fmt.Errorf("unit_dev_validate_path: %s is a symlink — a named path answers for itself or not at all", walk)
		}
	}
	return nil
}

// pathComponents breaks an absolute path's body into its named parts, dropping
// the empty ones the separators leave behind.
//
// Both separators are split on, not only this platform's. A Windows path may be
// written with forward slashes and is accepted by the operating system, so a
// splitter that only knew backslashes would hand a whole subtree back as one
// component and walk past every link in it.
func pathComponents(body string) []string {
	parts := []string{}
	for _, part := range strings.FieldsFunc(body, func(character rune) bool {
		return character == '/' || character == filepath.Separator
	}) {
		if part != "" && part != "." {
			parts = append(parts, part)
		}
	}
	return parts
}
