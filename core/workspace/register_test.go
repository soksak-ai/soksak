package workspace

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/soksak-ai/soksak-core/core/control"
)

type broadcast struct {
	events   []string
	payloads []any
}

func (b *broadcast) note(event string, payload any) {
	b.events = append(b.events, event)
	b.payloads = append(b.payloads, payload)
}

func args(t *testing.T, pairs map[string]any) control.Args {
	t.Helper()
	encoded := control.Args{}
	for key, value := range pairs {
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("encoding %s: %v", key, err)
		}
		encoded[key] = raw
	}
	return encoded
}

func wired(t *testing.T) (*control.Registry, Deps, *broadcast, *windows) {
	t.Helper()
	live := &windows{}
	live.set("w-1", "w-2")
	sent := &broadcast{}
	deps := Deps{
		Home:     t.TempDir(),
		UserHome: t.TempDir(),
		Manifest: &store{},
		Claims:   NewLedger(live),
		Changed:  sent.note,
	}
	registry := control.NewRegistry()
	Register(registry, deps)
	return registry, deps, sent, live
}

// None of these needs a window: the calling label arrives as an argument, which
// is what keeps them answerable with no window at all.
func TestTheWorkspaceCommandsAreCoreOwned(t *testing.T) {
	registry, _, _, _ := wired(t)

	owners := map[string]control.Owner{}
	for _, command := range registry.Describe().Commands {
		owners[command.Name] = command.Owner
	}
	for _, name := range []string{
		"validate_workspace_root", "ensure_workspace_dir",
		"workspace_claim", "workspace_release", "window_manifest_upsert",
	} {
		owner, served := owners[name]
		if !served {
			t.Errorf("%s is not registered", name)
			continue
		}
		if owner != control.OwnerCore {
			t.Errorf("%s is owned by %s, want %s", name, owner, control.OwnerCore)
		}
	}
}

func TestEachCommandNamesTheArgumentItIsMissing(t *testing.T) {
	registry, _, _, _ := wired(t)

	for _, missing := range []struct {
		command  string
		args     map[string]any
		argument string
	}{
		{"validate_workspace_root", map[string]any{}, "path"},
		{"ensure_workspace_dir", map[string]any{}, "folder"},
		{"workspace_claim", map[string]any{"window": "w-1"}, "root"},
		{"workspace_claim", map[string]any{"root": "/p"}, "window"},
		{"workspace_release", map[string]any{"window": "w-1"}, "root"},
		{"workspace_release", map[string]any{"root": "/p"}, "window"},
		{"window_manifest_upsert", map[string]any{"focused": true}, "entry"},
	} {
		_, err := registry.Invoke(missing.command, args(t, missing.args))
		if err == nil {
			t.Errorf("%s answered with %v missing", missing.command, missing.argument)
			continue
		}
		// The phrasing, not just the word. Every one of these arguments is
		// also named by the refusal further in — "a workspace root must be an
		// absolute path" holds "path" — so a handler that silently substituted
		// the zero value would pass a test that only looked for the name.
		if want := fmt.Sprintf("missing argument %q", missing.argument); !strings.Contains(err.Error(), want) {
			t.Errorf("%s did not report %s: %v", missing.command, want, err)
		}
	}
}

// The calling window is stamped by the transport, never sent by the caller: a
// caller-supplied label is forgeable, and a forged one releases another
// window's claim. Guessing "main" here would do the same thing by default.
func TestAClaimWithNoWindowIsNotGuessed(t *testing.T) {
	registry, deps, _, _ := wired(t)

	if _, err := registry.Invoke("workspace_claim", args(t, map[string]any{"root": "/p"})); err == nil {
		t.Fatal("a claim with no calling window was accepted")
	}
	if owners := deps.Claims.Owners(); len(owners) != 0 {
		t.Errorf("owners = %v, want none: nothing was claimed", owners)
	}
}

