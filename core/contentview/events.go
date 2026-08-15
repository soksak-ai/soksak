// Package contentview is the core's side of a content view — the entity a pane
// shows and a plugin fills.
//
// The word "browser" is not here. A content view is what the core owns; browser
// is a plugin's word for one kind of them (C1).
package contentview

// Event names on the wire.
//
// These are the canonical values. The page has a copy in
// frontend/src/lib/contentViewEvents.ts because TypeScript cannot read a Go
// constant, and a gate compares the two: if they drift, the events a host emits
// arrive nowhere, and an event that arrives nowhere raises no error. The
// symptom is a back button that is permanently disabled, not a failure
// (measured 2026-08-01 in the preceding implementation).
const (
	// Navigated — the view moved to an address. inPage separates a move inside
	// the same document from a new one: without it a consumer resets the title
	// to the url on every move, and a repeat navigation to the same document
	// emits no title, so the real title is overwritten.
	Navigated = "content-view-navigated"
	// Title — the document named itself.
	Title = "content-view-title"
	// Loading — a load started or stopped. canBack and canForward travel with
	// it because all three are facts of the same moment; read afterwards they
	// answer about a later one, and the button is enabled a frame early or
	// disabled a frame late.
	Loading = "content-view-loading"
	// Status — the address under the pointer, empty when it leaves a link.
	Status = "content-view-status"
	// OpenExternal — the view asked for a window this one will not open.
	OpenExternal = "content-view-open-external"
	// Activated — the person clicked this view.
	Activated = "content-view-activated"
	// OpenExternalRaw — the same request named by a framework handle rather
	// than a label. The seam converts it and re-emits under OpenExternal.
	OpenExternalRaw = "content-view-open-external:raw"
)
