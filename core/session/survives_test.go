package session

import (
	"testing"

	controlwire "github.com/soksak-ai/soksak-contract-control"
)

// A session survives its window closing. Closing a window releases the sessions shown inside it and
// closes none of them, so the session stays in the index and reports detached.
func TestASessionSurvivesItsWindowClosing(t *testing.T) {
	store := &memoryStore{values: map[string]string{
		"windows":      `{"slots":[{"label":"w-one"}]}`,
		"window/w-one": activeViewSnapshot("pan-a", "tab-a", []string{"tab-a"}),
	}}
	if err := Attach(store, Attachment{Session: "7", Owner: "pty", ViewID: "tab-a", WindowLabel: "w-one"}); err != nil {
		t.Fatal(err)
	}
	if state := stateOfOne(t, store, "7"); state != StateLive {
		t.Fatalf("a shown session reports %q before the window closes", state)
	}

	// The window closed: its slot is gone from the ledger and its snapshot with it.
	delete(store.values, "window/w-one")
	store.values["windows"] = `{"slots":[]}`

	if state := stateOfOne(t, store, "7"); state != StateDetached {
		t.Fatalf("a session whose window closed reports %q, not detached", state)
	}
}

// A session reattaches to a view in another window. The attachment moves and the session does not
// change: the id is what a reference holds, and it is the same one.
func TestASessionReattachesInAnotherWindow(t *testing.T) {
	store := &memoryStore{}
	if err := Attach(store, Attachment{Session: "7", Owner: "pty", ViewID: "tab-a", WindowLabel: "w-one"}); err != nil {
		t.Fatal(err)
	}
	if err := Attach(store, Attachment{Session: "7", Owner: "pty", ViewID: "tab-z", WindowLabel: "w-two"}); err != nil {
		t.Fatal(err)
	}
	store.values["windows"] = `{"slots":[{"label":"w-two"}]}`
	store.values["window/w-two"] = activeViewSnapshot("pan-z", "tab-z", []string{"tab-z"})

	index, err := ReadIndex(store)
	if err != nil {
		t.Fatal(err)
	}
	if len(index) != 1 {
		t.Fatalf("reattaching left %d attachments", len(index))
	}
	if index[0].WindowLabel != "w-two" || index[0].ViewID != "tab-z" || !index[0].Shown {
		t.Fatalf("the session came back as %+v", index[0])
	}
}

// A session survives an application restart. The index is stored, so a process that starts with no
// window open still holds every session, and the window it was in is not the one it returns to.
func TestASessionSurvivesAnApplicationRestart(t *testing.T) {
	store := &memoryStore{values: map[string]string{
		"windows":      `{"slots":[{"label":"w-one"}]}`,
		"window/w-one": activeViewSnapshot("pan-a", "tab-a", []string{"tab-a"}),
	}}
	if err := Attach(store, Attachment{Session: "7", Owner: "pty", ViewID: "tab-a", WindowLabel: "w-one"}); err != nil {
		t.Fatal(err)
	}

	// The application restarted: nothing is open yet, and the store is what came across. The window
	// snapshots did not — no window has opened — so what is left is the index alone.
	restarted := &memoryStore{values: map[string]string{}}
	for key, value := range store.values {
		if key == "windows" || key == "window/w-one" {
			continue
		}
		restarted.values[key] = value
	}

	index, err := ReadIndex(restarted)
	if err != nil {
		t.Fatal(err)
	}
	if len(index) != 1 || index[0].Session != "7" {
		t.Fatalf("a restart left %+v in the index", index)
	}
	if index[0].Shown {
		t.Fatal("a session reports as shown before any window opened")
	}
}

// Closing is the one act that ends a session, and it takes the attachment with it. An attachment
// left behind would keep a closed session in every listing.
func TestClosingTakesTheAttachmentWithIt(t *testing.T) {
	store := &memoryStore{}
	if err := Attach(store, Attachment{Session: "7", Owner: "pty", ViewID: "tab-a"}); err != nil {
		t.Fatal(err)
	}
	index, err := ReadIndex(store)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Close(index, "7", func(string, controlwire.SessionCloseRequest) (controlwire.SessionCloseResult, error) {
		return controlwire.SessionCloseResult{Session: "7", Closed: true, Held: true}, nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := Forget(store, "7"); err != nil {
		t.Fatal(err)
	}
	after, err := ReadIndex(store)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != 0 {
		t.Fatalf("a closed session is still in the index: %+v", after)
	}
}

func stateOfOne(t *testing.T, store Writer, session string) string {
	t.Helper()
	index, err := ReadIndex(store)
	if err != nil {
		t.Fatal(err)
	}
	listed, err := List(index, func(_ string, sessions []string) (controlwire.SessionReport, error) {
		outcomes := make([]controlwire.SessionOutcome, 0, len(sessions))
		for _, id := range sessions {
			outcomes = append(outcomes, controlwire.SessionOutcome{Session: id, Outcome: controlwire.SessionFull})
		}
		return controlwire.SessionReport{Complete: true, Sessions: outcomes}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, one := range listed {
		if one.Session == session {
			return one.State
		}
	}
	t.Fatalf("session %s is not in the listing", session)
	return ""
}

// A session released by session.detach is listed as detached, not gone.
//
// S5: only a closed session returns nothing. S6-5: the core offers every detached session. A
// release that took the session out of the listing left a shell running with nothing addressing it.
func TestAReleasedSessionIsListedAsDetached(t *testing.T) {
	store := &memoryStore{values: map[string]string{
		"windows":      `{"slots":[{"label":"w-one"}]}`,
		"window/w-one": activeViewSnapshot("pan-a", "tab-a", []string{"tab-a"}),
	}}
	if err := Attach(store, Attachment{Session: "7", Owner: "pty", ViewID: "tab-a", WindowLabel: "w-one"}); err != nil {
		t.Fatal(err)
	}
	if state := stateOfOne(t, store, "7"); state != StateLive {
		t.Fatalf("a shown session reports %q", state)
	}
	if err := Detach(store, "7"); err != nil {
		t.Fatal(err)
	}
	if state := stateOfOne(t, store, "7"); state != StateDetached {
		t.Fatalf("a released session reports %q, not detached", state)
	}
}
