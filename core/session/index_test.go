package session

import (
	"testing"

	controlwire "github.com/soksak-ai/soksak-contract-control"
)

// The index is what the core owns: which sessions exist, which component owns each, and where each
// was last shown. Every attachment is in it, whatever became of the window that held the view.
func TestTheIndexHoldsEveryAttachment(t *testing.T) {
	store := &memoryStore{}
	for _, attachment := range []Attachment{
		{Session: "7", Owner: "pty", ViewID: "tab-a", WindowLabel: "w-one"},
		{Session: "8", Owner: "pty", ViewID: "tab-b", WindowLabel: "w-one"},
		{Session: "9", Owner: "browser", ViewID: "tab-c", WindowLabel: "w-two"},
	} {
		if err := Attach(store, attachment); err != nil {
			t.Fatal(err)
		}
	}

	index, err := ReadIndex(store)
	if err != nil {
		t.Fatal(err)
	}
	if len(index) != 3 {
		t.Fatalf("the index holds %d attachments, not the three that were made", len(index))
	}
	byID := map[string]Entry{}
	for _, entry := range index {
		byID[entry.Session] = entry
	}
	if byID["7"].Owner != "pty" || byID["7"].WindowLabel != "w-one" || byID["7"].ViewID != "tab-a" {
		t.Fatalf("the attachment came back as %+v", byID["7"])
	}
	if byID["9"].Owner != "browser" {
		t.Fatalf("the second window's attachment came back as %+v", byID["9"])
	}
}

// A window with no snapshot leaves its sessions in the index. It is a window the application has
// not written yet, or one that closed, and neither ends a session.
func TestAWindowWithNoSnapshotKeepsItsSessions(t *testing.T) {
	store := &memoryStore{values: map[string]string{"windows": `{"slots":[{"label":"w-gone"}]}`}}
	if err := Attach(store, Attachment{Session: "7", Owner: "pty", ViewID: "tab-a", WindowLabel: "w-gone"}); err != nil {
		t.Fatal(err)
	}
	index, err := ReadIndex(store)
	if err != nil {
		t.Fatal(err)
	}
	if len(index) != 1 || index[0].Shown {
		t.Fatalf("a slot with no snapshot produced %+v", index)
	}
}

// A snapshot that does not parse costs what it answers — whether a view is shown — and nothing
// else. The index is read from the attachments, so one unreadable window hides no session.
func TestASnapshotThatDoesNotParseHidesNoSession(t *testing.T) {
	store := &memoryStore{values: map[string]string{
		"windows":      `{"slots":[{"label":"w-bad"}]}`,
		"window/w-bad": `{"workspaces":`,
	}}
	if err := Attach(store, Attachment{Session: "7", Owner: "pty", ViewID: "tab-a", WindowLabel: "w-bad"}); err != nil {
		t.Fatal(err)
	}
	index, err := ReadIndex(store)
	if err != nil {
		t.Fatal(err)
	}
	if len(index) != 1 || index[0].Session != "7" {
		t.Fatalf("an unreadable window hid a session: %+v", index)
	}
}

// The state follows from what the owner reports and from whether a view shows it. A session no
// owner holds is orphaned however long its owner is down, because the core does not read an owner's
// store and cannot tell a recoverable session from an unrecoverable one.
func TestTheStateFollowsFromTheOwnerReportAndTheView(t *testing.T) {
	for _, probe := range []struct {
		name    string
		outcome string
		known   bool
		shown   bool
		want    string
	}{
		{"held and shown", controlwire.SessionFull, true, true, StateLive},
		{"held and behind a tab", controlwire.SessionFull, true, false, StateDetached},
		{"restored from creation facts", controlwire.SessionDegraded, true, true, StateLive},
		{"a record the owner could not use", controlwire.SessionFailed, true, true, StateOrphaned},
		{"the owner has no record", controlwire.SessionLost, true, true, StateLost},
		{"the owner is not running", "", false, true, StateOrphaned},
	} {
		t.Run(probe.name, func(t *testing.T) {
			got := StateOf(probe.outcome, probe.known, probe.shown)
			if got != probe.want {
				t.Fatalf("%s reported %q, not %q", probe.name, got, probe.want)
			}
		})
	}
}
