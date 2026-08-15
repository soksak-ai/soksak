package ai

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"sort"
	"sync"
)

// Tracker remembers what each session directory held the last time it was
// asked, so it can answer which transcript was written since.
//
// The rule is "changed since the last look", never "the newest file". claude
// does not record its own /clear and /resume branches — measured: 49 sessions,
// zero branch links between them — so a transition is only visible from
// outside, as a transcript appearing or growing. Answering the newest file
// instead would report a transition every time the current transcript was
// deleted, naming a session nobody opened, and the frontend stores what it is
// told as lineage.
//
// One process holds this ledger. Two would each keep their own idea of "the
// last look" and answer the same question differently.
//
// Nothing here polls. The frontend calls in on a filesystem-change event, which
// the operating system raises only when the directory actually changed.
type Tracker struct {
	mutex sync.Mutex
	seen  map[string]map[string]int64
}

func NewTracker() *Tracker {
	return &Tracker{seen: map[string]map[string]int64{}}
}

// Active answers the transcript written since the last look at this directory,
// and records what it saw.
//
// No change is not a session: nothing was written, and saying so is the whole
// point. The caller compares against the session it already believes is current
// and stores a transition when they differ, so an invented answer here becomes
// an invented fork in the history.
func (tracker *Tracker) Active(directory string) (string, bool, error) {
	if err := requireAbsolute("the session directory", directory); err != nil {
		return "", false, err
	}
	current, err := snapshot(directory)
	if err != nil {
		return "", false, err
	}

	tracker.mutex.Lock()
	defer tracker.mutex.Unlock()
	previous := tracker.seen[directory]
	tracker.seen[directory] = current

	// Go randomises map iteration, so a tie decided by iteration order answers
	// a different session on every call — and every difference reads to the
	// caller as another transition.
	identifiers := make([]string, 0, len(current))
	for identifier := range current {
		identifiers = append(identifiers, identifier)
	}
	sort.Strings(identifiers)

	active, activeAt := "", int64(0)
	for _, identifier := range identifiers {
		writtenAt := current[identifier]
		if before, known := previous[identifier]; known && writtenAt <= before {
			continue
		}
		if active == "" || writtenAt > activeAt {
			active, activeAt = identifier, writtenAt
		}
	}
	return active, active != "", nil
}

// snapshot is the session identifiers in a directory against when each was last
// written.
//
// A directory that does not exist is empty rather than an error: arming happens
// the moment the command starts, which is before the agent has made its session
// folder. A directory that exists and cannot be read is an error — a watcher
// that silently observes nothing is indistinguishable from an agent that never
// ran.
func snapshot(directory string) (map[string]int64, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return map[string]int64{}, nil
		}
		return nil, fmt.Errorf("ai: could not read %s: %w", directory, err)
	}

	written := make(map[string]int64, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		identifier, isTranscript := sessionFileID(entry.Name())
		if !isTranscript {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			// Gone between the listing and the stat. It is not the transcript
			// being written to.
			continue
		}
		written[identifier] = info.ModTime().UnixMilli()
	}
	return written, nil
}
