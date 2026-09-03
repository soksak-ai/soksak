package session

import (
	"encoding/json"

	controlwire "github.com/soksak-ai/soksak-contract-control"
)

// Windows answers which windows serve one command. A plugin answers in one of them, so a question
// with none named is refused before it arrives, and one naming a window that never declared the
// command is refused there.
//
// It takes the command's full name because that is what a window declares: an owner's name alone
// matches nothing, and every owner's is different.
type Windows func(command string) []string

// Router puts the session question and the close to an owner, in a named window when the owner is
// one that answers in a window.
type Router struct {
	windows    Windows
	running    func(name string) bool
	toUnit     Send
	toRenderer Send
}

// AskEitherIn builds a router with a reader of which windows serve a command.
//
// A unit answers over its own socket and a window means nothing to it. A plugin answers in a
// window, and the renderer refuses a delegated command that names none — so a question with no
// window left every plugin-owned session orphaned forever, and every close on one reported that a
// running plugin is not running.
func AskEitherIn(windows Windows, running func(name string) bool, toUnit, toRenderer Send) Router {
	return Router{windows: windows, running: running, toUnit: toUnit, toRenderer: toRenderer}
}

// In answers the question for one session, preferring the window it was last shown in.
//
// That window is where its view is, so it is tried first. It is also the window most likely to be
// gone — a session is detached exactly when its window closed — so a window that no longer answers
// falls to one that is open: the plugin serving that name is the same component in every window,
// and what it holds does not depend on which one asks.
func (router Router) In(window string) Ask {
	return func(owner string, sessions []string) (controlwire.SessionReport, error) {
		if router.running(owner) {
			var report controlwire.SessionReport
			err := callOwner(router.toUnit, owner, controlwire.SessionsCommand,
				controlwire.SessionsRequest{Sessions: sessions}, &report)
			return report, err
		}
		var last error
		for _, named := range router.order(window, PluginCommandName(owner, controlwire.SessionsCommand)) {
			var report controlwire.SessionReport
			err := callWindow(router.toRenderer, owner, named, controlwire.SessionsCommand,
				controlwire.SessionsRequest{Sessions: sessions}, &report)
			if err == nil {
				return report, nil
			}
			last = err
		}
		return controlwire.SessionReport{}, last
	}
}

// CloseIn orders the close for one session, in the same order In uses.
func (router Router) CloseIn(window string) Order {
	return func(owner string, request controlwire.SessionCloseRequest) (controlwire.SessionCloseResult, error) {
		if router.running(owner) {
			var result controlwire.SessionCloseResult
			err := callOwner(router.toUnit, owner, controlwire.SessionCloseCommand, request, &result)
			return result, err
		}
		var last error
		for _, named := range router.order(window, PluginCommandName(owner, controlwire.SessionCloseCommand)) {
			var result controlwire.SessionCloseResult
			err := callWindow(router.toRenderer, owner, named, controlwire.SessionCloseCommand,
				request, &result)
			if err == nil {
				return result, nil
			}
			last = err
		}
		return controlwire.SessionCloseResult{}, last
	}
}

// order is the window the session was last shown in, then every other one that serves the command.
func (router Router) order(window, command string) []string {
	open := router.windows(command)
	ordered := make([]string, 0, len(open)+1)
	if window != "" {
		ordered = append(ordered, window)
	}
	for _, named := range open {
		if named != window {
			ordered = append(ordered, named)
		}
	}
	if len(ordered) == 0 {
		// Nothing is open and nothing was recorded. The call goes out unnamed so the refusal comes
		// from the renderer rather than from a silent empty answer here.
		ordered = append(ordered, "")
	}
	return ordered
}

// callWindow puts one command to a plugin owner in one window.
func callWindow(send Send, owner, window, command string, request any, into any) error {
	payload, err := json.Marshal(request)
	if err != nil {
		return err
	}
	args := map[string]json.RawMessage{"request": payload}
	if window != "" {
		named, err := json.Marshal(window)
		if err != nil {
			return err
		}
		args["window"] = named
	}
	answer, err := send(owner, controlwire.Request{Command: command, Args: args})
	if err != nil {
		return err
	}
	if !answer.Ok {
		return refused(owner, answer.Error)
	}
	return unwrap(answer, into)
}
