package session

import (
	"encoding/json"
	"testing"

	controlwire "github.com/soksak-ai/soksak-contract-control"
)

// An owner is a component that holds sessions, and where it runs is not the question the core is
// asking. Some run in a process of their own and some run in the renderer, and the core sends the
// same command either way: a caller cannot tell where a command runs, which is the point.
func TestTheQuestionGoesToWhicheverPlaceTheOwnerRunsIn(t *testing.T) {
	var toUnit, toRenderer []string
	ask := AskEitherIn(
		func(string) []string { return []string{"main"} },
		func(name string) bool { return name == "pty" },
		func(owner string, request controlwire.Request) (controlwire.Response, error) {
			toUnit = append(toUnit, owner)
			return answered(request), nil
		},
		func(owner string, request controlwire.Request) (controlwire.Response, error) {
			toRenderer = append(toRenderer, owner)
			return answered(request), nil
		},
	).In("main")

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
	ask := AskEitherIn(func(string) []string { return []string{"main"} },
		func(name string) bool { return name == "pty" }, record, record).In("main")

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
	ask := AskEitherIn(
		func(string) []string { return []string{"main"} },
		func(string) bool { return false },
		func(string, controlwire.Request) (controlwire.Response, error) {
			t.Fatal("a unit was asked about an owner that is not one")
			return controlwire.Response{}, nil
		},
		func(string, controlwire.Request) (controlwire.Response, error) {
			return controlwire.Response{}, errUnreachable{}
		},
	).In("main")
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

// A plugin serves its commands under the name the host gives them, and the core has to send that
// name. One built a different way addresses nothing, and the owner reports orphaned forever with
// no error to say why.
func TestAPluginOwnerIsAddressedByTheNameItsCommandsAreServedUnder(t *testing.T) {
	var sent string
	ask := AskEitherIn(
		func(string) []string { return []string{"main"} },
		func(string) bool { return false },
		func(string, controlwire.Request) (controlwire.Response, error) {
			t.Fatal("a unit was asked about a plugin owner")
			return controlwire.Response{}, nil
		},
		func(owner string, request controlwire.Request) (controlwire.Response, error) {
			sent = PluginCommandName(owner, request.Command)
			return answered(request), nil
		},
	).In("main")
	if _, err := ask("soksak-plugin-browser-wails3", nil); err != nil {
		t.Fatal(err)
	}
	if sent != "plugin.soksak-plugin-browser-wails3.system.sessions" {
		t.Fatalf("the plugin was addressed as %q", sent)
	}
}

// A plugin answers in a window, so the question has to name one.
//
// The renderer refuses a delegated command with no window (`frameworks/wails/renderer_commands.go`
// `forward`), and nothing stamped one — so every plugin-owned session reported orphaned forever and
// every close on one reported that a running plugin is not running.
//
// The window comes from the index, which records where each session was last shown (S1-2). A
// session released by a detach has none, and one whose window closed names a window that is gone;
// both are answered by the windows that are open, because the plugin serving that name is the same
// component in every one of them.
func TestAPluginOwnerIsAskedInAWindow(t *testing.T) {
	var asked []string
	ask := AskEitherIn(
		func(string) []string { return []string{"main"} },
		func(string) bool { return false },
		func(string, controlwire.Request) (controlwire.Response, error) {
			t.Fatal("a unit was asked about a plugin owner")
			return controlwire.Response{}, nil
		},
		func(_ string, request controlwire.Request) (controlwire.Response, error) {
			var window string
			if raw, present := request.Args["window"]; present {
				_ = json.Unmarshal(raw, &window)
			}
			asked = append(asked, window)
			return answered(request), nil
		},
	).In("")
	if _, err := ask("a-plugin", nil); err != nil {
		t.Fatal(err)
	}
	if len(asked) != 1 || asked[0] == "" {
		t.Fatalf("the plugin was asked in window %q", asked)
	}
}

// The window a session was last shown in is the one asked first, because that is where its view is.
func TestTheRecordedWindowIsAskedFirst(t *testing.T) {
	var asked []string
	ask := AskEitherIn(
		func(string) []string { return []string{"main", "w-two"} },
		func(string) bool { return false },
		func(string, controlwire.Request) (controlwire.Response, error) {
			return controlwire.Response{}, nil
		},
		func(_ string, request controlwire.Request) (controlwire.Response, error) {
			var window string
			if raw, present := request.Args["window"]; present {
				_ = json.Unmarshal(raw, &window)
			}
			asked = append(asked, window)
			return answered(request), nil
		},
	)
	if _, err := ask.In("w-two")("a-plugin", nil); err != nil {
		t.Fatal(err)
	}
	if len(asked) != 1 || asked[0] != "w-two" {
		t.Fatalf("the recorded window was not asked first: %v", asked)
	}
}

// A window that no longer answers is not the end of it: the plugin serving that name is the same
// component in every open window, so the next one is asked.
func TestAWindowThatIsGoneFallsToAnotherThatIsOpen(t *testing.T) {
	var asked []string
	ask := AskEitherIn(
		func(string) []string { return []string{"main"} },
		func(string) bool { return false },
		func(string, controlwire.Request) (controlwire.Response, error) {
			return controlwire.Response{}, nil
		},
		func(_ string, request controlwire.Request) (controlwire.Response, error) {
			var window string
			if raw, present := request.Args["window"]; present {
				_ = json.Unmarshal(raw, &window)
			}
			asked = append(asked, window)
			if window == "w-gone" {
				return controlwire.Response{}, errUnreachable{}
			}
			return answered(request), nil
		},
	)
	report, err := ask.In("w-gone")("a-plugin", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Complete {
		t.Fatalf("the fallback answered %+v", report)
	}
	if len(asked) != 2 || asked[0] != "w-gone" || asked[1] != "main" {
		t.Fatalf("the windows asked were %v", asked)
	}
}
