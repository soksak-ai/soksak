package session

import (
	controlwire "github.com/soksak-ai/soksak-contract-control"
	"github.com/soksak-ai/soksak-core/core/i18n"
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
		return controlwire.SessionCloseResult{}, i18n.Errorf("session.close.notInIndex",
			map[string]string{"session": session})
	}

	result, err := order(owner, controlwire.SessionCloseRequest{Session: session})
	if err != nil {
		// The owner is where the record is. A close it never received changed nothing, and reporting
		// the session ended would stop a caller showing something that is still running.
		return controlwire.SessionCloseResult{}, i18n.Errorf("session.close.ownerDown",
			map[string]string{"owner": owner, "session": session})
	}
	if !result.Closed {
		return controlwire.SessionCloseResult{}, i18n.Errorf("session.close.refused",
			map[string]string{"owner": owner, "session": session})
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

// Closed is what a close leaves behind.
type Closed struct {
	controlwire.SessionCloseResult
	// Indexed states that the attachment went with the session. False when the index refused: the
	// session is ended all the same, and the entry left behind is what a later listing reports.
	Indexed bool `json:"indexed"`
}

// CloseAndForget ends one session and takes its attachment.
//
// The owner performs the close and the index follows it, in that order and not the other way: the
// index is the core's note of what exists, and removing the note first would leave a running
// session nothing addresses if the owner then refused.
//
// A close the owner performed is done, whatever becomes of the index afterwards. The record is gone
// and the session with it, so reporting failure would tell a caller the session is still running —
// and the next listing would count something nothing can reach as lost, which is the measured value
// a gate asserts is zero.
func CloseAndForget(store Writer, index []Entry, session string, order Order) (Closed, error) {
	result, err := Close(index, session, order)
	if err != nil {
		// The owner never ended it, so the attachment stays: taking it out would remove a running
		// session from every listing.
		return Closed{}, err
	}
	if err := Detach(store, session); err != nil {
		return Closed{SessionCloseResult: result, Indexed: false}, nil
	}
	return Closed{SessionCloseResult: result, Indexed: true}, nil
}
