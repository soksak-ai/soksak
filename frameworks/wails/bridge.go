package wails

import "github.com/wailsapp/wails/v3/pkg/application"

// Bridge is what the core needs from a host that does not exist yet.
//
// The command registry is filled before the framework starts, because a command
// registered in two places is two commands with one name. But two of the things
// commands need — telling the other windows something changed, and knowing
// which windows are live — have no answer until there is an application. So the
// launcher builds this empty, hands it to the core as plain functions, and Run
// fills it in.
//
// Before Run fills it in the answers are honest rather than absent: nothing has
// been emitted because nobody is listening, and no window is live because none
// exists. Neither is an error, and neither is a value a caller could mistake for
// a working host.
type Bridge struct {
	app  *application.App
	host WindowHost
}

// Emit delivers an event to every window. Framework-agnostic in signature, so
// the core names an event and a payload and never this package.
func (bridge *Bridge) Emit(event string, payload any) {
	if bridge == nil || bridge.app == nil {
		return
	}
	bridge.app.Event.Emit(event, payload)
}

// Live answers the windows that currently exist.
//
// The workspace claim ledger reads this to tell a claim held by a live window
// from one left by a window that is gone. Answering "unknown" as "live" would
// keep a closed window's workspace locked forever; answering it as "gone" hands
// the workspace to the next caller.
func (bridge *Bridge) Live() []string {
	if bridge == nil || bridge.host == nil {
		return nil
	}
	return bridge.host.Names()
}
