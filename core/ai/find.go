package ai

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// Newest answers the claude session a working directory was most recently in.
//
// The terminal asks once, when a command ends, so that the block it just
// finished can carry the session that produced it. Asking on demand is why
// there is no periodic sweep here: the question has an occasion.
//
// codex is not answered from a working directory. Its transcripts are filed by
// date rather than by directory, so a working directory does not narrow them —
// naming one anyway would mean scanning every day the user has ever run it and
// guessing from the recorded cwd.
func Newest(home, cwd string) (*SessionInfo, error) {
	directory, err := Directory(home, cwd)
	if err != nil {
		return nil, err
	}
	name, err := newestTranscript(directory)
	if err != nil {
		return nil, err
	}
	if name == "" {
		return nil, nil
	}
	head, err := readHead(filepath.Join(directory, name))
	if err != nil {
		return nil, fmt.Errorf("ai: could not read %s: %w", filepath.Join(directory, name), err)
	}
	return ParseHeader(Claude, head), nil
}

// newestTranscript answers the most recently written transcript in a session
// directory, or the empty string when there is none.
//
// A directory that does not exist is an ordinary answer: the agent has never
// run in that project, which is true of most of them. A directory that exists
// and cannot be read is not — collapsing the two hides a broken installation
// behind a feature that quietly does nothing.
func newestTranscript(directory string) (string, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", nil
		}
		return "", fmt.Errorf("ai: could not read %s: %w", directory, err)
	}

	newest := ""
	var newestAt time.Time
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		if _, isTranscript := sessionFileID(entry.Name()); !isTranscript {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			// A transcript that disappeared between the listing and the stat
			// is not the one being written to.
			continue
		}
		if newest == "" || info.ModTime().After(newestAt) {
			newest, newestAt = entry.Name(), info.ModTime()
		}
	}
	return newest, nil
}
