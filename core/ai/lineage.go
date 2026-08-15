package ai

import (
	"encoding/json"

	"github.com/soksak/soksak-core/core/store"
)

// LineageStore reads the recorded transitions.
//
// An interface rather than the store itself, so what this group answers can be
// exercised without a database — and so a process that holds no store refuses
// by name instead of being handed a nil one.
type LineageStore interface {
	Query(request store.QueryRequest) ([]json.RawMessage, error)
}

const (
	lineageNamespace  = "core"
	lineageCollection = "ai_session_lineage"
	// Ordered by when the record was written. The chain from→to in time order
	// is the flow; read in any other order it is a different story about what
	// happened.
	lineageOrder = "created"
	// A ceiling rather than a page. Lineage is read to reconstruct one working
	// directory's history, and a directory with more transitions than this has
	// a retention problem rather than a paging one.
	lineageLimit = int64(1000)
)

// Lineage answers the session transitions recorded for one working directory,
// oldest first.
//
// Each record is {viewId, fromSession, toSession, kind, time}. The time-ordered
// from→to chain is the flow, and one fromSession leading to several toSession
// is a fork. The records are written by the watcher that observes the session
// directory; this is the only path that reads them, because two readers of one
// history answer with two shapes and that difference reads as a different flow
// rather than as a defect.
func Lineage(records LineageStore, cwd, viewID string) ([]json.RawMessage, error) {
	// The scope is the same working directory the tracker was armed with, and
	// that one is refused here before any agent tree is touched — so a working
	// directory this group would not watch cannot have a history either.
	// Answering an empty list would say the agent left no forks behind.
	if err := requireAbsolute("the working directory", cwd); err != nil {
		return nil, err
	}

	limit := lineageLimit
	request := store.QueryRequest{
		Ns:    lineageNamespace,
		Coll:  lineageCollection,
		Scope: &cwd,
		Order: lineageOrder,
		Limit: &limit,
	}
	if viewID != "" {
		// An absent tab is every tab in this working directory, which is what
		// the frontend asks for when it renders the whole flow.
		encoded, err := json.Marshal(viewID)
		if err != nil {
			return nil, err
		}
		request.Filter = map[string]json.RawMessage{"viewId": encoded}
	}

	rows, err := records.Query(request)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		// A list, never null: "nothing was recorded" and "this build cannot
		// tell you" must not arrive as the same answer, and a caller reading
		// .length off a null takes the page down with it.
		return []json.RawMessage{}, nil
	}
	return rows, nil
}