func TestValidateAndEnsureAnswerThroughTheRegistry(t *testing.T) {
	registry, deps, _, _ := wired(t)

	made, err := registry.Invoke("ensure_workspace_dir", args(t, map[string]any{"folder": "my-app"}))
	if err != nil {
		t.Fatalf("ensure_workspace_dir: %v", err)
	}
	if want := filepath.Join(deps.Home, "workspaces", "my-app"); made != want {
		t.Errorf("ensure_workspace_dir = %v, want %q", made, want)
	}

	// The identity home holds app-made folders; the user home is what the root
	// verdict compares against. Mixing them puts a workspace root inside the
	// app-managed area.
	if _, err := registry.Invoke("validate_workspace_root", args(t, map[string]any{"path": deps.UserHome})); err == nil {
		t.Error("the user home was accepted as a workspace root")
	}
	got, err := registry.Invoke("validate_workspace_root", args(t, map[string]any{"path": made}))
	if err != nil {
		t.Fatalf("validate_workspace_root on an app-made folder: %v", err)
	}
	if got == "" {
		t.Error("validate_workspace_root answered with nothing")
	}
}

// Notification follows mutation. If restore and retry each announced a change,
// every window would re-read on every step and a real change would be lost in
// the noise.
func TestOnlyMutationsAreBroadcast(t *testing.T) {
	registry, _, sent, _ := wired(t)

	first, err := registry.Invoke("workspace_claim", args(t, map[string]any{"root": "/p", "window": "w-1"}))
	if err != nil {
		t.Fatalf("claiming: %v", err)
	}
	if reply := first.(ClaimReply); !reply.Ok {
		t.Fatalf("the first claim was refused: %+v", reply)
	}
	if len(sent.events) != 1 || sent.events[0] != ChangeEvent {
		t.Fatalf("events = %v, want one %s", sent.events, ChangeEvent)
	}

	if _, err := registry.Invoke("workspace_claim", args(t, map[string]any{"root": "/p", "window": "w-1"})); err != nil {
		t.Fatalf("re-claiming: %v", err)
	}
	refused, err := registry.Invoke("workspace_claim", args(t, map[string]any{"root": "/p", "window": "w-2"}))
	if err != nil {
		t.Fatalf("a conflicting claim answered with an error: %v", err)
	}
	if reply := refused.(ClaimReply); reply.Ok || reply.OwnedBy != "w-1" {
		t.Errorf("reply = %+v, want the owner named", reply)
	}
	if len(sent.events) != 1 {
		t.Errorf("events = %v, want still one", sent.events)
	}

	// A non-owner cannot release, and nothing is announced.
	nonOwner, err := registry.Invoke("workspace_release", args(t, map[string]any{"root": "/p", "window": "w-2"}))
	if err != nil {
		t.Fatalf("a non-owner release answered with an error: %v", err)
	}
	if nonOwner.(ReleaseReply).Released {
		t.Error("a non-owner released another window's root")
	}
	if len(sent.events) != 1 {
		t.Errorf("events = %v, want still one", sent.events)
	}

	owner, err := registry.Invoke("workspace_release", args(t, map[string]any{"root": "/p", "window": "w-1"}))
	if err != nil {
		t.Fatalf("the owner's release: %v", err)
	}
	if !owner.(ReleaseReply).Released {
		t.Error("the owner could not release its own root")
	}
	if len(sent.events) != 2 {
		t.Errorf("events = %v, want two", sent.events)
	}
}

// Close paths run more than once, so releasing what nobody holds is an ordinary
// answer rather than a failure.
func TestReleasingAnUnclaimedRootIsNotAFailure(t *testing.T) {
	registry, _, sent, _ := wired(t)

	reply, err := registry.Invoke("workspace_release", args(t, map[string]any{"root": "/nope", "window": "w-1"}))
	if err != nil {
		t.Fatalf("releasing a root nobody claimed: %v", err)
	}
	if reply.(ReleaseReply).Released {
		t.Error("released = true for a root nobody claimed")
	}
	if len(sent.events) != 0 {
		t.Errorf("events = %v, want none", sent.events)
	}
}

