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
	return []string{
		"session_list", "session_attach", "session_detach", "session_close",
		"session_notices",
	}
}

// Registration is what this group needs to serve.
type Registration struct {
	// Store is where the index is read from and written to. The core owns the index, so it is the
	// core's store rather than an owner's.
	Store Writer
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
	if deps.Store == nil || deps.Ask == nil || deps.Order == nil {
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
			index, err := ReadIndex(deps.Store)
			if err != nil {
				return nil, err
			}
			listed, err := List(index, deps.Ask)
			if err != nil {
				return nil, err
			}
			// Every session in every state, orphaned included. A caller filters; this hides
			// nothing, because a session it did not report is one nobody goes looking for.
			return map[string]any{"sessions": listed, "lost": LostReport(listed)}, nil
		},
	})

	registry.MustRegister(control.Command{
		Name:  "session_notices",
		Owner: control.OwnerCore,
		Handler: func(control.Args) (any, error) {
			index, err := ReadIndex(deps.Store)
			if err != nil {
				return nil, err
			}
			listed, err := List(index, deps.Ask)
			if err != nil {
				return nil, err
			}
			// The core delivers the news and does not act on it. What an attachment does with a
			// degraded restore is that component's; reading it is what this answers.
			return map[string]any{"notices": Notices(listed)}, nil
		},
	})

	registry.MustRegister(control.Command{
		Name:  "session_attach",
		Owner: control.OwnerCore,
		Handler: func(args control.Args) (any, error) {
			attachment := Attachment{}
			for target, name := range map[*string]string{
				&attachment.Session: "session", &attachment.Owner: "owner", &attachment.ViewID: "view",
			} {
				value, err := control.Arg[string](args, name)
				if err != nil {
					return nil, err
				}
				*target = value
			}
			// The window label is where the session was last shown, and a caller that omits it
			// leaves that unknown rather than wrong.
			if raw, present := args["window"]; present {
				if err := json.Unmarshal(raw, &attachment.WindowLabel); err != nil {
					return nil, err
				}
			}
			if err := Attach(deps.Store, attachment); err != nil {
				return nil, err
			}
			return attachment, nil
		},
	})

	registry.MustRegister(control.Command{
		Name:  "session_detach",
		Owner: control.OwnerCore,
		Handler: func(args control.Args) (any, error) {
			named, err := control.Arg[string](args, "session")
			if err != nil {
				return nil, err
			}
			// Detaching releases the session and ends nothing. Closing a window, a workspace or a
			// pane releases what it held the same way.
			if err := Detach(deps.Store, named); err != nil {
				return nil, err
			}
			return map[string]any{"session": named, "detached": true}, nil
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
			index, err := ReadIndex(deps.Store)
			if err != nil {
				return nil, err
			}
			return CloseAndForget(deps.Store, index, named, deps.Order)
		},
	})
}

// Lost is the measured value a gate asserts is zero, with what was lost named beside it.
//
// A number alone leaves nobody anywhere to look. A session an owner read its store for and found no
// record of is a defect, and the owner and the coordinate it was last shown at are where the search
// for the cause starts.
type Lost struct {
	Count    int      `json:"count"`
	Sessions []Listed `json:"sessions"`
}

// LostReport counts the lost sessions in a listing and names them.
//
// Only a lost session counts. An orphaned one is waiting for its owner, and counting it would fire
// the gate every time an owner is not running.
func LostReport(listed []Listed) Lost {
	report := Lost{Sessions: []Listed{}}
	for _, one := range listed {
		if one.State == StateLost {
			report.Sessions = append(report.Sessions, one)
		}
	}
	report.Count = len(report.Sessions)
	return report
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

// AskEither sends the session question to whichever place the owner runs in.
//
// An owner is a component that holds sessions, and where it runs is not the question. Some run in a
// process of their own and some run in the renderer; the core sends the same command either way,
// because a caller cannot tell where a command runs and that is the point of one registry.
//
// `running` answers whether a name is a unit this host has open. A name that is not takes the other
// route rather than being refused: a plugin is not a unit and holds sessions all the same.
func AskEither(running func(name string) bool, toUnit, toRenderer Send) Ask {
	return func(owner string, sessions []string) (controlwire.SessionReport, error) {
		send := toRenderer
		if running(owner) {
			send = toUnit
		}
		var report controlwire.SessionReport
		err := callOwner(send, owner, controlwire.SessionsCommand,
			controlwire.SessionsRequest{Sessions: sessions}, &report)
		return report, err
	}
}

// OrderEither sends the close to whichever place the owner runs in, for the same reason.
func OrderEither(running func(name string) bool, toUnit, toRenderer Send) Order {
	return func(owner string, request controlwire.SessionCloseRequest) (controlwire.SessionCloseResult, error) {
		send := toRenderer
		if running(owner) {
			send = toUnit
		}
		var result controlwire.SessionCloseResult
		err := callOwner(send, owner, controlwire.SessionCloseCommand, request, &result)
		return result, err
	}
}

// PluginCommandName is how a plugin's command is named on the registry.
//
// A plugin serves under `plugin.<id>.<command>` and the core has to send that name. One built a
// different way addresses nothing, and the owner reports orphaned forever with no error to say why.
// The shape is the host's, so it is written down once here rather than assembled at each caller.
func PluginCommandName(owner, command string) string {
	return "plugin." + owner + "." + command
}
