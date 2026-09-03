package session

import (
	"testing"

	controlwire "github.com/soksak-ai/soksak-contract-control"
)

// A session that was attached when its owner restarted is notified. One nothing is attached to has
// nobody to tell, and a notice for it would be delivered nowhere.
func TestOnlyAnAttachedSessionIsNotified(t *testing.T) {
	notices := Notices([]Listed{
		{Session: "7", Owner: "pty", State: StateLive, ViewID: "tab-a", Outcome: controlwire.SessionDegraded},
		{Session: "8", Owner: "pty", State: StateDetached, ViewID: "tab-b", Outcome: controlwire.SessionFull},
		{Session: "9", Owner: "pty", State: StateOrphaned, ViewID: ""},
	})
	if len(notices) != 2 {
		t.Fatalf("%d notices went out for two attached sessions", len(notices))
	}
}

// The notice states what the restore ended in. A consumer that resumed against a degraded restore
// without knowing would report state the session does not have.
func TestTheNoticeCarriesTheOutcome(t *testing.T) {
	notices := Notices([]Listed{
		{Session: "7", Owner: "pty", State: StateLive, ViewID: "tab-a", Outcome: controlwire.SessionDegraded},
	})
	if len(notices) != 1 {
		t.Fatalf("%d notices", len(notices))
	}
	if notices[0].Notice.Outcome != controlwire.SessionDegraded {
		t.Fatalf("the notice states %q", notices[0].Notice.Outcome)
	}
	if notices[0].ViewID != "tab-a" {
		t.Fatalf("the notice goes to %q", notices[0].ViewID)
	}
}

// A session whose owner answered nothing has no outcome to report. Emitting one would state a
// restore that did not happen.
func TestASessionWithNoOutcomeIsNotNotified(t *testing.T) {
	notices := Notices([]Listed{
		{Session: "7", Owner: "pty", State: StateOrphaned, ViewID: "tab-a"},
	})
	if len(notices) != 0 {
		t.Fatalf("a session with no outcome produced %+v", notices)
	}
}

// A failed restore is what a consumer most needs to hear, and the reason goes with it.
func TestAFailedRestoreIsNotifiedWithItsReason(t *testing.T) {
	notices := Notices([]Listed{
		{
			Session: "7", Owner: "pty", State: StateOrphaned, ViewID: "tab-a",
			Outcome: controlwire.SessionFailed, Reason: "the record does not parse",
		},
	})
	if len(notices) != 1 || notices[0].Notice.Reason == "" {
		t.Fatalf("a failed restore was notified as %+v", notices)
	}
}
