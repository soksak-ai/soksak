package session

import (
	"sort"
	"strings"
	"testing"

	controlwire "github.com/soksak-ai/soksak-contract-control"
)

// Closing is the owner's act and the core orders it: the core does not write an owner's store. So a
// close aimed at a session whose owner is not running is refused, and the refusal states that.
func TestACloseWhoseOwnerIsNotRunningIsRefused(t *testing.T) {
	_, err := Close([]Entry{{Session: "7", Owner: "pty"}}, "7",
		func(string, controlwire.SessionCloseRequest) (controlwire.SessionCloseResult, error) {
			return controlwire.SessionCloseResult{}, errDown{}
		})
	if err == nil {
		t.Fatal("a close reached a component that is not running")
	}
	if !containsAll(err.Error(), "pty", "running") {
		t.Fatalf("the refusal does not state that the owner is not running: %v", err)
	}
}

// A close names a session the index holds. One it does not hold names no owner, and picking one
// for it would send the close to whichever component happened to be first.
func TestASessionTheIndexDoesNotHoldIsRefused(t *testing.T) {
	_, err := Close([]Entry{{Session: "7", Owner: "pty"}}, "404",
		func(string, controlwire.SessionCloseRequest) (controlwire.SessionCloseResult, error) {
			t.Fatal("a close was sent for a session the index does not hold")
			return controlwire.SessionCloseResult{}, nil
		})
	if err == nil {
		t.Fatal("a close for an unknown session was accepted")
	}
}

// The close goes to the one owner the index names for that session, and to no other.
func TestTheCloseGoesToTheOwnerTheIndexNames(t *testing.T) {
	var reached string
	result, err := Close([]Entry{
		{Session: "7", Owner: "pty"}, {Session: "9", Owner: "browser"},
	}, "9", func(owner string, request controlwire.SessionCloseRequest) (controlwire.SessionCloseResult, error) {
		reached = owner
		return controlwire.SessionCloseResult{Session: request.Session, Closed: true, Held: true}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if reached != "browser" {
		t.Fatalf("the close reached %q", reached)
	}
	if !result.Closed || !result.Held {
		t.Fatalf("the close answered %+v", result)
	}
}

// An owner that answered and did not close is not a success. A caller told the session ended would
// stop showing something that is still running.
func TestAnOwnerThatDidNotCloseIsRefused(t *testing.T) {
	_, err := Close([]Entry{{Session: "7", Owner: "pty"}}, "7",
		func(string, controlwire.SessionCloseRequest) (controlwire.SessionCloseResult, error) {
			return controlwire.SessionCloseResult{Session: "7", Closed: false, Held: true}, nil
		})
	if err == nil {
		t.Fatal("a close the owner did not perform was reported as done")
	}
}

type errDown struct{}

func (errDown) Error() string { return "this unit is not open" }

func containsAll(text string, parts ...string) bool {
	for _, part := range parts {
		found := false
		for i := 0; i+len(part) <= len(text); i++ {
			if text[i:i+len(part)] == part {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// A close the owner performed is done, whatever becomes of the index afterwards.
//
// The owner's record is gone and the session with it. A failure reported because the index could
// not be updated leaves a caller believing the session is still running, and the next listing counts
// a session nothing addresses as lost — the measured value a gate asserts is zero.
func TestACloseTheOwnerPerformedIsNotUndoneByTheIndex(t *testing.T) {
	store := &refusingWriter{}
	if err := Attach(store.backing(), Attachment{Session: "7", Owner: "pty", ViewID: "tab-a"}); err != nil {
		t.Fatal(err)
	}
	index, err := ReadIndex(store)
	if err != nil {
		t.Fatal(err)
	}
	store.refuse = true

	result, err := CloseAndForget(store, index, "7",
		func(string, controlwire.SessionCloseRequest) (controlwire.SessionCloseResult, error) {
			return controlwire.SessionCloseResult{Session: "7", Closed: true, Held: true}, nil
		})
	if err != nil {
		t.Fatalf("a close the owner performed was reported as failed: %v", err)
	}
	if !result.Closed {
		t.Fatalf("the close answered %+v", result)
	}
	if result.Indexed {
		t.Fatal("an index that refused is reported as updated")
	}
}

// A close the owner did not perform leaves the index alone. Removing the attachment would take a
// running session out of every listing.
func TestACloseTheOwnerRefusedLeavesTheIndexAlone(t *testing.T) {
	store := &refusingWriter{}
	if err := Attach(store.backing(), Attachment{Session: "7", Owner: "pty", ViewID: "tab-a"}); err != nil {
		t.Fatal(err)
	}
	index, err := ReadIndex(store)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := CloseAndForget(store, index, "7",
		func(string, controlwire.SessionCloseRequest) (controlwire.SessionCloseResult, error) {
			return controlwire.SessionCloseResult{}, errDown{}
		}); err == nil {
		t.Fatal("a close that never reached its owner was accepted")
	}
	after, err := ReadIndex(store)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != 1 {
		t.Fatalf("a running session left the index: %+v", after)
	}
}

type refusingWriter struct {
	values map[string]string
	refuse bool
}

func (store *refusingWriter) backing() Writer { return store }

func (store *refusingWriter) Get(_, key string) (string, bool, error) {
	value, found := store.values[key]
	return value, found, nil
}

func (store *refusingWriter) Set(_, key, value string) error {
	if store.refuse {
		return errDown{}
	}
	if store.values == nil {
		store.values = map[string]string{}
	}
	store.values[key] = value
	return nil
}

func (store *refusingWriter) Delete(_, key string) error {
	if store.refuse {
		return errDown{}
	}
	delete(store.values, key)
	return nil
}

func (store *refusingWriter) Keys(_ string, prefix *string) ([]string, error) {
	if store.refuse {
		return nil, errDown{}
	}
	names := make([]string, 0, len(store.values))
	for key := range store.values {
		if prefix != nil && !strings.HasPrefix(key, *prefix) {
			continue
		}
		names = append(names, key)
	}
	sort.Strings(names)
	return names, nil
}
