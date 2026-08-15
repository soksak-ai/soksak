package activity

import "sync"

// DefaultTailSize is how many recent entries an operator can still see.
//
// Bounded because the loudest thing a build does is fail repeatedly: a renderer
// in a crash loop publishes as fast as it can render, and an unbounded record
// of that ends the process that was supposed to report it.
const DefaultTailSize = 512

// Tail is what a live operator can still see.
//
// It is not retention. Retention belongs to whoever owns storage, and the two
// answer different questions: retention is "what happened", this is "what is
// happening", and the second must keep working in a process with no storage at
// all — which is exactly the process that most needs to be asked.
//
// This exists because renderer errors were admitted and dropped. The error
// reached the backend, the backend stamped it, and nothing could be asked what
// it said — so the only way to read a renderer exception was to have a person
// look at the window.
type Tail struct {
	mu      sync.Mutex
	entries []Entry
	size    int
}

// NewTail holds up to size entries. A size of zero or less takes the default,
// so a caller that forgot to choose keeps a record rather than none.
func NewTail(size int) *Tail {
	if size <= 0 {
		size = DefaultTailSize
	}
	return &Tail{size: size, entries: make([]Entry, 0, size)}
}

// Keep records an admitted entry, dropping the oldest when full.
//
// The oldest goes rather than the newest: a caller asking what is happening
// wants the most recent, and a full buffer that refuses new entries reports the
// beginning of an incident forever while the current state is invisible.
func (tail *Tail) Keep(entry Entry) {
	tail.mu.Lock()
	defer tail.mu.Unlock()
	if len(tail.entries) == tail.size {
		copy(tail.entries, tail.entries[1:])
		tail.entries = tail.entries[:tail.size-1]
	}
	tail.entries = append(tail.entries, entry)
}

// Recent answers the newest entries first, optionally of certain kinds.
//
// Newest first because the reason anyone asks is that something just went
// wrong. An empty kinds list means every kind: a caller that filters to nothing
// wants everything, not silence.
func (tail *Tail) Recent(kinds []string, limit int) []Entry {
	wanted := map[string]bool{}
	for _, kind := range kinds {
		wanted[kind] = true
	}

	tail.mu.Lock()
	defer tail.mu.Unlock()

	// Answering into a fresh slice rather than a view of the buffer: the
	// buffer keeps moving, and a caller reading a view would see entries
	// change under it.
	out := make([]Entry, 0, len(tail.entries))
	for index := len(tail.entries) - 1; index >= 0; index-- {
		entry := tail.entries[index]
		if len(wanted) > 0 && !wanted[entry.Kind] {
			continue
		}
		out = append(out, entry)
		if limit > 0 && len(out) == limit {
			break
		}
	}
	return out
}

// Len is how many entries are held right now.
func (tail *Tail) Len() int {
	tail.mu.Lock()
	defer tail.mu.Unlock()
	return len(tail.entries)
}
