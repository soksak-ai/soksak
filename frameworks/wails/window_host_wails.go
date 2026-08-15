package wails

import (
	"sync/atomic"
	"unsafe"

	"github.com/soksak/soksak-core/core/i18n"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// The one WindowHost implementation. Every vendor type in this group stops
// here: above it there are only names, frames, and booleans.
//
// Two things about this framework shape everything below. Its window mutators
// return silently when the window has no native lifetime — close, focus,
// reload, bounds and key state all begin by checking for one and give back
// nothing, an empty rect, or false. And its window lookup walks a map and takes
// the first name that matches, so two windows under one name are resolved by
// map order. Both are answered the same way: a name is checked for an address
// before anything is asked of it, and a name is never issued twice.
type wailsHost struct {
	app *application.App
	// template is the one window definition this application has. A workspace
	// window is built from a copy of it with the name and URL replaced, rather
	// than from a second literal here: copying only some of the fields would
	// give a new window a different title bar, backdrop and background from the
	// orchestrator's, and that difference is not an error — it is "the new
	// window looks wrong".
	template application.WebviewWindowOptions
	// started is the run loop owning the main thread. It arrives as an event
	// rather than a poll, and it is never read from the platform: dispatching
	// to a main thread that does not exist yet takes the process down instead
	// of answering, so this fact has to be certain before any command runs.
	started atomic.Bool
}

// NewWindowHost binds the window commands to this application.
//
// It must be called before the application runs, because the started fact is an
// event this installs a listener for. Between the run loop actually starting
// and that listener being called the commands refuse — brief, at boot only, and
// in the safe direction: a refusal names itself, while a dispatch to a missing
// main thread does not come back at all.
func NewWindowHost(app *application.App, template application.WebviewWindowOptions) WindowHost {
	if app == nil {
		panic("wails: the window host needs an application")
	}
	host := &wailsHost{app: app, template: template}
	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		host.started.Store(true)
	})
	return host
}

func (h *wailsHost) Started() bool { return h.started.Load() }

func (h *wailsHost) Names() []string {
	windows := h.app.Window.GetAll()
	names := make([]string, 0, len(windows))
	for _, window := range windows {
		names = append(names, window.Name())
	}
	return names
}

// live returns the window only when it is an address. NativeWindow is the one
// public witness of that state: it is nil for exactly the window every mutator
// silently ignores.
func (h *wailsHost) live(name string) (application.Window, bool) {
	window, held := h.app.Window.GetByName(name)
	if !held || window.NativeWindow() == nil {
		return nil, false
	}
	return window, true
}

func (h *wailsHost) Live(name string) bool {
	_, addressable := h.live(name)
	return addressable
}

func (h *wailsHost) Focused(name string) bool {
	window, addressable := h.live(name)
	return addressable && window.IsFocused()
}

func (h *wailsHost) Frame(name string) (Frame, bool) {
	window, addressable := h.live(name)
	if !addressable {
		// The framework answers an empty rect here, which is a window at the
		// origin with no size — a place, and a wrong one.
		return Frame{}, false
	}
	bounds := window.Bounds()
	return Frame{X: bounds.X, Y: bounds.Y, W: bounds.Width, H: bounds.Height}, true
}

// NativeHandle answers this window's platform handle.
//
// nil for a window with no native lifetime, which is the same witness `live`
// uses — a window that is not an address has no pixels either.
func (h *wailsHost) NativeHandle(name string) unsafe.Pointer {
	window, addressable := h.live(name)
	if !addressable {
		return nil
	}
	return window.NativeWindow()
}

// ContentSize reads the window's content rect off the native window. The main
// thread owns AppKit, so the read is dispatched there.
func (h *wailsHost) ContentSize(name string) (float64, float64, error) {
	window, addressable := h.live(name)
	if !addressable {
		return 0, 0, i18n.Errorf("wails.host.noContentArea", map[string]string{"window": name})
	}
	var width, height float64
	var failure error
	native := window.NativeWindow()
	application.InvokeSync(func() { width, height, failure = contentSize(native) })
	return width, height, failure
}

// FitWebview corrects the view hierarchy the framework built. The main thread
// owns AppKit, so the change is dispatched there.
func (h *wailsHost) FitWebview(name string) error {
	window, addressable := h.live(name)
	if !addressable {
		return i18n.Errorf("wails.host.noViewToFit", map[string]string{"window": name})
	}
	var failure error
	native := window.NativeWindow()
	application.InvokeSync(func() { failure = fitWebviewToWindow(native) })
	return failure
}

// WebviewRect reads the document view's frame off the native hierarchy. The
// main thread owns AppKit, so the read is dispatched there.
func (h *wailsHost) WebviewRect(name string) (x, y, width, height float64, err error) {
	window, addressable := h.live(name)
	if !addressable {
		return 0, 0, 0, 0, i18n.Errorf("wails.host.noView", map[string]string{"window": name})
	}
	native := window.NativeWindow()
	application.InvokeSync(func() { x, y, width, height, err = webviewFrame(native) })
	return x, y, width, height, err
}

// SetBackground paints one window. The main thread owns AppKit, so the change
// is dispatched there.
func (h *wailsHost) SetBackground(name string, colour string) error {
	window, addressable := h.live(name)
	if !addressable {
		return i18n.Errorf("wails.host.cannotColour", map[string]string{"window": name})
	}
	application.InvokeSync(func() { window.SetBackgroundColour(parseColour(colour)) })
	return nil
}

