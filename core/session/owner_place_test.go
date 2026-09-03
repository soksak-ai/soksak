package session

import (
	"testing"

	controlwire "github.com/soksak-ai/soksak-contract-control"
	"github.com/soksak-ai/soksak-core/core/control"
)

// Every owner is asked over its own socket, and none is asked inside a window.
//
// A session survives its window closing and reports detached (S10). A component inside a window
// goes when the window does, so one that owned a session would report lost at the one moment that
// rules out — and answering from another window that happens to be open makes whether a session
// exists depend on what else the person left open.
//
// This was built the other way first, on the premise that a browser view was a session. It is not
// (S1-4), and the owner set is one unit.
func TestAnOwnerIsAskedOverItsOwnSocket(t *testing.T) {
	var asked []string
	send := func(name string, request controlwire.Request) (controlwire.Response, error) {
		asked = append(asked, name+" "+request.Command)
		// A window would travel in the args. Nothing puts one there, and this is where that would
		// show up.
		if _, named := request.Args["window"]; named {
			t.Fatalf("%s was asked inside a window", name)
		}
		return controlwire.Response{Ok: true, Result: controlwire.SessionReport{Complete: true}}, nil
	}

	index := []Entry{{Session: "7", Owner: "a-unit", WindowLabel: "main", ViewID: "v1"}}
	if _, err := List(index, AskThrough(send)); err != nil {
		t.Fatalf("listing: %v", err)
	}
	if len(asked) != 1 || asked[0] != "a-unit "+controlwire.SessionsCommand {
		t.Fatalf("asked %v, want the owner once over its socket", asked)
	}
}

// The group refuses by name when it has no way to reach an owner.
//
// A caller that receives "unknown command" cannot tell a capability this build does not have from
// a name it typed wrong.
func TestTheGroupRefusesByNameWithNoRouteToAnOwner(t *testing.T) {
	registry := control.NewRegistry()
	Register(registry, Registration{Store: &memoryStore{}})

	unserved := map[string]bool{}
	for _, entry := range registry.Describe().Unserved {
		unserved[entry.Name] = true
	}
	for _, name := range Names() {
		if !unserved[name] {
			t.Fatalf("%s is neither served nor declared unserved", name)
		}
	}
}
