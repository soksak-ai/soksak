package session

import (
	"encoding/json"

	controlwire "github.com/soksak-ai/soksak-contract-control"
	"github.com/soksak-ai/soksak-core/core/control"
	"github.com/soksak-ai/soksak-core/core/i18n"
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
	// Ask puts the session question to one owner and Order puts the close. Every owner runs outside
	// the window and answers over its own socket (S1-2), so neither takes a window.
	Ask   Ask
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
			// Named by session, or by the view holding them. A view is what the person closes and a
			// session is what the owner ends, and the index is what joins the two — so the caller
			// closing a view names it rather than looking the sessions up and closing each, which
			// would put the core's index in the caller.
			view, err := control.OptionalArg(args, "view", "")
			if err != nil {
				return nil, err
			}
			named, err := control.OptionalArg(args, "session", "")
			if err != nil {
				return nil, err
			}
			if (view == "") == (named == "") {
				return nil, i18n.Errorf("session.close.nameOne", nil)
			}
			index, err := ReadIndex(deps.Store)
			if err != nil {
				return nil, err
			}
			if view != "" {
				closed, err := CloseView(deps.Store, index, view, func(session string) Order {
					return deps.Order
				})
				if err != nil {
					return nil, err
				}
				return map[string]any{"view": view, "closed": closed}, nil
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
		return refused(owner, answer.Error)
	}
	return unwrap(answer, into)
}

// unwrap reads an owner's answer out of the envelope it travels in.
//
// An `ok` answer with no data is a refusal with no reason rather than a report: read as one it
// surfaces as a parse error, and a caller cannot tell that from an owner that answered nothing.
func unwrap(answer controlwire.Response, into any) error {
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
	if len(envelope.Data) == 0 {
		return i18n.Errorf("session.owner.noAnswer", nil)
	}
	return json.Unmarshal(envelope.Data, into)
}

// refused is what an owner answering with a refusal becomes. A caller reads it, so the sentence
// comes from a key rather than being assembled here.
func refused(owner, reason string) error {
	return i18n.Errorf("session.owner.refused", map[string]string{"owner": owner, "reason": reason})
}
