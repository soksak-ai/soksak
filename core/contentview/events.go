// Package contentview is the core's side of a content view — the entity a pane
// shows and a plugin fills.
//
// The word "browser" is not here. A content view is what the core owns; browser
// is a plugin's word for one kind of them (C1).
//
// The event names are the public contract's because more than one thing speaks
// them: this application emits them, a host service that drives
// a native view produces them, and the document consumes them. A service left to
// import this package would make a unit depend on the application it plugs into,
// and one that copied the names instead would diverge from them without failing.
//
// They are aliases, so a value crossing this boundary is the same value and no
// call site in this repository changed spelling.
package contentview

import contentviewwire "github.com/soksak-ai/soksak-contract-contentview"

const (
	Navigated       = contentviewwire.Navigated
	Title           = contentviewwire.Title
	Loading         = contentviewwire.Loading
	Status          = contentviewwire.Status
	OpenExternal    = contentviewwire.OpenExternal
	Activated       = contentviewwire.Activated
	OpenExternalRaw = contentviewwire.OpenExternalRaw
)
