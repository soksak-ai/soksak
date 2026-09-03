// Package session reads the core's session index and the states that follow from it.
//
// The core owns the index: which sessions exist, which component owns each, and where each was
// last shown. It does not own the state a session holds — that is the owner's, and the core reads
// it through the one command every owner answers.
package session

import (
	"encoding/json"

	controlwire "github.com/soksak-ai/soksak-contract-control"
)

// The states a session is in. Exactly one of them at a time.
const (
	// StateLive is a session an owner holds with a view showing it.
	StateLive = "live"
	// StateDetached is a session an owner holds with no view showing it. It is doing its work.
	StateDetached = "detached"
	// StateOrphaned is a session no owner holds and no owner has reported unrecoverable. It covers
	// the whole time an owner's process is not running: the core does not read an owner's store, so
	// it cannot tell a recoverable session from an unrecoverable one on its own.
	StateOrphaned = "orphaned"
	// StateLost is a session an owner read its store for and found no record of. It is a defect,
	// and the count of them is a measured value rather than an accepted outcome.
	StateLost = "lost"
)

// where the window ledger and each window's snapshot are stored. They are the pair the application
// writes; a second pair here would read a key nobody wrote and report an empty index with no error.
const (
	ledgerNamespace = "core"
	ledgerKey       = "windows"
	snapshotPrefix  = "window/"
)

// Reader is the slice of the key-value store this package needs.
type Reader interface {
	Get(ns, key string) (string, bool, error)
}

// Entry is one session the index holds.
type Entry struct {
	// Session and Owner are the binding. The id is the owner's, in the form the owner issued, and
	// this package reads nothing out of it.
	Session string `json:"session"`
	Owner   string `json:"owner"`
	// WindowLabel and ViewID are where the session was last shown. They answer "is there a session
	// here"; the id answers "which session", and a lookup by coordinate that finds nothing falls to
	// the id.
	WindowLabel string `json:"windowLabel"`
	ViewID      string `json:"viewId"`
	// Shown states that the view holding this session is its pane's active one. A view behind
	// another tab holds its session all the same; nothing is showing it.
	Shown bool `json:"shown"`
}

// StateOf is the state a session is in, from what its owner reported and whether a view shows it.
//
// known is whether the owner answered at all. An owner that is not running answers nothing, and
// every session it holds is orphaned until it does.
func StateOf(outcome string, known bool, shown bool) string {
	if !known {
		return StateOrphaned
	}
	switch outcome {
	case controlwire.SessionFull, controlwire.SessionDegraded:
		if shown {
			return StateLive
		}
		return StateDetached
	case controlwire.SessionLost:
		return StateLost
	default:
		// A record the owner could not use is kept and a later start may stand it up, so the
		// session waits for its owner rather than being counted as gone.
		return StateOrphaned
	}
}

// ReadIndex answers every session the core holds an attachment for.
//
// The attachments are the index and the window snapshots are not: a session outlives the view that
// showed it, and reading the index out of the snapshots would drop a session the moment its window
// closed. The snapshots answer one thing here — whether a view is the one its pane shows.
func ReadIndex(reader Reader) ([]Entry, error) {
	held, err := readAttachments(reader)
	if err != nil {
		return nil, err
	}
	shown := shownViews(reader)
	index := make([]Entry, 0, len(held))
	for _, attachment := range held {
		index = append(index, Entry{
			Session:     attachment.Session,
			Owner:       attachment.Owner,
			WindowLabel: attachment.WindowLabel,
			ViewID:      attachment.ViewID,
			Shown:       shown[attachment.ViewID],
		})
	}
	sortIndex(index)
	return index, nil
}

func windowLabels(reader Reader) ([]string, error) {
	raw, found, err := reader.Get(ledgerNamespace, ledgerKey)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, nil
	}
	var ledger struct {
		Slots []struct {
			Label string `json:"label"`
		} `json:"slots"`
	}
	if err := json.Unmarshal([]byte(raw), &ledger); err != nil {
		return nil, err
	}
	labels := make([]string, 0, len(ledger.Slots))
	for _, slot := range ledger.Slots {
		if slot.Label != "" {
			labels = append(labels, slot.Label)
		}
	}
	return labels, nil
}

// The shape read out of a window snapshot. Only the fields a binding needs: a full model of the
// layout here would be a second copy of one the application already keeps, and the two would
// disagree the first time either changed.
type windowSnapshot struct {
	Workspaces []struct {
		Contents []struct {
			Layout json.RawMessage `json:"layout"`
		} `json:"contents"`
	} `json:"workspaces"`
}

type layoutNode struct {
	Type     string       `json:"t"`
	Children []layoutNode `json:"children"`
	Value    *struct {
		ActiveViewID string `json:"activeViewId"`
		Views        []struct {
			ID      string `json:"id"`
			Session *struct {
				Owner string `json:"owner"`
				ID    string `json:"id"`
			} `json:"session"`
		} `json:"views"`
	} `json:"v"`
}
