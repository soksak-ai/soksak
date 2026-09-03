package session

import (
	"errors"
	"testing"

	controlwire "github.com/soksak-ai/soksak-contract-control"
)

var errRefused = errors.New("the owner refused")

func seed(t *testing.T, store Writer, attachment Attachment) {
	t.Helper()
	if err := Attach(store, attachment); err != nil {
		t.Fatalf("attaching %s: %v", attachment.Session, err)
	}
}

// Closing a view closes the sessions attached to it.
//
// A view is removed by more paths than a plugin can observe: the shortcut, the close button, a
// space closing, a project closing. Every one of them takes the view out of the layout, and the
// index is where the session it held is written down — so the close is resolved from the index
// rather than from the view, which by then may not be mounted or may already be gone.
func TestClosingAViewClosesTheSessionsOnIt(t *testing.T) {
	store := &memoryStore{}
	seed(t, store, Attachment{Session: "s-one", Owner: "an.owner", ViewID: "v1", WindowLabel: "main"})
	seed(t, store, Attachment{Session: "s-two", Owner: "an.owner", ViewID: "v1", WindowLabel: "main"})
	seed(t, store, Attachment{Session: "elsewhere", Owner: "an.owner", ViewID: "v2", WindowLabel: "main"})

	var ordered []string
	order := func(owner string, request controlwire.SessionCloseRequest) (controlwire.SessionCloseResult, error) {
		ordered = append(ordered, request.Session)
		return controlwire.SessionCloseResult{Closed: true, Held: true}, nil
	}

	index, err := ReadIndex(store)
	if err != nil {
		t.Fatalf("reading the index: %v", err)
	}
	closed, err := CloseView(store, index, "v1", func(string) Order { return order })
	if err != nil {
		t.Fatalf("closing the view: %v", err)
	}
	if len(closed) != 2 {
		t.Fatalf("closed %d sessions, want 2", len(closed))
	}
	if len(ordered) != 2 {
		t.Fatalf("ordered %v, want both sessions on the view", ordered)
	}

	left, err := ReadIndex(store)
	if err != nil {
		t.Fatalf("re-reading: %v", err)
	}
	if len(left) != 1 || left[0].Session != "elsewhere" {
		t.Fatalf("index holds %v, want only the session on the other view", left)
	}
}

// A view holding no session closes without ordering anything.
func TestClosingAViewWithNoSessionOrdersNothing(t *testing.T) {
	store := &memoryStore{}
	seed(t, store, Attachment{Session: "s-one", Owner: "an.owner", ViewID: "v1", WindowLabel: "main"})

	ordered := 0
	closed, err := CloseView(store, []Entry{{Session: "s-one", Owner: "an.owner", ViewID: "v1"}}, "v-none",
		func(string) Order {
			return func(string, controlwire.SessionCloseRequest) (controlwire.SessionCloseResult, error) {
				ordered++
				return controlwire.SessionCloseResult{Closed: true}, nil
			}
		})
	if err != nil {
		t.Fatalf("closing a view with no session is not a failure: %v", err)
	}
	if ordered != 0 || len(closed) != 0 {
		t.Fatalf("ordered %d closes on a view holding none", ordered)
	}
}

// One owner refusing does not stop the others.
//
// The view is going away whatever its owners answer. A close that stopped at the first refusal
// would leave the later sessions attached to a view that no longer exists, which is the state
// nothing addresses.
func TestOneRefusalDoesNotStopTheRest(t *testing.T) {
	store := &memoryStore{}
	seed(t, store, Attachment{Session: "s-one", Owner: "refuses", ViewID: "v1", WindowLabel: "main"})
	seed(t, store, Attachment{Session: "s-two", Owner: "agrees", ViewID: "v1", WindowLabel: "main"})

	index, err := ReadIndex(store)
	if err != nil {
		t.Fatalf("reading the index: %v", err)
	}
	closed, err := CloseView(store, index, "v1", func(string) Order {
		return func(owner string, request controlwire.SessionCloseRequest) (controlwire.SessionCloseResult, error) {
			if owner == "refuses" {
				return controlwire.SessionCloseResult{}, errRefused
			}
			return controlwire.SessionCloseResult{Closed: true, Held: true}, nil
		}
	})
	if err == nil {
		t.Fatalf("a refusal is reported")
	}
	if len(closed) != 1 {
		t.Fatalf("closed %d, want the one that agreed", len(closed))
	}

	left, err := ReadIndex(store)
	if err != nil {
		t.Fatalf("re-reading: %v", err)
	}
	if len(left) != 1 || left[0].Session != "s-one" {
		t.Fatalf("index holds %v, want the refused session kept", left)
	}
}
