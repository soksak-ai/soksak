package files

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Child is one direct entry of a listed directory.
type Child struct {
	Name string `json:"name"`
	Dir  bool   `json:"dir"`
	// Modified is unix seconds, and only present when the caller asked for
	// meta. It is a pointer so an unasked field is absent rather than zero — a
	// renderer reads `"modified":0` as 1970.
	Modified *int64 `json:"modified,omitempty"`
}

// ChildListing is one directory, as the tree receives it.
type ChildListing struct {
	// Root is the resolved path. The tree feeds it back into watch_dir, so both
	// commands must resolve a path the same way or the consumer's
	// `changed === dir` never matches.
	Root     string  `json:"root"`
	Children []Child `json:"children"`
}

// listChildren lists one directory's direct entries, never recursing. It is the
// unit of a lazy tree: a huge directory costs one read until it is opened.
func listChildren(path string, meta bool, home string) (ChildListing, error) {
	root, err := resolveDir(path, home)
	if err != nil {
		return ChildListing{}, err
	}

	info, err := os.Stat(root)
	if err != nil {
		// Absence is a failure here, not an empty list: an empty listing
		// renders a deleted folder as an existing empty one and the tree keeps
		// the row.
		return ChildListing{}, fmt.Errorf("list_children: %w", err)
	}
	if !info.IsDir() {
		return ChildListing{}, fmt.Errorf("not a directory: %s", root)
	}

	entries, err := os.ReadDir(root)
	if err != nil {
		// A third answer. Collapsing it into absence makes a permissions
		// problem look like an empty folder.
		return ChildListing{}, fmt.Errorf("list_children could not read %s: %w", root, err)
	}

	children := make([]Child, 0, len(entries))
	for _, entry := range entries {
		children = append(children, describe(root, entry, meta))
	}
	sortChildren(children)

	return ChildListing{Root: root, Children: children}, nil
}

// resolveDir turns the caller's argument into the directory to list.
//
// An absent or empty path is the user's home. That home is the OS user's, never
// the identity home, or the tree starts inside the app's own folder.
func resolveDir(path string, home string) (string, error) {
	if path == "" {
		resolved, err := requireHome(home)
		if err != nil {
			return "", err
		}
		path = resolved
	}
	expanded, err := expand(path, home)
	if err != nil {
		return "", err
	}
	return resolvePath(expanded), nil
}

// resolvePath answers the symlink-resolved spelling, falling back to the given
// one. A path that does not exist cannot be resolved, and that failure is
// to the caller's stat rather than here.
func resolvePath(path string) string {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return resolved
	}
	return filepath.Clean(path)
}

// describe reads one entry without stat'ing it.
//
// macOS TCC: a stat inside Desktop, Documents, or Downloads raises a permission
// prompt, and a plain listing must never raise one. DirEntry.Type() comes from
// the dirent; Info() is the stat. Only a symlink is stat'd, because the dirent
// reports "symlink" and the tree still needs whether it opens.
func describe(root string, entry fs.DirEntry, meta bool) Child {
	child := Child{Name: entry.Name()}
	if entry.Type()&fs.ModeSymlink != 0 {
		if target, err := os.Stat(filepath.Join(root, entry.Name())); err == nil {
			child.Dir = target.IsDir()
		}
	} else {
		child.Dir = entry.IsDir()
	}
	if meta {
		if info, err := entry.Info(); err == nil {
			seconds := info.ModTime().Unix()
			child.Modified = &seconds
		}
	}
	return child
}

// sortChildren orders folders first, then by name ignoring case, then by the
// raw name.
//
// That last step is the Go-specific part. A stable sort would give a two-key
// comparison a settled tie order for free;
// sort.Slice is not stable, and measured here, ten pairs of names differing
// only in case came back with one pair swapped and nine kept — so two readings
// of an unchanged directory hand the tree different orders, which redraws as
// rows jumping with nothing changed.
func sortChildren(children []Child) {
	sort.Slice(children, func(i, j int) bool {
		left, right := children[i], children[j]
		if left.Dir != right.Dir {
			return left.Dir
		}
		lowerLeft, lowerRight := strings.ToLower(left.Name), strings.ToLower(right.Name)
		if lowerLeft != lowerRight {
			return lowerLeft < lowerRight
		}
		return left.Name < right.Name
	})
}
