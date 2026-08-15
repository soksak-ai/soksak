package terminal

import (
	"fmt"
	"strings"
	"sync"
)

// Session identity: what a caller holds, what the owner holds, and how the two
// are matched.
//
// The caller holds a uint32 id minted here from 1. The owner holds a Handle,
// which is a key plus the generation the owner stamped on it. Nothing about a
// PTY lives in this file — the kernel object, the read loop, and the reaping
// belong to whoever holds the file descriptor.

// separator joins the two halves of a reattach key.
const separator = "/"

// Handle is the owner's name for a live session, and the coordinate the output
// event carries back. A caller matches bytes to a pane by it.
//
// Generation is what makes a stale handle fail instead of landing in the
// replacement: the owner mints a new one on every open, so a handle held across
// a respawn no longer matches the session sitting under its key.
type Handle struct {
	ID         string `json:"id"`
	Generation uint64 `json:"generation"`
}

// paneKey derives the reattach key for a pane.
//
// The window label namespaces the pane id because pane ids are only unique
// inside their window — the frontend mints per-window sequential view ids, so
// two windows both hold a "v2". An earlier build's daemon keyed reattachment on
// the same pair for the same measured reason.
//
// An absent window label arrives as "" and derives the same key an explicit ""
// would. The frontend collapses the two before they leave it
// (`currentWindowLabel() || null`), so telling them apart here would invent a
// second key for one window rather than describe a difference that exists.
func paneKey(command, windowLabel, paneID string) (string, error) {
	if paneID == "" {
		return "", fmt.Errorf("%s: argument %q is empty — a pane id that names nothing cannot key a session (send no paneId at all for a session with no reattach key)", command, "paneId")
	}
	// Two halves that may each carry the separator do not derive one key:
	// ("w-1/a", "b") and ("w-1", "a/b") would both produce "w-1/a/b", and then
	// one pane's keystrokes reach the other pane's shell.
	if err := windowHalf(command, windowLabel); err != nil {
		return "", err
	}
	if strings.Contains(paneID, separator) {
		return "", fmt.Errorf("%s: argument %q contains %q, which would let two panes derive one session key", command, "paneId", separator)
	}
	return windowLabel + separator + paneID, nil
}

// windowHalf refuses a window label that cannot be the left field of a key.
//
// Both key shapes put the window first and are read back by splitting, so a
// label carrying the separator makes the split lie about where the window ends.
// It is checked on the pane path and on the anonymous one, or the same label is
// legal in one spawn and refused in the next.
func windowHalf(command, windowLabel string) error {
	if strings.Contains(windowLabel, separator) {
		return fmt.Errorf("%s: argument %q contains %q, which would let two panes derive one session key", command, "windowLabel", separator)
	}
	return nil
}

// entry is one live session as this package knows it.
type entry struct {
	key string
	// pane is empty exactly when the caller named no pane. Such a session has
	// no reattach key, so nothing may find it by pane and nothing may replace
	// it — which is why an empty pane is also what keeps it out of byKey.
	pane   string
	handle Handle
}

// table is the id ↔ session map. It is the only mutable state in this package.
type table struct {
	mu       sync.Mutex
	nextID   uint32
	nextAnon uint64
	byID     map[uint32]entry
	byKey    map[string]uint32
}

func newTable() *table {
	return &table{byID: map[uint32]entry{}, byKey: map[string]uint32{}}
}

// anonymous mints a key for a session the caller gave no pane id.
//
// The owner still needs a name for it, and that name must not be one a real
// pane could derive. Neither half of a derived key may contain the separator,
// so every derived key holds exactly one; a minted key holds two, which puts it
// outside the derivable space by construction rather than by convention.
//
// The window half is kept because such a session is still in a window, and the
// owner has no other way to learn which — an earlier build injected the label
// into the shell of a pane-less session too, and a tool inside that shell
// addresses its window by it.
func (t *table) anonymous(windowLabel string) string {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.nextAnon++
	return fmt.Sprintf("%s%s%sanon%d", windowLabel, separator, separator, t.nextAnon)
}

// install records a live session and answers with the id the caller holds.
//
// A session installed over a key that already had one drops the previous id in
// the same step. The owner has already closed the shell that id named, and a
// row left pointing at it would turn a write into what reads as a hang.
func (t *table) install(key, pane string, handle Handle) uint32 {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.nextID++
	id := t.nextID
	if pane != "" {
		if previous, exists := t.byKey[key]; exists {
			delete(t.byID, previous)
		}
		t.byKey[key] = id
	}
	t.byID[id] = entry{key: key, pane: pane, handle: handle}
	return id
}

func (t *table) lookup(id uint32) (entry, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	found, exists := t.byID[id]
	return found, exists
}

// remove discards a session. Absence is reported rather than treated as a
// failure: close is idempotent, and the caller's intent is "not running".
func (t *table) remove(id uint32) (entry, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	found, exists := t.byID[id]
	if !exists {
		return entry{}, false
	}
	delete(t.byID, id)
	// Only the current occupant of a key releases it. A respawn already moved
	// the key to the replacement, so a late close of the id it replaced must
	// not evict the session now living there.
	if found.pane != "" && t.byKey[found.key] == id {
		delete(t.byKey, found.key)
	}
	return found, true
}

// pane finds a live session by pane id alone.
//
// The lookup is a scan rather than a second index: the number of live sessions
// is the number of open panes, and an index that can disagree with byID is a
// worse trade than a walk over a handful of entries. An earlier build scanned
// for the same reason.
//
// It answers across windows, because the two commands that ask — pty_pane_alive
// and pty_pane_pid — receive only a pane id. With more than one window open
// that is exactly the collision the key namespacing prevents elsewhere, and the
// one answered is whichever the walk reaches first: map order, so not the same
// one twice. Closing it needs the frontend to send the window label on both
// calls.
func (t *table) pane(paneID string) (Handle, bool) {
	if paneID == "" {
		return Handle{}, false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, found := range t.byID {
		if found.pane == paneID {
			return found.handle, true
		}
	}
	return Handle{}, false
}

func (t *table) size() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.byID)
}