func TestTheManifestUpsertAnswersWhetherItChanged(t *testing.T) {
	registry, _, _, _ := wired(t)
	entry := map[string]any{"label": "w-1", "roots": []any{"/a"}}

	changed, err := registry.Invoke("window_manifest_upsert", args(t, map[string]any{"entry": entry, "focused": true}))
	if err != nil {
		t.Fatalf("the first upsert: %v", err)
	}
	if changed != true {
		t.Errorf("changed = %v, want true", changed)
	}

	// focused is optional: a save that does not claim focus is absence, not a
	// missing argument.
	again, err := registry.Invoke("window_manifest_upsert", args(t, map[string]any{"entry": entry}))
	if err != nil {
		t.Fatalf("the second upsert: %v", err)
	}
	if again != false {
		t.Errorf("changed = %v, want false", again)
	}
}

// Boot-time wiring is a programming fact. Discovering it when a user opens a
// workspace is worse than discovering it at startup.
func TestRegisterRefusesIncompleteWiring(t *testing.T) {
	complete := func() Deps {
		live := &windows{}
		live.set("w-1")
		return Deps{
			Home:     t.TempDir(),
			UserHome: t.TempDir(),
			Manifest: &store{},
			Claims:   NewLedger(live),
			Changed:  func(string, any) {},
		}
	}

	// A slice rather than a map: one field has two ways to be wrong, and both
	// have to be refused by that field's name.
	relative := filepath.Join("relative", "home")
	for _, broken := range []struct {
		field  string
		why    string
		break_ func(*Deps)
	}{
		{"Home", "empty", func(d *Deps) { d.Home = "" }},
		{"UserHome", "empty", func(d *Deps) { d.UserHome = "" }},
		{"Manifest", "nil", func(d *Deps) { d.Manifest = nil }},
		{"Claims", "nil", func(d *Deps) { d.Claims = nil }},
		{"Changed", "nil", func(d *Deps) { d.Changed = nil }},
		// A relative home is not absence. It is the same wrong tree reached
		// quietly, and boot is the last place that can still name the field.
		{"Home", "relative", func(d *Deps) { d.Home = relative }},
		{"UserHome", "relative", func(d *Deps) { d.UserHome = relative }},
	} {
		func() {
			defer func() {
				recovered := recover()
				if recovered == nil {
					t.Errorf("Register accepted wiring with a %s %s", broken.why, broken.field)
					return
				}
				if !strings.Contains(toText(recovered), broken.field) {
					t.Errorf("the panic for a %s %s did not name it: %v", broken.why, broken.field, recovered)
				}
			}()
			deps := complete()
			broken.break_(&deps)
			Register(control.NewRegistry(), deps)
		}()
	}
}

func toText(value any) string {
	if err, isError := value.(error); isError {
		return err.Error()
	}
	text, _ := value.(string)
	return text
}

// A save that does not claim focus omits the flag. Absence is "not focused",
// and reading it as focused lets a background window's debounced save steal the
// record — the user reopens onto a window they were not looking at.
func TestAnUpsertWithNoFocusFlagDoesNotClaimFocus(t *testing.T) {
	registry, deps, _, _ := wired(t)
	backing, isFake := deps.Manifest.(*store)
	if !isFake {
		t.Fatalf("this case needs the fake store, got %T", deps.Manifest)
	}

	focused := map[string]any{"label": "w-1", "roots": []any{"/a"}}
	if _, err := registry.Invoke("window_manifest_upsert", args(t, map[string]any{"entry": focused, "focused": true})); err != nil {
		t.Fatalf("the focused save: %v", err)
	}

	background := map[string]any{"label": "w-2", "roots": []any{"/b"}}
	if _, err := registry.Invoke("window_manifest_upsert", args(t, map[string]any{"entry": background})); err != nil {
		t.Fatalf("the save with no focus flag: %v", err)
	}
	if got := backing.manifest(t)["focusedLabel"]; got != "w-1" {
		t.Errorf("focusedLabel = %v after a save that claimed nothing, want w-1", got)
	}
}
