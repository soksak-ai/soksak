package wails

import "unsafe"

// Window facts and window effects, behind a contract.
//
// The rules in this group must be answerable with no window at all — the same
// verdict in a window, in a test, and in a headless process. A function that
// takes the vendor's application handle can never leave the application
// process, so every fact these commands need arrives through WindowHost and no
// vendor type crosses into the rules or the handlers.
//
// The contract holds facts and effects, never choices. Which window to act on
// is the caller's to name; nothing here reads what is current. That is not
// style: this host's Window.Current() answers with whatever holds focus, which
// is wrong precisely when a background repaint or a focus-free capture is the
// thing asking.

// Frame is a window rectangle in device-independent points, absolute, with a
// top-left origin.
//
// One space, shared by every command in this group: window_monitors reports it,
// window_place accepts it, window_create's rect is in it. Two spaces would flip
// the monitor verdict on a display whose scale differs from its neighbour's.
// Whole points because that is what this host reads and writes — a fractional
// frame cannot be applied and would silently round somewhere unnamed.
type Frame struct {
	X int `json:"x"`
	Y int `json:"y"`
	W int `json:"w"`
	H int `json:"h"`
}

// Display is one screen, in the same space as Frame, plus the scale a caller
// needs to convert to device pixels.
type Display struct {
	Index int     `json:"index"`
	Name  string  `json:"name"`
	X     int     `json:"x"`
	Y     int     `json:"y"`
	W     int     `json:"w"`
	H     int     `json:"h"`
	Scale float64 `json:"scale"`
}

// OpenSpec is everything a new window needs before it exists. It always opens
// hidden: a window revealed before its final position is applied shows at the
// OS default spot and then jumps.
type OpenSpec struct {
	Name string
	URL  string
}

// WindowHost is the source of window facts and the performer of window effects.
//
// It is named for windows rather than for the process because host.go already
// owns the word "host" for the application host this package runs inside.
type WindowHost interface {
	// Started reports that the run loop owns the main thread. Every command in
	// this group refuses before that: a window queued ahead of the run loop is
	// visible in the registry and reachable by nothing, and dispatching to the
	// main thread before it exists takes the process down rather than
	// answering.
	Started() bool
	// Names is every window name this process holds, addressable or not. It is
	// what makes two windows under one name impossible, so it must include a
	// name whose window no longer answers.
	Names() []string
	// Live reports that this name is an address right now — a command sent to
	// it will reach a native window.
	Live(name string) bool
	// Focused reports that this window is the one receiving keys.
	Focused(name string) bool
	// Frame reports where the window is. The second result is false when the
	// window has no native lifetime, because a window with no frame and a
	// window at the origin are different facts.
	Frame(name string) (Frame, bool)
	// Displays is the screen catalogue in catalogue order.
	Displays() []Display
	// Presence is whether this window is putting light on the screen right now.
	//
	// A frame is where a window would be, not whether a person can
	// see it: a window behind another application, minimised, or never ordered in
	// answers the same rectangle as one in front. Measured 2026-08-16, two windows
	// answered a frame on the display and a healthy surface inventory each, and
	// nothing in either answer named the one being looked at.
	Presence(name string) WindowPresence
	// NativeHandle is this window's platform handle, or nil when it has none.
	//
	// Capture needs it, and capture that can only reach one window is capture
	// that cannot show what anyone is asking about: measured 2026-08-15, the
	// theme was wrong in a workspace window and every snapshot answered with the
	// orchestrator.
	NativeHandle(name string) unsafe.Pointer
	// ContentSize is the area a document occupies, in device-independent points,
	// with the window's own chrome subtracted.
	//
	// Separate from Frame because they are different rectangles. Measured
	// 2026-08-15: the frame answered 999x617 while the document was 1000x618,
	// and comparing the two reported a defect that was only two measurements
	// disagreeing about what they had measured.
	ContentSize(name string) (width float64, height float64, err error)
	// FitWebview makes the document's view exactly as large as the area it can
	// be seen in. Called once, after a window exists.
	FitWebview(name string) error
	// WebviewRect is where the document's view is inside the window, in
	// device-independent points.
	//
	// Between the window and the document there is a view hierarchy this
	// application did not build. When those two disagree about a size, this is
	// what identifies which of them to correct.
	WebviewRect(name string) (x, y, width, height float64, err error)
	// SetBackground paints the window's own colour.
	//
	// The document paints transparent, so every unpainted region shows this.
	// It takes a name because each window has its own theme: one window
	// captured at registration meant a workspace window's theme repainted the
	// orchestrator and left itself the framework's default (measured
	// 2026-08-15 — a dark theme with white panes).
	SetBackground(name string, colour string) error
	// Title reports what the window is called on screen.
	//
	// The renderer writes its boot progress into document.title, and that is
	// the one channel that keeps answering when the binding path is dead — so a
	// window that answers nothing else still reports how far it got. The framework
	// only ever sets titles; without this, the stamp is written and nobody can
	// read it, which is not an observation.
	Title(name string) (string, error)
	// Open creates the window hidden and returns once it either has a native
	// lifetime or never will.
	Open(spec OpenSpec) error
	// Reveal shows the window. key=false must order it to the front without
	// taking the keyboard, because a background restore that steals focus is
	// the exact thing focus:false exists to prevent.
	Reveal(name string, key bool) error
	// Discard removes a window that never became an address, so a failed
	// creation leaves no name behind for the next one to collide with.
	Discard(name string) error
	Place(name string, frame Frame) error
	Focus(name string) error
	Reload(name string) error
	// OpenInspector opens the window's own developer tools.
	//
	// Every rule about a rectangle here is checked against a number, and on 2026-08-17 every number
	// agreed while the screen did not — the surface's declared rect equalled its element to the
	// tenth of a point and the compositor's drift was zero, and a page still sat off its pane. When
	// the readings agree and the screen does not, the next question is about the document, and
	// nothing in this build could open it.
	OpenInspector(name string) error
	Close(name string) error
	// ActivateApplication brings this application forward. It takes no window:
	// activation is the application's business, and requiring a window here is
	// what made the same request fail when a workspace renderer asked for it.
	ActivateApplication() error
}
