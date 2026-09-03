package session

import (
	"fmt"

	controlwire "github.com/soksak-ai/soksak-contract-control"
)

// Order puts the close to one owner. The core orders and the owner performs: closing removes the
// owner's record, and the core does not write an owner's store.
type Order func(owner string, request controlwire.SessionCloseRequest) (controlwire.SessionCloseResult, error)

// Close ends one session in the index.
//
// The session names its owner. A session the index does not hold names no owner, and picking one
// for it would send the close to whichever component happened to be first.
func Close(index []Entry, session string, order Order) (controlwire.SessionCloseResult, error) {
	owner := ""
	for _, entry := range index {
		if entry.Session == session {
			owner = entry.Owner
			break
		}
	}
	if owner == "" {
		return controlwire.SessionCloseResult{}, fmt.Errorf(
			"no session %s in this index, so nothing names the component that would end it", session)
	}

	result, err := order(owner, controlwire.SessionCloseRequest{Session: session})
	if err != nil {
		// The owner is where the record is. A close it never received changed nothing, and reporting
		// the session ended would stop a caller showing something that is still running.
		return controlwire.SessionCloseResult{}, fmt.Errorf(
			"the component %s that owns session %s is not running, so the close was not performed: %w",
			owner, session, err)
	}
	if !result.Closed {
		return controlwire.SessionCloseResult{}, fmt.Errorf(
			"the component %s did not end session %s", owner, session)
	}
	return result, nil
}

// OrderThrough builds the close order from a send that takes one unit a request.
func OrderThrough(send Send) Order {
	return func(owner string, request controlwire.SessionCloseRequest) (controlwire.SessionCloseResult, error) {
		var result controlwire.SessionCloseResult
		err := callOwner(send, owner, controlwire.SessionCloseCommand, request, &result)
		return result, err
	}
}
