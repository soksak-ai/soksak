package session

import (
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
