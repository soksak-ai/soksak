// Package atomicfile publishes a file's whole contents in one step.
//
// A write into the file a reader reads is not one step: the open truncates, and a reader arriving
// between the truncate and the last byte sees a file that is neither the old contents nor the new
// ones. A write that dies part-way leaves that on disk permanently. Measured rather than argued —
// a reader in core/store's gate read 0 bytes of a 1 MiB value on its first round.
//
// Rename within one directory is one step, so the contents are written to a neighbour and renamed
// over the target. A reader sees all of the old contents or all of the new ones, and a write that
// dies leaves the old contents intact.
//
// This does not order two writers. Which of two concurrent writes lands last is the caller's to
// settle; what this removes is the third outcome, where neither is what is on disk.
package atomicfile

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// Publish writes body to path, in one step.
//
// The parent directory must exist: creating it is the caller's decision, because a caller writing
// into a directory it did not expect to be missing wants to hear about it.
func Publish(path string, body []byte, mode fs.FileMode) error {
	// A path that is a link is published onto what it points at, and the link is left alone. Rename
	// replaces what it lands on, so renaming onto the link would turn it into a regular file — and a
	// person who symlinked a file into place saved it expecting the link to survive.
	//
	// Resolved before the neighbour is chosen, because the neighbour has to share a directory with
	// what the rename lands on.
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	directory := filepath.Dir(path)
	// Named after the target, so a neighbour left by a killed process names the file it was for,
	// and unique per write so two writes of one path do not stage over each other — a shared name
	// publishes half of each, which is the same splice one step later.
	staged, err := os.CreateTemp(directory, filepath.Base(path)+".*.next")
	if err != nil {
		return fmt.Errorf("atomicfile: staging %s: %w", path, err)
	}
	name := staged.Name()
	if _, err := staged.Write(body); err != nil {
		staged.Close()
		os.Remove(name)
		return fmt.Errorf("atomicfile: writing %s: %w", path, err)
	}
	if err := staged.Close(); err != nil {
		os.Remove(name)
		return fmt.Errorf("atomicfile: writing %s: %w", path, err)
	}
	// CreateTemp makes the file 0600. The mode the caller asked for is applied before the rename,
	// so the published file never exists with the wrong one.
	if err := os.Chmod(name, mode); err != nil {
		os.Remove(name)
		return fmt.Errorf("atomicfile: setting the mode of %s: %w", path, err)
	}
	if err := os.Rename(name, path); err != nil {
		os.Remove(name)
		return fmt.Errorf("atomicfile: publishing %s: %w", path, err)
	}
	return nil
}
