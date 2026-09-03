package session

import (
	"encoding/json"
	"testing"

	controlwire "github.com/soksak-ai/soksak-contract-control"
)

// The index is what the core owns: which sessions exist, which component owns each, and where each
// was last shown. It is read out of the window snapshots the application already writes, because a
// second place to record it would be a second answer to the same question.
func TestTheIndexReadsEveryBindingAWindowHolds(t *testing.T) {
	reader := fakeStore{
		"windows": `{"slots":[{"label":"w-one"},{"label":"w-two"}]}`,
		"window/w-one": snapshot(t, []binding{
			{pane: "pan-a", view: "tab-a", active: "tab-a", owner: "pty", id: "7"},
			{pane: "pan-b", view: "tab-b", active: "tab-other", owner: "pty", id: "8"},
		}),
		"window/w-two": snapshot(t, []binding{
			{pane: "pan-c", view: "tab-c", active: "tab-c", owner: "browser", id: "9"},
		}),
	}

	entries, err := ReadIndex(reader)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 3 {
		t.Fatalf("the index holds %d bindings, not the three the windows hold", len(entries))
	}
	byID := map[string]Entry{}
	for _, entry := range entries {
		byID[entry.Session] = entry
	}
	if byID["7"].Owner != "pty" || byID["7"].WindowLabel != "w-one" || byID["7"].ViewID != "tab-a" {
		t.Fatalf("the binding came back as %+v", byID["7"])
	}
	if !byID["7"].Shown {
		t.Fatal("a session whose view is its pane's active one is not shown")
	}
	if byID["8"].Shown {
		t.Fatal("a session behind another tab is shown")
	}
	if byID["9"].Owner != "browser" {
		t.Fatalf("the second window's binding came back as %+v", byID["9"])
	}
}

// A window with no snapshot is a slot the application has not written yet. It contributes nothing
// rather than refusing: one window's absence must not hide every other window's sessions.
func TestAWindowWithNoSnapshotContributesNothing(t *testing.T) {
	entries, err := ReadIndex(fakeStore{"windows": `{"slots":[{"label":"w-gone"}]}`})
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("a slot with no snapshot produced %d bindings", len(entries))
	}
}

// A snapshot that does not parse costs that window only. Refusing the whole read would hide every
// other window's sessions behind one bad record.
func TestASnapshotThatDoesNotParseCostsThatWindowOnly(t *testing.T) {
	entries, err := ReadIndex(fakeStore{
		"windows":      `{"slots":[{"label":"w-bad"},{"label":"w-good"}]}`,
		"window/w-bad": `{"workspaces":`,
		"window/w-good": snapshot(t, []binding{
			{pane: "pan-a", view: "tab-a", active: "tab-a", owner: "pty", id: "7"},
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Session != "7" {
		t.Fatalf("one unreadable window cost the other its sessions: %+v", entries)
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

type binding struct{ pane, view, active, owner, id string }

type fakeStore map[string]string

func (store fakeStore) Get(ns, key string) (string, bool, error) {
	value, found := store[key]
	return value, found, nil
}

func snapshot(t *testing.T, bindings []binding) string {
	t.Helper()
	views := make([]any, 0, len(bindings))
	panes := make([]any, 0, len(bindings))
	for _, held := range bindings {
		views = append(views, map[string]any{
			"id": held.view, "kind": "plugin", "title": "T", "pluginId": "p", "view": "content",
			"session": map[string]any{"owner": held.owner, "id": held.id},
		})
		panes = append(panes, map[string]any{
			"t": "l",
			"v": map[string]any{
				"id": held.pane, "activeViewId": held.active,
				"views": []any{views[len(views)-1]},
			},
		})
	}
	body, err := json.Marshal(map[string]any{
		"activeId": "wsp-a",
		"workspaces": []any{map[string]any{
			"id": "wsp-a", "activeContentId": "spc-a",
			"contents": []any{map[string]any{
				"id": "spc-a", "activeGroupId": "pan-a",
				"layout": map[string]any{"t": "s", "id": "spl-a", "dir": "row", "children": panes},
			}},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}
