package terminal

import (
	"strings"
	"testing"
)

func TestAWindowLabelNamespacesPaneIds(t *testing.T) {
	// Pane ids are only unique inside their window — the frontend mints
	// per-window sequential view ids, so two windows both hold a "v2". Without
	// the window half of the key, the second window's spawn would reattach to
	// the first window's shell.
	first, err := paneKey("spawn_terminal", "w-1", "v2")
	if err != nil {
		t.Fatalf("paneKey: %v", err)
	}
	second, err := paneKey("spawn_terminal", "w-2", "v2")
	if err != nil {
		t.Fatalf("paneKey: %v", err)
	}
	if first == second {
		t.Fatalf("two windows derived one key: %q", first)
	}
	if first != "w-1/v2" {
		// The owner keys its sessions by this string and the output event
		// carries it back, so the shape is a contract a human also reads.
		t.Fatalf("paneKey = %q, want %q", first, "w-1/v2")
	}

	again, err := paneKey("spawn_terminal", "w-1", "v2")
	if err != nil || again != first {
		t.Fatalf("paneKey = %q, %v, want the same key twice", again, err)
	}
}

func TestASeparatorInEitherHalfIsRefused(t *testing.T) {
	// ("w-1/a", "b") and ("w-1", "a/b") would derive the one key "w-1/a/b", and
	// then one pane's keystrokes reach the other pane's shell.
	for _, testCase := range []struct {
		name   string
		window string
		pane   string
	}{
		{"in the window label", "w-1/a", "b"},
		{"in the pane id", "w-1", "a/b"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := paneKey("spawn_terminal", testCase.window, testCase.pane)
			if err == nil {
				t.Fatal("a half that carries the separator must be refused")
			}
			if !strings.Contains(err.Error(), "/") {
				t.Fatalf("error = %v, want it to name the separator", err)
			}
		})
	}
}

func TestAnEmptyPaneIdIsRefused(t *testing.T) {
	// "" is a key that names nothing. It is not the same answer as an absent
	// paneId, which means the caller has no reattach key at all.
	if _, err := paneKey("spawn_terminal", "w-1", ""); err == nil {
		t.Fatal("an empty pane id must be refused")
	}
}

func TestAnAbsentWindowLabelIsTheSameWindowAsAnEmptyOne(t *testing.T) {
	// The frontend already collapses the two at the source: it sends
	// `currentWindowLabel() || null`, so "" never leaves it. Keeping them apart
	// here would invent a second key for one window and split its panes.
	absent, err := paneKey("spawn_terminal", "", "v2")
	if err != nil {
		t.Fatalf("paneKey: %v", err)
	}
	if absent != "/v2" {
		t.Fatalf("paneKey = %q, want %q", absent, "/v2")
	}
}

func TestAnAnonymousKeyIsOutsideEveryDerivedKey(t *testing.T) {
	// A session spawned with no paneId still needs a name for the owner, and
	// that name must not be one a real pane could derive. Neither half of a
	// derived key may contain a separator, so a derived key holds exactly one —
	// and a minted key holds more.
	sessions := newTable()
	first := sessions.anonymous("w-1")
	second := sessions.anonymous("w-1")
	if first == second {
		t.Fatalf("two anonymous sessions took one key: %q", first)
	}
	if strings.Count(first, "/") < 2 {
		t.Fatalf("anonymous key %q could be derived from a (window, pane) pair", first)
	}
	derived, err := paneKey("spawn_terminal", "w-1", "v2")
	if err != nil {
		t.Fatalf("paneKey: %v", err)
	}
	if strings.Count(derived, "/") != 1 {
		t.Fatalf("derived key %q holds more than the one separator the shapes are told apart by", derived)
	}
}

func TestAnAnonymousKeyKeepsTheWindowItWasSpawnedIn(t *testing.T) {
	// Such a session has no pane, but it is still in a window, and the owner
	// receives nothing about the caller except this key. An earlier build
	// injected the label into the shell of a pane-less session too, so a tool
	// inside it addresses its own window; dropping the label here would leave
	// the owner unable to inject anything.
	sessions := newTable()
	key := sessions.anonymous("w-2")
	fields := strings.Split(key, "/")
	if len(fields) != 3 {
		t.Fatalf("anonymous key %q splits into %d fields, want the three the grammar declares", key, len(fields))
	}
	if fields[0] != "w-2" {
		t.Fatalf("window half = %q, want %q", fields[0], "w-2")
	}
}

func TestAWindowLabelCarryingTheSeparatorIsRefusedOnBothPaths(t *testing.T) {
	// Both key shapes put the window first and are read back by splitting. A
	// label legal for a pane-less spawn and refused for a paned one would make
	// the same window answer differently depending on what else was sent.
	if err := windowHalf("spawn_terminal", "w-1/a"); err == nil {
		t.Fatal("a window label carrying the separator must be refused")
	}
	if err := windowHalf("spawn_terminal", "w-1"); err != nil {
		t.Fatalf("windowHalf: %v", err)
	}
	if _, err := paneKey("spawn_terminal", "w-1/a", "v2"); err == nil {
		t.Fatal("the pane path must refuse the same label")
	}
}

func TestRespawningAPaneDropsThePreviousId(t *testing.T) {
	// The owner replaces its session for a key and closes the one it held. A
	// row left behind in this table would name a shell that no longer exists,
	// and a write against it would look like a hang rather than a failure.
	sessions := newTable()
	first := sessions.install("w-1/v2", "v2", Handle{ID: "w-1/v2", Generation: 1})
	second := sessions.install("w-1/v2", "v2", Handle{ID: "w-1/v2", Generation: 2})

	if first == second {
		t.Fatal("a respawn must mint a new id")
	}
	if _, found := sessions.lookup(first); found {
		t.Fatal("the replaced id is still in the table")
	}
	current, found := sessions.lookup(second)
	if !found || current.handle.Generation != 2 {
		t.Fatalf("lookup = %+v, %v, want the replacement", current, found)
	}
	if sessions.size() != 1 {
		t.Fatalf("size = %d, want one session for one pane", sessions.size())
	}
}

func TestAPaneIsAliveOnlyWhileASessionHoldsIt(t *testing.T) {
	sessions := newTable()
	if _, found := sessions.pane("v2"); found {
		t.Fatal("a pane that never spawned is absent, and absence is an answer rather than a session")
	}

	id := sessions.install("w-1/v2", "v2", Handle{ID: "w-1/v2", Generation: 1})
	handle, found := sessions.pane("v2")
	if !found || handle.Generation != 1 {
		t.Fatalf("pane = %+v, %v, want the live session", handle, found)
	}

	sessions.remove(id)
	if _, found := sessions.pane("v2"); found {
		t.Fatal("a closed pane is not alive")
	}
}

func TestAnAnonymousSessionAnswersForNoPane(t *testing.T) {
	// It has no reattach key, so nothing may find it by pane — least of all the
	// empty pane id, which is refused at the boundary in the first place.
	sessions := newTable()
	sessions.install(sessions.anonymous("w-1"), "", Handle{ID: "anon", Generation: 1})
	if _, found := sessions.pane(""); found {
		t.Fatal("an anonymous session must not answer a pane lookup")
	}
}

func TestRemovingAnUnknownIdReportsAbsence(t *testing.T) {
	// close_terminal is idempotent, and it needs absence and failure told
	// apart to stay that way without swallowing a real error.
	sessions := newTable()
	if _, found := sessions.remove(41); found {
		t.Fatal("removing an id that was never installed must report absence")
	}
}
