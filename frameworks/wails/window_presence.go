package wails

// WindowPresence is whether a window is putting light on the screen right now.
//
// A frame, a content size and a surface inventory all describe a window that may be behind another
// application, minimised, or never ordered in. Every one of them reads correct while nobody can see
// the window, so "where it is" and "whether it is there" are two questions and this is the second.
//
// Measured 2026-08-16: two windows both answered a frame inside the display and a healthy surface
// inventory, and nothing in any answer said which of them a person was looking at. The gap was
// closed by asking a person, which is not an observation surface.
type WindowPresence struct {
	// Known is false where the platform cannot answer. Distinct from a window
	// that is not visible: one is no measurement and the other is a measurement.
	Known bool `json:"known"`
	// Visible is the window being ordered in at all.
	Visible bool `json:"visible"`
	// Key is the window receiving keys; Main is the window the application
	// treats as its principal one. They differ for a panel or a sheet.
	Key  bool `json:"key"`
	Main bool `json:"main"`
	// Miniaturized is the window being in the dock.
	Miniaturized bool `json:"miniaturized"`
	// Occluded is the window being on screen with something over it. False for
	// a window that is not visible at all — an unopened window and a covered one
	// are different facts and must not share an answer.
	Occluded bool `json:"occluded"`
	// Alpha is the window's own opacity. A window at 0 is ordered in, on screen,
	// unoccluded, and invisible.
	Alpha float64 `json:"alpha"`
}
