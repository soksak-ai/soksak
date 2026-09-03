package session

import (
	"encoding/json"
	"testing"

	controlwire "github.com/soksak-ai/soksak-contract-control"
)

// The core asks each owner about the sessions the index says that owner holds, and nothing else. An
// owner is asked once however many sessions it holds: one round trip per owner, not per session.
func TestEachOwnerIsAskedOnceAboutOnlyItsOwnSessions(t *testing.T) {
	asked := map[string][]string{}
	answer := func(owner string, sessions []string) (controlwire.SessionReport, error) {
		asked[owner] = append(asked[owner], sessions...)
		outcomes := make([]controlwire.SessionOutcome, 0, len(sessions))
		for _, id := range sessions {
			outcomes = append(outcomes, controlwire.SessionOutcome{
				Session: id, Outcome: controlwire.SessionFull,
			})
		}
		return controlwire.SessionReport{Complete: true, Sessions: outcomes}, nil
	}

	listed, err := List([]Entry{
		{Session: "7", Owner: "pty", Shown: true},
		{Session: "8", Owner: "pty"},
		{Session: "9", Owner: "browser", Shown: true},
	}, answer)
	if err != nil {
		t.Fatal(err)
	}
	if len(asked) != 2 {
		t.Fatalf("%d owners were asked", len(asked))
	}
	if len(asked["pty"]) != 2 || len(asked["browser"]) != 1 {
		t.Fatalf("an owner was asked about another's sessions: %v", asked)
	}
	states := map[string]string{}
	for _, one := range listed {
		states[one.Session] = one.State
	}
	if states["7"] != StateLive || states["8"] != StateDetached || states["9"] != StateLive {
		t.Fatalf("the states came back as %v", states)
	}
}

// An owner that is not running answers nothing. Its sessions are orphaned, never lost: the core
// does not read an owner's store and cannot tell a recoverable session from an unrecoverable one.
func TestAnOwnerThatIsNotRunningLeavesItsSessionsOrphaned(t *testing.T) {
	listed, err := List([]Entry{{Session: "7", Owner: "pty", Shown: true}},
		func(string, []string) (controlwire.SessionReport, error) {
			return controlwire.SessionReport{}, errNotRunning{}
		})
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0].State != StateOrphaned {
		t.Fatalf("a session whose owner is down reports %+v", listed)
	}
}

// An unfinished report is not a final one. A session the owner has not looked for yet is orphaned
// rather than lost, whatever the report says about it.
func TestAnUnfinishedReportCountsNothingLost(t *testing.T) {
	listed, err := List([]Entry{{Session: "7", Owner: "pty"}},
		func(string, []string) (controlwire.SessionReport, error) {
			return controlwire.SessionReport{
				Complete: false,
				Sessions: []controlwire.SessionOutcome{{Session: "7", Outcome: controlwire.SessionLost}},
			}, nil
		})
	if err != nil {
		t.Fatal(err)
	}
	if listed[0].State != StateOrphaned {
		t.Fatalf("an unfinished report counted a session %q", listed[0].State)
	}
}

// A listing is stable. The same index answers in the same order however the map iterated.
func TestTheListingIsOrderedBySessionId(t *testing.T) {
	listed, err := List([]Entry{
		{Session: "9", Owner: "pty"}, {Session: "7", Owner: "pty"}, {Session: "8", Owner: "browser"},
	}, func(_ string, sessions []string) (controlwire.SessionReport, error) {
		outcomes := make([]controlwire.SessionOutcome, 0, len(sessions))
		for _, id := range sessions {
			outcomes = append(outcomes, controlwire.SessionOutcome{Session: id, Outcome: controlwire.SessionFull})
		}
		return controlwire.SessionReport{Complete: true, Sessions: outcomes}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var order []string
	for _, one := range listed {
		order = append(order, one.Session)
	}
	if len(order) != 3 || order[0] != "7" || order[1] != "8" || order[2] != "9" {
		t.Fatalf("the listing came back as %v", order)
	}
}

// The answer states what a caller reads. A shape that changed between builds would be one a caller
// cannot parse, so it is asserted here rather than left to whatever the struct happens to hold.
func TestTheAnswerNamesTheFactsACallerReads(t *testing.T) {
	body, err := json.Marshal(Listed{
		Session: "7", Owner: "pty", State: StateLive,
		WindowLabel: "w-one", ViewID: "tab-a", Outcome: controlwire.SessionFull,
	})
	if err != nil {
		t.Fatal(err)
	}
	var back map[string]any
	if err := json.Unmarshal(body, &back); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"session", "owner", "state", "windowLabel", "viewId", "outcome"} {
		if _, present := back[name]; !present {
			t.Errorf("the answer states no %q", name)
		}
	}
}

type errNotRunning struct{}

func (errNotRunning) Error() string { return "this unit is not open" }
