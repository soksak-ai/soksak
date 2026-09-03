package session

import "testing"

// The lost count is a measured value, not an accepted outcome. A non-zero one names each lost
// session's owner and last coordinate, because a number alone leaves nobody anywhere to look.
func TestANonZeroLostCountNamesWhatWasLost(t *testing.T) {
	report := LostReport([]Listed{
		{Session: "7", Owner: "pty", State: StateLost, WindowLabel: "w-one", ViewID: "tab-a"},
		{Session: "8", Owner: "pty", State: StateDetached},
	})
	if report.Count != 1 {
		t.Fatalf("the count is %d, not the one session that was lost", report.Count)
	}
	if len(report.Sessions) != 1 {
		t.Fatalf("the report names %d sessions", len(report.Sessions))
	}
	named := report.Sessions[0]
	if named.Session != "7" || named.Owner != "pty" || named.WindowLabel != "w-one" || named.ViewID != "tab-a" {
		t.Fatalf("the lost session came back as %+v", named)
	}
}

// Zero is the pass condition and it names nothing, because nothing was lost.
func TestZeroIsThePassConditionAndNamesNothing(t *testing.T) {
	report := LostReport([]Listed{{Session: "7", Owner: "pty", State: StateDetached}})
	if report.Count != 0 || len(report.Sessions) != 0 {
		t.Fatalf("a listing with nothing lost reported %+v", report)
	}
}

// Only a lost session counts. An orphaned one is waiting for its owner, and counting it would make
// the gate fire every time an owner is down.
func TestOnlyALostSessionCounts(t *testing.T) {
	report := LostReport([]Listed{
		{Session: "7", State: StateOrphaned},
		{Session: "8", State: StateLive},
		{Session: "9", State: StateDetached},
	})
	if report.Count != 0 {
		t.Fatalf("a listing with no lost session counted %d", report.Count)
	}
}