// Title reads the window's on-screen name off the native window.
//
// The main thread owns AppKit, so the read is dispatched there and waited for.
// Reading from this goroutine would be a data race against the renderer that
// writes the stamp — and a raced title is worse than none, because it looks
// like an answer.
func (h *wailsHost) Title(name string) (string, error) {
	window, addressable := h.live(name)
	if !addressable {
		return "", i18n.Errorf("wails.host.noTitle", map[string]string{"window": name})
	}

	var title string
	var failure error
	native := window.NativeWindow()
	application.InvokeSync(func() { title, failure = nativeWindowTitle(native) })
	return title, failure
}

func (h *wailsHost) Displays() []Display {
	screens := h.app.Screen.GetAll()
	displays := make([]Display, 0, len(screens))
	for index, screen := range screens {
		if screen == nil {
			continue
		}
		// Bounds rather than PhysicalBounds: this framework reads a window
		// frame in points and its physical conversion for windows is the
		// identity, so a physical screen rect next to a point window rect would
		// put the two in different spaces on any display that scales.
		displays = append(displays, Display{
			Index: index,
			Name:  screen.Name,
			X:     screen.Bounds.X,
			Y:     screen.Bounds.Y,
			W:     screen.Bounds.Width,
			H:     screen.Bounds.Height,
			Scale: float64(screen.ScaleFactor),
		})
	}
	return displays
}

func (h *wailsHost) Open(spec OpenSpec) error {
	options := h.template
	options.Name = spec.Name
	options.URL = spec.URL
	// Hidden until the frame is final. A window revealed first appears wherever
	// the OS put it and then moves, which reads as a flicker rather than as a
	// misplaced window.
	options.Hidden = true

	// This returns once the main thread has acknowledged the window's creation,
	// so by the time it comes back the native window either exists or never
	// will. The caller reads that once; there is nothing to poll for.
	window := h.app.Window.NewWithOptions(options)
	if window == nil {
		return i18n.Errorf("wails.host.noWindowReturned", map[string]string{"window": spec.Name})
	}
	// The framework builds its content view a point smaller than the window and
	// lets autoresizing carry that offset, so the document ends up a point
	// larger than the area it can be seen in. Corrected the moment the window
	// exists; autoresizing keeps the fit afterwards.
	_ = h.FitWebview(spec.Name)

	// A transparent backdrop clears the window's colour on the way in, so the
	// template's colour is restored the moment the window exists. Without this
	// the desktop shows through until the renderer's theme arrives, which is
	// several hundred milliseconds of somebody else's wallpaper.
	window.SetBackgroundColour(options.BackgroundColour)
	return nil
}

func (h *wailsHost) Reveal(name string, key bool) error {
	window, addressable := h.live(name)
	if !addressable {
		return i18n.Errorf("wails.host.cannotReveal", map[string]string{"window": name})
	}
	if key {
		window.Show()
		return nil
	}
	// This framework's Show is makeKeyAndOrderFront, so revealing a restored
	// window through it would take the keyboard away from whatever the user is
	// using — the exact thing a background restore exists to avoid. Ordinary
	// front ordering is not enough either: an occluded window can have its
	// display callbacks suspended and then never proves it painted.
	//
	// The dispatch to the main thread is here rather than in the native layer,
	// which keeps that layer to one call and nothing else.
	native := window.NativeWindow()
	var failure error
	application.InvokeSync(func() { failure = orderWindowFrontWithoutKey(native) })
	return failure
}

func (h *wailsHost) Discard(name string) error {
	window, held := h.app.Window.GetByName(name)
	if !held {
		return i18n.Errorf("wails.host.cannotWithdraw", map[string]string{"window": name})
	}
	// A window that did reach a native lifetime and failed afterwards is torn
	// down first; one that never did is silently ignored here, which is what
	// makes calling this unconditionally safe.
	window.Close()
	// The name is freed now rather than when the closing event is handled: this
	// command has already reported the failure, and a caller that retries
	// immediately would otherwise be handed back the window just withdrawn.
	h.app.Window.Remove(window.ID())
	return nil
}

func (h *wailsHost) Place(name string, frame Frame) error {
	window, addressable := h.live(name)
	if !addressable {
		return i18n.Errorf("wails.host.cannotPlace", map[string]string{"window": name})
	}
	window.SetBounds(application.Rect{X: frame.X, Y: frame.Y, Width: frame.W, Height: frame.H})
	return nil
}

func (h *wailsHost) Focus(name string) error {
	window, addressable := h.live(name)
	if !addressable {
		return i18n.Errorf("wails.host.cannotFocus", map[string]string{"window": name})
	}
	window.Focus()
	return nil
}

func (h *wailsHost) Reload(name string) error {
	window, addressable := h.live(name)
	if !addressable {
		return i18n.Errorf("wails.host.cannotReload", map[string]string{"window": name})
	}
	window.Reload()
	return nil
}

func (h *wailsHost) Close(name string) error {
	window, addressable := h.live(name)
	if !addressable {
		return i18n.Errorf("wails.host.cannotClose", map[string]string{"window": name})
	}
	window.Close()
	return nil
}

func (h *wailsHost) ActivateApplication() error {
	if !h.started.Load() {
		return i18n.Errorf("wails.host.runLoopNotStarted", nil)
	}
	var failure error
	application.InvokeSync(func() { failure = activateApplication() })
	return failure
}
