package environment

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

// ArtifactDeleteFailure names a renamed artifact directory that remains after
// the record was removed.
type ArtifactDeleteFailure struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

// RemoveResult is the answer of a removal. The record removal is the state
// change; ArtifactDeleteFailed is set when <dir>.removing was not deleted
// afterwards.
type RemoveResult struct {
	Change
	ArtifactDeleteFailed *ArtifactDeleteFailure `json:"artifactDeleteFailed,omitempty"`
}

// RemovePlugin removes the record for plugin id and, for a local or registry
// record, deletes the artifact directory at record.path. A development record's
// source directory is kept. A record whose path is not under <home>/components
// is refused.
func RemovePlugin(home, id string, expected uint64) (RemoveResult, error) {
	current, exists, err := Read(home)
	if err != nil {
		return RemoveResult{}, err
	}
	if !exists {
		return RemoveResult{}, os.ErrNotExist
	}
	record, found := current.Plugins[id]
	if !found {
		return RemoveResult{}, i18n.Errorf("environment.remove.notFound", map[string]string{"kind": "plugin", "id": id})
	}
	next := current
	delete(next.Plugins, id)
	return remove(home, current, next, record.Component, expected)
}

// RemoveSidecar removes the record for sidecar id under the same rule as
// RemovePlugin.
func RemoveSidecar(home, id string, expected uint64) (RemoveResult, error) {
	current, exists, err := Read(home)
	if err != nil {
		return RemoveResult{}, err
	}
	if !exists {
		return RemoveResult{}, os.ErrNotExist
	}
	record, found := current.Sidecars[id]
	if !found {
		return RemoveResult{}, i18n.Errorf("environment.remove.notFound", map[string]string{"kind": "sidecar", "id": id})
	}
	next := current
	delete(next.Sidecars, id)
	return remove(home, current, next, record, expected)
}

// remove deletes <candidate>.removing, renames the artifact directory of a
// non-development record to <candidate>.removing when it exists, publishes
// next, then deletes the renamed directory. <candidate> is the record path with
// its parent chain resolved (artifactCandidate); the deletion of
// <candidate>.removing runs whether or not <candidate> exists, so a crash
// between an earlier rename and write leaves nothing behind. When
// <candidate>.removing cannot be deleted nothing changes. A write failure
// renames the directory back. A failed final deletion is data on the successful
// result: the record is removed, the content-addressed path is free, and
// <candidate>.removing remains.
func remove(home string, current, next Environment, record Component, expected uint64) (RemoveResult, error) {
	candidate := ""
	if record.Source != DevelopmentSource {
		resolved, err := artifactCandidate(home, record.Path)
		if err != nil {
			return RemoveResult{}, err
		}
		candidate = resolved
	}
	if err := ValidatePluginDependencies(next, nil); err != nil {
		return RemoveResult{}, err
	}
	removing := ""
	if candidate != "" {
		stale := candidate + ".removing"
		if err := os.RemoveAll(stale); err != nil {
			return RemoveResult{}, i18n.Wrap(err, "environment.remove.artifactDeleteFailed", map[string]string{"path": stale, "error": err.Error()})
		}
		_, err := os.Lstat(candidate)
		if err == nil {
			if err := os.Rename(candidate, stale); err != nil {
				return RemoveResult{}, err
			}
			removing = stale
		} else if !errors.Is(err, os.ErrNotExist) {
			return RemoveResult{}, err
		}
	}
	change, err := Write(home, current, true, next, expected)
	if err != nil {
		if removing != "" {
			if restore := os.Rename(removing, candidate); restore != nil {
				return RemoveResult{}, errors.Join(err, restore)
			}
		}
		return RemoveResult{}, err
	}
	result := RemoveResult{Change: change}
	if removing != "" {
		if err := os.RemoveAll(removing); err != nil {
			result.ArtifactDeleteFailed = &ArtifactDeleteFailure{Path: removing, Error: err.Error()}
		}
	}
	return result, nil
}

// artifactCandidate returns the path whose rename and deletion remove record
// path under <home>/components: the parent directory resolved through
// symlinks, joined with the leaf name. The leaf need not exist. It refuses a
// path that is not a strict descendant of the components root, a symlink in
// any path component below the root (the leaf included), and a resolved parent
// that puts the candidate outside the resolved root. When the parent chain
// does not exist the path is returned as it is: nothing at it or beside it
// exists.
func artifactCandidate(home, path string) (string, error) {
	root := filepath.Join(home, "components")
	relative, err := filepath.Rel(root, path)
	if err != nil || !descends(relative) {
		return "", i18n.Errorf("environment.remove.pathOutsideHome", map[string]string{"path": path, "home": home})
	}
	// A symlink below the root resolves to another directory: outside home, or
	// another component's directory inside it. Both are refused. An absent
	// component ends the walk: nothing below it exists.
	current := root
	for _, component := range strings.Split(relative, string(filepath.Separator)) {
		current = filepath.Join(current, component)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			break
		}
		if err != nil {
			return "", err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", i18n.Errorf("environment.remove.pathSymlink", map[string]string{"path": path, "link": current})
		}
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(path))
	if errors.Is(err, os.ErrNotExist) {
		return path, nil
	}
	if err != nil {
		return "", err
	}
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	candidate := filepath.Join(parent, filepath.Base(path))
	if relative, err := filepath.Rel(realRoot, candidate); err != nil || !descends(relative) {
		return "", i18n.Errorf("environment.remove.pathOutsideHome", map[string]string{"path": candidate, "home": home})
	}
	return candidate, nil
}

// descends reports whether a relative path names a strict descendant.
func descends(relative string) bool {
	return relative != "." && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
