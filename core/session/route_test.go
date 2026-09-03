package session

import (
	"testing"

	controlwire "github.com/soksak-ai/soksak-contract-control"
)

// An owner is a component that holds sessions, and where it runs is not the question the core is
// asking. Some run in a process of their own and some run in the renderer, and the core sends the
// same command either way: a caller cannot tell where a command runs, which is the point.
func TestTheQuestionGoesToWhicheverPlaceTheOwnerRunsIn(t *testing.T) {
	var toUnit, toRenderer []string
	ask := AskEither(
		func(name string) bool { return name == "pty" },
		func(owner string, request controlwire.Request) (controlwire.Response, error) {
			toUnit = append(toUnit, owner)
			return answered(request), nil
		},
		func(owner string, request controlwire.Request) (controlwire.Response, error) {
			toRenderer = append(toRenderer, owner)
			return answered(request), nil
		},
	)

	if _, err := ask("pty", []string{"7"}); err != nil {
		t.Fatal(err)
	}
	if _, err := ask("soksak-plugin-browser-wails3", []string{"9"}); err != nil {
		t.Fatal(err)
	}
	if len(toUnit) != 1 || toUnit[0] != "pty" {
		t.Fatalf("the unit was asked %v", toUnit)
	}
	if len(toRenderer) != 1 || toRenderer[0] != "soksak-plugin-browser-wails3" {
		t.Fatalf("the renderer was asked %v", toRenderer)
	}
}

// One command name, whichever place answers it. A name per place would make the core know where an
// owner runs before it could ask, and where it runs is not what the core is asking about.
func TestBothPlacesAreSentTheSameCommand(t *testing.T) {
	var sent []string
	record := func(_ string, request controlwire.Request) (controlwire.Response, error) {
		sent = append(sent, request.Command)
		return answered(request), nil
	}
	ask := AskEither(func(name string) bool { return name == "pty" }, record, record)

	if _, err := ask("pty", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := ask("a-plugin", nil); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 2 || sent[0] != controlwire.SessionsCommand || sent[1] != controlwire.SessionsCommand {
		t.Fatalf("the two places were sent %v", sent)
	}
}

// An owner that answers nowhere is one whose sessions wait for it. The refusal travels rather than
// being turned into an empty report, because an empty report is a session counted lost.
func TestAnOwnerThatAnswersNowhereRefuses(t *testing.T) {
	ask := AskEither(
		func(string) bool { return false },
		func(string, controlwire.Request) (controlwire.Response, error) {
			t.Fatal("a unit was asked about an owner that is not one")
			return controlwire.Response{}, nil
		},
		func(string, controlwire.Request) (controlwire.Response, error) {
			return controlwire.Response{}, errUnreachable{}
		},
	)
	if _, err := ask("a-plugin", nil); err == nil {
		t.Fatal("an owner that answers nowhere reported a session report")
	}
}

type errUnreachable struct{}

func (errUnreachable) Error() string { return "nothing serves that name" }

func answered(request controlwire.Request) controlwire.Response {
	return controlwire.Response{
		ID: request.ID, Ok: true,
		Result: map[string]any{"code": "OK", "data": controlwire.SessionReport{Complete: true}},
	}
}
