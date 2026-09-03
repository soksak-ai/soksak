package session

import (
	"encoding/json"

	controlwire "github.com/soksak-ai/soksak-contract-control"
	"github.com/soksak-ai/soksak-core/core/control"
)

// Names is every command this group owns, served or not.
//
// A build with no store or no route to an owner registers none of them, and the difference between
// "this build has no route to an owner" and "this build forgot a command" is only visible if the
// names are still declared.
func Names() []string {
	return []string{"session_list", "session_close"}
}

// Registration is what this group needs to serve.
type Registration struct {
	// Reader is where the index is read from.
	Reader Reader
	// Ask puts the session question to one owner. The name the index holds is the whole of what the
	// core has for an owner.
	Ask Ask
	// Order puts the close to one owner. Closing removes the owner's record, so the owner performs
	// it and the core orders it.
	Order Order
}

// Register puts this group on the registry.
//
// A missing dependency refuses by name rather than being absent: a caller that receives "unknown
// command" cannot tell a capability this build does not have from a name it typed wrong.
func Register(registry *control.Registry, deps Registration) {
	if deps.Reader == nil || deps.Ask == nil || deps.Order == nil {
		reason := "this build was given no place to read the session index, or no route to " +
			"the components that own sessions"
		for _, name := range Names() {
			if err := registry.DeclareUnserved(name, reason); err != nil {
				panic(err)
			}
		}
		return
	}

	registry.MustRegister(control.Command{
		Name:  "session_list",
		Owner: control.OwnerCore,
		Handler: func(control.Args) (any, error) {
			index, err := ReadIndex(deps.Reader)
			if err != nil {
				return nil, err
			}
			listed, err := List(index, deps.Ask)
			if err != nil {
				return nil, err
			}
			// Every session in every state, orphaned included. A caller filters; this hides
			// nothing, because a session it did not report is one nobody goes looking for.
			return map[string]any{"sessions": listed, "lost": countLost(listed)}, nil
		},
	})

	registry.MustRegister(control.Command{
		Name:  "session_close",
		Owner: control.OwnerCore,
		Handler: func(args control.Args) (any, error) {
			named, err := control.Arg[string](args, "session")
			if err != nil {
				return nil, err
			}
			index, err := ReadIndex(deps.Reader)
			if err != nil {
				return nil, err
			}
			return Close(index, named, deps.Order)
		},
	})
}

// countLost is the measured value the gate asserts is zero. A session an owner read its store for
// and found no record of is a defect, not an accepted outcome.
func countLost(listed []Listed) int {
	count := 0
	for _, one := range listed {
		if one.State == StateLost {
			count++
		}
	}
	return count
}

// Send takes one unit a request and answers with what came back.
type Send func(name string, request controlwire.Request) (controlwire.Response, error)

// AskThrough builds the owner question from a send.
//
// The core sends the one command every session owner answers. It does not read an owner's manifest
// to find a name for the question, because a name per owner is one the core would have to hold
// before it could ask.
func AskThrough(send Send) Ask {
	return func(owner string, sessions []string) (controlwire.SessionReport, error) {
		var report controlwire.SessionReport
		err := callOwner(send, owner, controlwire.SessionsCommand,
			controlwire.SessionsRequest{Sessions: sessions}, &report)
		return report, err
	}
}

// callOwner takes one command to one owner and reads its answer out of the envelope.
func callOwner(send Send, owner, command string, request any, into any) error {
	payload, err := json.Marshal(request)
	if err != nil {
		return err
	}
	answer, err := send(owner, controlwire.Request{
		Command: command,
		Args:    map[string]json.RawMessage{"request": payload},
	})
	if err != nil {
		return err
	}
	if !answer.Ok {
		return errRefused{owner: owner, reason: answer.Error}
	}
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	body, err := json.Marshal(answer.Result)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return err
	}
	return json.Unmarshal(envelope.Data, into)
}

type errRefused struct{ owner, reason string }

func (err errRefused) Error() string {
	return "the component " + err.owner + " refused the session question: " + err.reason
}
