package session

import (
	"encoding/json"
	"sort"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

// attachmentPrefix is where the core keeps its index, one key per session.
//
// Beside the window ledger rather than inside a window's snapshot: a view goes away with the window
// that held it, and a session outlives both, so an attachment stored on the view would take the
// session out of the index with the window.
//
// One key per session rather than one document holding them all. A byte that went wrong in a single
// document took every session out of every listing at once — the all-or-nothing S4-4 refuses for an
// owner's store, and the core's own index is no different.
const attachmentPrefix = "sessions/"

// Writer is the slice of the key-value store the index needs to be written through.
type Writer interface {
	Reader
	Set(ns, key, value string) error
	// Delete removes a key. An attachment written empty is a key that still answers, and a reader
	// walking the roll would find one it cannot place instead of nothing.
	Delete(ns, key string) error
}

// Attachment is one session and where it was last shown.
//
// The coordinate answers "is there a session here" and the id answers "which session". Keeping both
// is what makes a session whose coordinate changed still addressable: a lookup by coordinate that
// finds nothing falls to the id.
type Attachment struct {
	Session     string `json:"session"`
	Owner       string `json:"owner"`
	ViewID      string `json:"viewId"`
	WindowLabel string `json:"windowLabel"`
}

// Attach records one session's attachment, replacing any the session already had.
//
// One attachment per session. A session shown in two places at once is one the index cannot answer
// "where" for, and every consumer of that answer would then have to pick.
func Attach(store Writer, attachment Attachment) error {
	if attachment.Session == "" {
		return i18n.Errorf("session.attach.noSession", nil)
	}
	body, err := json.Marshal(attachment)
	if err != nil {
		return err
	}
	if err := store.Set(ledgerNamespace, attachmentPrefix+attachment.Session, string(body)); err != nil {
		return err
	}
	return rememberSession(store, attachment.Session)
}

// Detach removes one session's attachment and ends nothing.
func Detach(store Writer, session string) error {
	if err := store.Delete(ledgerNamespace, attachmentPrefix+session); err != nil {
		return err
	}
	return forgetSession(store, session)
}

// The roll names which sessions the index holds. The store answers one key at a time, so without it
// a reader has nowhere to start; it is a list of names and nothing else, so a byte that went wrong
// in it costs the names and never an attachment's contents.
const rollKey = "session-roll"

func readRoll(store Reader) []string {
	raw, found, err := store.Get(ledgerNamespace, rollKey)
	if err != nil || !found || raw == "" {
		return nil
	}
	var names []string
	if err := json.Unmarshal([]byte(raw), &names); err != nil {
		return nil
	}
	return names
}

func writeRoll(store Writer, names []string) error {
	sort.Strings(names)
	body, err := json.Marshal(names)
	if err != nil {
		return err
	}
	return store.Set(ledgerNamespace, rollKey, string(body))
}

func rememberSession(store Writer, session string) error {
	names := readRoll(store)
	for _, held := range names {
		if held == session {
			return nil
		}
	}
	return writeRoll(store, append(names, session))
}

func forgetSession(store Writer, session string) error {
	names := readRoll(store)
	kept := make([]string, 0, len(names))
	for _, held := range names {
		if held != session {
			kept = append(kept, held)
		}
	}
	if len(kept) == len(names) {
		return nil
	}
	return writeRoll(store, kept)
}

// readAttachment answers one session's attachment, and whether it could be read.
//
// A record whose stated session does not match the key it was found under is refused rather than
// repaired: one of the two is wrong and neither states which.
func readAttachment(store Reader, session string) (Attachment, bool) {
	raw, found, err := store.Get(ledgerNamespace, attachmentPrefix+session)
	if err != nil || !found || raw == "" {
		return Attachment{}, false
	}
	var attachment Attachment
	if err := json.Unmarshal([]byte(raw), &attachment); err != nil {
		return Attachment{}, false
	}
	if attachment.Session != session {
		return Attachment{}, false
	}
	return attachment, true
}

// shownViews answers which views are the ones their pane shows. A view behind another tab holds its
// session all the same; nothing is showing it.
func shownViews(reader Reader) map[string]bool {
	shown := map[string]bool{}
	labels, err := windowLabels(reader)
	if err != nil {
		return shown
	}
	for _, label := range labels {
		raw, found, err := reader.Get(ledgerNamespace, snapshotPrefix+label)
		if err != nil || !found {
			continue
		}
		var snapshot windowSnapshot
		if err := json.Unmarshal([]byte(raw), &snapshot); err != nil {
			continue
		}
		for _, workspace := range snapshot.Workspaces {
			for _, content := range workspace.Contents {
				var root layoutNode
				if err := json.Unmarshal(content.Layout, &root); err != nil {
					continue
				}
				markShown(root, shown)
			}
		}
	}
	return shown
}

func markShown(node layoutNode, shown map[string]bool) {
	if node.Value != nil && node.Value.ActiveViewID != "" {
		shown[node.Value.ActiveViewID] = true
	}
	for _, child := range node.Children {
		markShown(child, shown)
	}
}

// sortIndex puts the index in one order. A listing that changed order between calls is one a caller
// cannot compare against the last.
func sortIndex(index []Entry) {
	sort.Slice(index, func(left, right int) bool {
		return index[left].Session < index[right].Session
	})
}
