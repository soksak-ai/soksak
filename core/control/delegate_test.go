package control

import (
	"encoding/json"
	"strings"
	"testing"
)

func forwarder(seen *[]string) func(string, Args) (any, error) {
	return func(name string, _ Args) (any, error) {
		*seen = append(*seen, name)
		return "answered by " + name, nil
	}
}

func TestADelegatedNameIsReachedLikeAnyOther(t *testing.T) {
	// The caller must not be able to tell where a command runs. That is the
	// whole reason there is one table.
	registry := NewRegistry()
	var seen []string
	if err := registry.Delegate("win/main", OwnerPlugin, []string{"ui.tree"}, forwarder(&seen)); err != nil {
		t.Fatalf("Delegate: %v", err)
	}

	result, err := registry.Invoke("ui.tree", nil)
	if err != nil {
		t.Fatalf("ui.tree: %v", err)
	}
	if result != "answered by ui.tree" {
		t.Errorf("result = %v", result)
	}
	if len(seen) != 1 {
		t.Errorf("the forwarder ran %d times", len(seen))
	}
}

func TestADelegatedNameIsOnTheTable(t *testing.T) {
	// A table listing only what this process runs itself would tell a caller a
	// command does not exist while another transport answers it.
	registry := NewRegistry()
	_ = registry.Delegate("win/main", OwnerPlugin, []string{"ui.tree", "ui.measure"}, forwarder(new([]string)))

	found := map[string]Owner{}
	for _, command := range registry.Describe().Commands {
		found[command.Name] = command.Owner
	}
	if found["ui.tree"] != OwnerPlugin {
		t.Errorf("ui.tree is owned by %q", found["ui.tree"])
	}
	if _, present := found["ui.measure"]; !present {
		t.Error("ui.measure is not on the table")
	}
}

func TestDeclaringAgainReplacesTheWholeSet(t *testing.T) {
	// A renderer that reloads has a new catalogue. Names it no longer serves
	// must stop being answerable, or a reload leaves entries pointing at a page
	// that is gone.
	registry := NewRegistry()
	_ = registry.Delegate("win/main", OwnerPlugin, []string{"ui.tree", "ui.old"}, forwarder(new([]string)))
	_ = registry.Delegate("win/main", OwnerPlugin, []string{"ui.tree", "ui.new"}, forwarder(new([]string)))

	if _, err := registry.Invoke("ui.old", nil); err == nil {
		t.Error("a name from the previous catalogue still answers")
	}
	if _, err := registry.Invoke("ui.new", nil); err != nil {
		t.Errorf("ui.new: %v", err)
	}
	if _, err := registry.Invoke("ui.tree", nil); err != nil {
		t.Errorf("ui.tree: %v", err)
	}
}

func TestAWithdrawnSourceAnswersNothing(t *testing.T) {
	// A window that closed answers nothing. Leaving its names on the table
	// makes the next caller wait for a reply that cannot come.
	registry := NewRegistry()
	_ = registry.Delegate("win/w-a", OwnerPlugin, []string{"ui.tree"}, forwarder(new([]string)))
	registry.Withdraw("win/w-a")

	if _, err := registry.Invoke("ui.tree", nil); err == nil {
		t.Fatal("a withdrawn name still answers")
	}
	if held := registry.Delegated("win/w-a"); len(held) != 0 {
		t.Errorf("the source still holds %v", held)
	}
}

func TestADelegationCannotShadowWhatThisProcessServes(t *testing.T) {
	// Two answers under one name is the drift a single registry exists to
	// prevent, and the local one is the one with a test.
	registry := NewRegistry()
	registry.MustRegister(Command{Name: "app_environment", Handler: func(Args) (any, error) { return "local", nil }})

	err := registry.Delegate("win/main", OwnerPlugin, []string{"app_environment"}, forwarder(new([]string)))
	if err == nil {
		t.Fatal("a delegation shadowed a served command")
	}
	if !strings.Contains(err.Error(), "app_environment") {
		t.Errorf("the refusal did not name the command: %v", err)
	}

	result, err := registry.Invoke("app_environment", nil)
	if err != nil || result != "local" {
		t.Errorf("the local command stopped answering: %v, %v", result, err)
	}
}

func TestTwoSourcesCannotHoldOneName(t *testing.T) {
	// Two windows both claiming ui.tree would make the answer depend on which
	// declared last, and a caller would never learn which one it reached.
	registry := NewRegistry()
	_ = registry.Delegate("win/main", OwnerPlugin, []string{"ui.tree"}, forwarder(new([]string)))

	err := registry.Delegate("win/w-a", OwnerPlugin, []string{"ui.tree"}, forwarder(new([]string)))
	if err == nil {
		t.Fatal("two sources hold one name")
	}
	if !strings.Contains(err.Error(), "win/main") {
		t.Errorf("the refusal did not name the holder: %v", err)
	}
}

func TestARefusedDelegationChangesNothing(t *testing.T) {
	// A partly-applied declaration would leave the table in a state neither
	// side asked for, and the source would not know which half took.
	registry := NewRegistry()
	registry.MustRegister(Command{Name: "taken", Handler: func(Args) (any, error) { return nil, nil }})
	_ = registry.Delegate("win/main", OwnerPlugin, []string{"ui.tree"}, forwarder(new([]string)))

	if err := registry.Delegate("win/main", OwnerPlugin, []string{"ui.fresh", "taken"}, forwarder(new([]string))); err == nil {
		t.Fatal("a declaration containing a served name was accepted")
	}
	if _, err := registry.Invoke("ui.fresh", nil); err == nil {
		t.Error("half of a refused declaration took effect")
	}
	if _, err := registry.Invoke("ui.tree", nil); err != nil {
		t.Errorf("a refused declaration dropped the previous set: %v", err)
	}
}

func TestTheForwarderReceivesTheArgumentsUntouched(t *testing.T) {
	registry := NewRegistry()
	var got Args
	_ = registry.Delegate("win/main", OwnerPlugin, []string{"ui.measure"},
		func(_ string, args Args) (any, error) { got = args; return nil, nil })

	_, _ = registry.Invoke("ui.measure", Args{"address": json.RawMessage(`"win/main/chrome"`)})

	if string(got["address"]) != `"win/main/chrome"` {
		t.Errorf("the forwarder received %s", got["address"])
	}
}
