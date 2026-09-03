package session

import "testing"

// The attachment is a record of its own, not a field on the view. A view goes away with the window
// that held it, and a session outlives both: closing a window releases what it showed and closes
// nothing, so an attachment stored on the view would take the session out of the index with it.
func TestAnAttachmentOutlivesTheViewItNames(t *testing.T) {
	store := &memoryStore{}
	if err := Attach(store, Attachment{Session: "7", Owner: "pty", ViewID: "tab-a", WindowLabel: "w-one"}); err != nil {
		t.Fatal(err)
	}

	// The window closed: its snapshot is gone and its slot with it.
	index, err := ReadIndex(store)
	if err != nil {
		t.Fatal(err)
	}
	if len(index) != 1 || index[0].Session != "7" {
		t.Fatalf("the session left the index with its window: %+v", index)
	}
	if index[0].Shown {
		t.Fatal("a session whose view is gone is reported as shown")
	}
}

// Detaching removes the record and ends nothing.
func TestDetachingRemovesTheRecord(t *testing.T) {
	store := &memoryStore{}
	if err := Attach(store, Attachment{Session: "7", Owner: "pty", ViewID: "tab-a"}); err != nil {
		t.Fatal(err)
	}
	if err := Detach(store, "7"); err != nil {
		t.Fatal(err)
	}
	index, err := ReadIndex(store)
	if err != nil {
		t.Fatal(err)
	}
	if len(index) != 0 {
		t.Fatalf("a detached session is still in the index: %+v", index)
	}
}

// Attaching the same session somewhere else moves it rather than holding two attachments. A session
// shown in two places at once is one the index cannot answer "where" for.
func TestAttachingAgainMovesTheSession(t *testing.T) {
	store := &memoryStore{}
	for _, view := range []string{"tab-a", "tab-b"} {
		if err := Attach(store, Attachment{Session: "7", Owner: "pty", ViewID: view}); err != nil {
			t.Fatal(err)
		}
	}
	index, err := ReadIndex(store)
	if err != nil {
		t.Fatal(err)
	}
	if len(index) != 1 || index[0].ViewID != "tab-b" {
		t.Fatalf("the session is attached to %+v", index)
	}
}

// A session whose view is the pane's active one is shown. One behind another tab is held all the
// same and nothing is showing it.
func TestShownFollowsTheLayoutNotTheAttachment(t *testing.T) {
	store := &memoryStore{}
	if err := Attach(store, Attachment{Session: "7", Owner: "pty", ViewID: "tab-a", WindowLabel: "w-one"}); err != nil {
		t.Fatal(err)
	}
	if err := Attach(store, Attachment{Session: "8", Owner: "pty", ViewID: "tab-b", WindowLabel: "w-one"}); err != nil {
		t.Fatal(err)
	}
	store.values["windows"] = `{"slots":[{"label":"w-one"}]}`
	store.values["window/w-one"] = activeViewSnapshot("pan-a", "tab-a", []string{"tab-a", "tab-b"})

	index, err := ReadIndex(store)
	if err != nil {
		t.Fatal(err)
	}
	shown := map[string]bool{}
	for _, entry := range index {
		shown[entry.Session] = entry.Shown
	}
	if !shown["7"] {
		t.Fatal("the pane's active view does not report its session as shown")
	}
	if shown["8"] {
		t.Fatal("a view behind another tab reports its session as shown")
	}
}

type memoryStore struct{ values map[string]string }

func (store *memoryStore) Get(_, key string) (string, bool, error) {
	if store.values == nil {
		return "", false, nil
	}
	value, found := store.values[key]
	return value, found, nil
}

func (store *memoryStore) Set(_, key, value string) error {
	if store.values == nil {
		store.values = map[string]string{}
	}
	store.values[key] = value
	return nil
}

func (store *memoryStore) Delete(_, key string) error {
	delete(store.values, key)
	return nil
}

func activeViewSnapshot(pane, active string, views []string) string {
	body := `{"workspaces":[{"contents":[{"layout":{"t":"l","v":{"id":"` + pane +
		`","activeViewId":"` + active + `","views":[`
	for i, view := range views {
		if i > 0 {
			body += ","
		}
		body += `{"id":"` + view + `"}`
	}
	return body + `]}}}]}]}`
}

// One unreadable attachment costs that session and no other.
//
// The index was one document, so a byte that went wrong in it took every session out of every
// listing at once — the same all-or-nothing S4-4 refuses for an owner's store, applied to the core's
// own index. A caller then has no sessions rather than one it cannot place.
func TestOneUnreadableAttachmentCostsThatSessionOnly(t *testing.T) {
	store := &memoryStore{}
	for _, attachment := range []Attachment{
		{Session: "7", Owner: "pty", ViewID: "tab-a"},
		{Session: "8", Owner: "pty", ViewID: "tab-b"},
	} {
		if err := Attach(store, attachment); err != nil {
			t.Fatal(err)
		}
	}
	// One session's record is what a corrupt byte reaches, and it reaches no other.
	store.values["sessions/7"] = `{"session":`

	index, err := ReadIndex(store)
	if err != nil {
		t.Fatal(err)
	}
	if len(index) != 1 || index[0].Session != "8" {
		t.Fatalf("one unreadable attachment left %+v", index)
	}
}

// An attachment whose stated session does not match the key it was found under is refused rather
// than repaired: one of the two is wrong and neither states which.
func TestAnAttachmentWhoseSessionDoesNotMatchItsKeyIsRefused(t *testing.T) {
	store := &memoryStore{}
	if err := Attach(store, Attachment{Session: "7", Owner: "pty", ViewID: "tab-a"}); err != nil {
		t.Fatal(err)
	}
	store.values["sessions/7"] = `{"session":"8","owner":"pty","viewId":"tab-a"}`

	index, err := ReadIndex(store)
	if err != nil {
		t.Fatal(err)
	}
	if len(index) != 0 {
		t.Fatalf("a record naming another session was read: %+v", index)
	}
}
