package session

import (
	"encoding/json"
	"sort"
)

// attachmentKey is where the core keeps its index. It is beside the window ledger rather than
// inside a window's snapshot: a view goes away with the window that held it, and a session outlives
// both. An attachment stored on the view would take the session out of the index with the window.
const attachmentKey = "sessions"

// Writer is the slice of the key-value store the index needs to be written through.
type Writer interface {
	Reader
	Set(ns, key, value string) error
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
	held, err := readAttachments(store)
	if err != nil {
		return err
	}
	held[attachment.Session] = attachment
	return writeAttachments(store, held)
}

// Detach removes one session's attachment and ends nothing.
func Detach(store Writer, session string) error {
	held, err := readAttachments(store)
	if err != nil {
		return err
	}
	if _, present := held[session]; !present {
		return nil
	}
	delete(held, session)
	return writeAttachments(store, held)
}

func readAttachments(store Reader) (map[string]Attachment, error) {
	raw, found, err := store.Get(ledgerNamespace, attachmentKey)
	if err != nil {
		return nil, err
	}
	held := map[string]Attachment{}
	if !found {
		return held, nil
	}
	if err := json.Unmarshal([]byte(raw), &held); err != nil {
		// A record that does not parse is refused rather than repaired: one of it and the shape this
		// build writes is wrong, and neither states which.
		return nil, err
	}
	return held, nil
}

func writeAttachments(store Writer, held map[string]Attachment) error {
	body, err := json.Marshal(held)
	if err != nil {
		return err
	}
	return store.Set(ledgerNamespace, attachmentKey, string(body))
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
