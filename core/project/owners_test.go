package project

import (
	"encoding/json"
	"testing"

	"github.com/soksak/soksak-core/core/control"
)

// project_owners is what the frontend queries before opening a root: if another
// window already holds it, that window is focused instead of a second one being
// created. It reads `.owners` off the answer.
//
// Measured 2026-08-15: the host answered a bare array, `.owners` was undefined,
// and the boot died on `t.map is not a function` — the whole application, over
// the shape of one reply.
func TestOwnersAnswersUnderTheKeyTheCallerReads(t *testing.T) {
	registry, _, _, _ := wired(t)

	reply, err := registry.Invoke("project_owners", nil)
	if err != nil {
		t.Fatalf("project_owners: %v", err)
	}

	encoded, err := json.Marshal(reply)
	if err != nil {
		t.Fatalf("encoding: %v", err)
	}
	var answer struct {
		Owners *[]Owner `json:"owners"`
	}
	if err := json.Unmarshal(encoded, &answer); err != nil {
		t.Fatalf("decoding %s: %v", encoded, err)
	}
	if answer.Owners == nil {
		t.Fatalf("project_owners answered %s, which has no owners key", encoded)
	}
}

// An empty list, never null. "Nobody holds anything" and "this build cannot
// tell you" must not arrive as the same answer, and a caller that maps over
// null crashes rather than showing an empty list.
func TestOwnersIsAListWhenNobodyHoldsAnything(t *testing.T) {
	registry, _, _, _ := wired(t)

	reply, err := registry.Invoke("project_owners", nil)
	if err != nil {
		t.Fatalf("project_owners: %v", err)
	}
	encoded, _ := json.Marshal(reply)
	if string(encoded) != `{"owners":[]}` {
		t.Errorf("answered %s, want an empty list under owners", encoded)
	}
}

// Only live windows. A claim held by a window that closed is not a claim, and
// answering with it makes the frontend focus a window that is not there.
func TestOwnersReportsLiveHoldersOnly(t *testing.T) {
	registry, deps, _, live := wired(t)

	root := t.TempDir()
	if _, _, err := deps.Claims.Claim(root, "w-1"); err != nil {
		t.Fatalf("claim: %v", err)
	}

	encoded, _ := json.Marshal(mustInvoke(t, registry, "project_owners"))
	if string(encoded) == `{"owners":[]}` {
		t.Fatalf("a live claim was not reported: %s", encoded)
	}

	live.set("w-2")
	encoded, _ = json.Marshal(mustInvoke(t, registry, "project_owners"))
	if string(encoded) != `{"owners":[]}` {
		t.Errorf("a claim held by a window that closed was reported: %s", encoded)
	}
}

func mustInvoke(t *testing.T, registry *control.Registry, name string) any {
	t.Helper()
	reply, err := registry.Invoke(name, nil)
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return reply
}
