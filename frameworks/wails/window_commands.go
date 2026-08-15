package wails

import (
	"errors"
	"fmt"
	"sort"
	"strconv"

	"github.com/soksak/soksak-core/core/control"
)

// The window group: create, close, focus, activate, place, reload, list,
// census, key state, monitors.
//
// Framework-owned, all ten. A window cannot be created by a process that has
// none, so unlike the core commands there is no headless answer to any of them
// — the honest thing is to declare that at registration rather than let a
// caller find out by timing out.

// Deps is what the process supplies. Nothing here is read from the environment:
// the same code answers identically in a window, in a headless server, and in a
// test because the caller passes what it read.
type Deps struct {
	// Host answers window facts and performs window effects. An interface
	// rather than the vendor's application handle, because a function that
	// takes that handle can never leave the application process and these rules
	// must be testable with no window at all.
	Host WindowHost
	// NewID supplies the opaque, non-reusable half of a workspace name. The
	// "win-" prefix is this package's rule; the entropy belongs to the process.
	NewID func() string
}

// Register adds the window commands to the registry.
//
// It panics on a missing dependency, matching MustRegister: boot-time
// registration is a programming fact, and finding it out as a failed command
// means every window in the process is already unreachable.
func Register(registry *control.Registry, deps Deps) {
	if deps.Host == nil {
		panic("wails: the window commands need a WindowHost")
	}
	if deps.NewID == nil {
		panic("wails: the window commands need an identifier source")
	}

	command := func(name string, handler control.Handler) {
		registry.MustRegister(control.Command{
			Name:    name,
			Owner:   control.OwnerFramework,
			Handler: handler,
		})
	}

	command("window_create", func(args control.Args) (any, error) { return createWindow(deps, args) })

	command("window_close", func(args control.Args) (any, error) {
		name, err := targetWindow(deps.Host, args)
		if err != nil {
			return nil, err
		}
		// Closing does not wait for the name to leave the registry. This host
		// emits a closing event and a listener performs the destroy, so there
		// is no receipt to wait on; inventing one would report an arrival that
		// was never observed.
		return nil, deps.Host.Close(name)
	})

	command("window_focus", func(args control.Args) (any, error) {
		name, err := targetWindow(deps.Host, args)
		if err != nil {
			return nil, err
		}
		// Nothing is reported about the outcome. Raising a window can succeed
		// while the keyboard stays elsewhere, so the result is asked for
		// separately through window_is_key.
		return nil, deps.Host.Focus(name)
	})

	command("window_activate", func(args control.Args) (any, error) {
		if err := requireStarted(deps.Host); err != nil {
			return nil, err
		}
		// No window argument. Activation is the application's business, and
		// the caller may be a renderer inside a window rather than the window
		// itself — requiring one is what made this request fail from a
		// workspace, and with it went every keystroke that window's children
		// were waiting for.
		return nil, deps.Host.ActivateApplication()
	})

	command("window_place", func(args control.Args) (any, error) {
		name, err := targetWindow(deps.Host, args)
		if err != nil {
			return nil, err
		}
		x, err := control.Arg[float64](args, "x")
		if err != nil {
			return nil, err
		}
		y, err := control.Arg[float64](args, "y")
		if err != nil {
			return nil, err
		}
		width, err := control.Arg[float64](args, "w")
		if err != nil {
			return nil, err
		}
		height, err := control.Arg[float64](args, "h")
		if err != nil {
			return nil, err
		}
		frame, usable := frameOf(&x, &y, &width, &height)
		if !usable {
			return nil, fmt.Errorf("window %s: %v,%v %vx%v is not a frame a window can occupy", name, x, y, width, height)
		}
		// Position and size in one application, and no read-back. The OS may
		// clamp a frame into the usable area, and the caller re-reads
		// window_monitors for where it settled rather than being told here
		// that the request was obeyed exactly.
		return nil, deps.Host.Place(name, frame)
	})

	command("window_reload", func(args control.Args) (any, error) {
		name, err := targetWindow(deps.Host, args)
		if err != nil {
			return nil, err
		}
		// The reload happens here rather than in the renderer because a
		// renderer that reloads itself cannot record its own death: the
		// activity entry goes out fire-and-forget and the window dies mid
		// flight. Called from here, what dies is the renderer and the caller
		// survives it, so the entry lands.
		//
		// No second trace is added. This host's reload carries no
		// acknowledgement, so there is nothing to record arriving, and code
		// that pretends to leave a mark is worse than none.
		return nil, deps.Host.Reload(name)
	})

	command("window_is_key", func(args control.Args) (any, error) {
		name, err := targetWindow(deps.Host, args)
		if err != nil {
			return nil, err
		}
		return deps.Host.Focused(name), nil
	})

	command("window_list", func(control.Args) (any, error) {
		if err := requireStarted(deps.Host); err != nil {
			return nil, err
		}
		// Only addresses. Every caller uses this list to pick a command target,
		// so a name in it that no command can reach is the same defect the
		// creation rollback exists to prevent. Safe only because an unstarted
		// run loop already refuses by name — otherwise an empty list would mean
		// both "no windows" and "not started".
		names := heldNames(deps.Host)
		addressable := make([]string, 0, len(names))
		for _, name := range names {
			if deps.Host.Live(name) {
				addressable = append(addressable, name)
			}
		}
		return addressable, nil
	})

	command("window_census", func(control.Args) (any, error) {
		if err := requireStarted(deps.Host); err != nil {
			return nil, err
		}
		// Every held name, addressable or not: the question this answers is
		// "would opening this name collide with something", and a name held by
		// a window that answers nothing still collides. Failure is never
		// flattened into an empty list — an empty census reads as "nobody holds
		// anything", which sends a restore into recreating every window, and
		// that overlap is the thing this ledger exists to prevent.
		names := heldNames(deps.Host)
		rows := make([]censusRow, 0, len(names))
		for _, name := range names {
			row := censusRow{Label: name, Hosts: 1, Focused: deps.Host.Focused(name)}
			// A title this host cannot read leaves the field null rather than
			// failing the census: the count of windows is the answer here, and
			// losing it because one window could not be asked would hide the
			// very thing this command exists to report.
			if title, err := deps.Host.Title(name); err == nil {
				row.Title = &title
			}
			rows = append(rows, row)
		}
		return censusReply{Windows: foldCensus(rows)}, nil
	})

	command("window_monitors", func(control.Args) (any, error) {
		if err := requireStarted(deps.Host); err != nil {
			return nil, err
		}
		return monitorFacts(deps.Host)
	})
}

// censusReply is the occupancy ledger's envelope. The key is fixed here because
// the consumer looks for it by name.
type censusReply struct {
	Windows []censusRow `json:"windows"`
}

// windowFact is one window's placement. The keys match what the layout
// suggestion reads; a key this host cannot source is absent rather than
// invented, which is why always-on-top is not here — this framework exposes a
// setter for it and no getter. The title is readable and lives on the census,
// where the question "what is this window" is asked.
type windowFact struct {
	Label   string `json:"label"`
	X       int    `json:"x"`
	Y       int    `json:"y"`
	W       int    `json:"w"`
	H       int    `json:"h"`
	Focused bool   `json:"focused"`
	// ContentW and ContentH are the area a document occupies, with this
	// window's own chrome subtracted. Separate from W and H because they are a
	// different rectangle: measured 2026-08-15, the frame answered 999x617
	// while the document was 1000x618, and a caller comparing its own size
	// against W reported a discrepancy that was only the two disagreeing about
	// what they had measured.
	//
	// Null when this platform cannot answer, rather than repeating the frame
	// under another name.
	ContentW *float64 `json:"contentW"`
	ContentH *float64 `json:"contentH"`
	// Monitor is the index of the display holding this window's centre, or
	// null. Never zero for a window on no display: that zero cannot be told
	// apart from "it is on the first display".
	Monitor *int `json:"monitor"`
}

// monitorsReply is facts only. Which window belongs where is decided elsewhere;
// nothing here proposes a placement.
type monitorsReply struct {
	Monitors []Display    `json:"monitors"`
	Windows  []windowFact `json:"windows"`
	// Space names the coordinate system both this answer and window_place use.
	//
	// It is stated rather than assumed because this host reads a window frame
	// in points and reports it through an API that calls the result physical —
	// its own physical-bounds conversion on macOS is the identity with a note
	// that the scaling is unwritten. Numbers alone therefore cannot tell a
	// caller which space arrived. Device-independent points is what the host
	// actually reads and writes, and each monitor carries its scale so a caller
	// that needs device pixels can convert once, in the open.
	Space string `json:"space"`
}

const dipSpace = "dip"

func monitorFacts(host WindowHost) (any, error) {
	displays := host.Displays()
	if len(displays) == 0 {
		// A machine holding a window has a screen, so an empty catalogue means
		// the screens were never enumerated. Answering with an empty list would
		// make that indistinguishable from a machine with no displays.
		return nil, errors.New("the screen catalogue is empty; the displays have not been enumerated")
	}
	catalogue := make([]Display, len(displays))
	copy(catalogue, displays)
	for index := range catalogue {
		// The reported index and the position a monitor verdict points at are
		// the same number by construction. Letting the host stamp one and the
		// verdict count the other lets them disagree, and then a placement
		// lands on a screen nobody chose.
		catalogue[index].Index = index
	}

	names := heldNames(host)
	facts := make([]windowFact, 0, len(names))
	for _, name := range names {
		frame, positioned := host.Frame(name)
		if !positioned {
			// A window with no native lifetime has no frame. Reporting it at
			// the origin with no size would put a phantom on the first display.
			continue
		}
		fact := windowFact{
			Label:   name,
			X:       frame.X,
			Y:       frame.Y,
			W:       frame.W,
			H:       frame.H,
			Focused: host.Focused(name),
			Monitor: monitorOf(frame, catalogue),
		}
		// A platform that cannot answer leaves these null rather than repeating
		// the frame, which would be a different rectangle wearing this name.
		if width, height, err := host.ContentSize(name); err == nil {
			fact.ContentW, fact.ContentH = &width, &height
		}
		facts = append(facts, fact)
	}
	return monitorsReply{Monitors: catalogue, Windows: facts, Space: dipSpace}, nil
}

func createWindow(deps Deps, args control.Args) (any, error) {
	if err := requireStarted(deps.Host); err != nil {
		return nil, err
	}

	// Every optional argument decodes into a pointer so that absent stays
	// distinguishable from a zero: an empty label is a caller's mistake and a
	// missing one is a request to generate, and the two must not become the
	// same request.
	init, err := control.OptionalArg[*string](args, "init", nil)
	if err != nil {
		return nil, err
	}
	if init != nil {
		if err := checkInitQuery(*init); err != nil {
			return nil, err
		}
	}
	label, err := control.OptionalArg[*string](args, "label", nil)
	if err != nil {
		return nil, err
	}
	focus, err := control.OptionalArg[*bool](args, "focus", nil)
	if err != nil {
		return nil, err
	}
	rect, err := control.OptionalArg[*rectArgument](args, "rect", nil)
	if err != nil {
		return nil, err
	}

	var requested Frame
	positioned := false
	if rect != nil {
		requested, positioned = frameOf(rect.X, rect.Y, rect.W, rect.H)
		// frameOf says "not a frame" for a rect that was never asked for and
		// for one no window can occupy. Only the caller who sent a rect can be
		// told apart here, and they are told: falling through would cascade the
		// window to somewhere else and report the request as honoured.
		if !positioned {
			return nil, fmt.Errorf("window_create: %s is not a frame a window can occupy", showRect(rect))
		}
	}

	name, restore, err := createName(deps, label)
	if err != nil {
		return nil, err
	}
	if restore != "" {
		// The name is already held. Creating a second window under it would
		// leave two that this host tells apart by map order, so a repeated
		// restore returns the name it already has and creates nothing.
		return restore, nil
	}

	// The window to cascade from is read before the build. Afterwards the new
	// window holds the focus and the source is no longer the focused one.
	source, cascading := Frame{}, false
	if label == nil && !positioned {
		source, cascading = focusedFrame(deps.Host)
	}

	if err := deps.Host.Open(OpenSpec{Name: name, URL: windowURL(init)}); err != nil {
		return nil, fmt.Errorf("window %s could not be created: %w", name, err)
	}

	// Creation is not complete until the name is an address. This host's
	// creation blocks on a main-thread acknowledgement, so by the time it
	// returns the native window either exists or never will — one read, no
	// loop, no timeout.
	if !deps.Host.Live(name) {
		return nil, rollbackWindow(deps.Host, name, errors.New("it never became an address"))
	}

	switch {
	case positioned:
		if err := deps.Host.Place(name, requested); err != nil {
			return nil, rollbackWindow(deps.Host, name, err)
		}
	case cascading:
		fresh, known := deps.Host.Frame(name)
		if known {
			if err := deps.Host.Place(name, cascadeFrom(source, fresh)); err != nil {
				return nil, rollbackWindow(deps.Host, name, err)
			}
		}
	}

	// Revealed last, and only now: the window opened hidden so that no frame
	// was ever composed at the position the OS picked, which would show as a
	// jump rather than as an error.
	if err := deps.Host.Reveal(name, shouldFocus(focus)); err != nil {
		return nil, rollbackWindow(deps.Host, name, err)
	}
	return name, nil
}

// createName decides what the new window is called. The second result is a name
// that already exists, which means create nothing and answer with it.
func createName(deps Deps, label *string) (name string, held string, err error) {
	if label != nil {
		if !validWindowName(*label) {
			return "", "", fmt.Errorf("window name %q is not addressable: it must be %q or %s<id>",
				*label, controlPlaneWindow, workspaceWindowPrefix)
		}
		if isHeld(deps.Host, *label) {
			// The name is already held. Creating a second window under it would
			// leave two that this host tells apart by map order, so the request
			// answers with the window that exists and opens nothing.
			return "", *label, nil
		}
		if *label == controlPlaneWindow {
			// The orchestrator is one window or none, and the launcher opens
			// it. Letting a command open it too makes how many exist depend on
			// what anyone happened to call — and two of them is not a state
			// anything downstream is written for.
			return "", "", fmt.Errorf(
				"%q is the orchestrator and the launcher opens it; a command may only reopen one that is already there",
				controlPlaneWindow)
		}
		return *label, "", nil
	}

	generated := workspaceName(deps.NewID())
	if !validWindowName(generated) {
		return "", "", fmt.Errorf("the generated window name %q is not addressable", generated)
	}
	if isHeld(deps.Host, generated) {
		// Answering with the existing name would hand the caller somebody
		// else's window, and creating anyway would leave two under one name.
		return "", "", fmt.Errorf("the generated window name %s is already held; the identifier source is repeating itself", generated)
	}
	return generated, "", nil
}

// rollbackWindow gives back a name whose window cannot be used, and reports
// why. An addressless window left behind is visible to a listing, answers
// nothing, and blocks the name for the next attempt.
func rollbackWindow(host WindowHost, name string, cause error) error {
	if err := host.Discard(name); err != nil {
		return fmt.Errorf("window %s failed (%v) and could not be withdrawn: %w", name, cause, err)
	}
	return fmt.Errorf("window %s was withdrawn: %w", name, cause)
}

// windowURL joins the boot instruction onto the window's URL. The core does not
// interpret the query — the frontend's boot does.
func windowURL(init *string) string {
	if init == nil || *init == "" {
		return "/"
	}
	return "/?" + *init
}

// rectArgument is a requested frame as it arrives. Every component is optional
// so that a missing one stays distinguishable from a zero.
type rectArgument struct {
	X *float64 `json:"x"`
	Y *float64 `json:"y"`
	W *float64 `json:"w"`
	H *float64 `json:"h"`
}

// showRect renders a requested frame for an error message, naming the
// components that never arrived rather than printing a zero for them.
func showRect(rect *rectArgument) string {
	show := func(component *float64) string {
		if component == nil {
			return "absent"
		}
		return strconv.FormatFloat(*component, 'g', -1, 64)
	}
	return fmt.Sprintf("%s,%s %sx%s",
		show(rect.X), show(rect.Y), show(rect.W), show(rect.H))
}

func requireStarted(host WindowHost) error {
	if host.Started() {
		return nil
	}
	// Distinct from "there are no windows". A window queued ahead of the run
	// loop is in the registry and reachable by nothing, and dispatching to a
	// main thread that does not exist yet takes the process down rather than
	// answering.
	return errors.New("the application run loop has not started")
}

// targetWindow resolves the window a command was aimed at.
func targetWindow(host WindowHost, args control.Args) (string, error) {
	if err := requireStarted(host); err != nil {
		return "", err
	}
	name, err := control.Arg[string](args, "label")
	if err != nil {
		return "", err
	}
	if !isHeld(host, name) {
		return "", fmt.Errorf("window not found: %s", name)
	}
	if !host.Live(name) {
		// This host's close, focus and reload all return silently for a window
		// with no native lifetime. Passing that through would report having
		// done something that never happened.
		return "", fmt.Errorf("window %s has no native lifetime; it answers nothing", name)
	}
	return name, nil
}

// heldNames is every window name this process holds, sorted. Sorted because the
// underlying registry is a map and Go randomises its order, so two readings
// would disagree with nothing having changed.
func heldNames(host WindowHost) []string {
	names := append([]string(nil), host.Names()...)
	sort.Strings(names)
	return names
}

func isHeld(host WindowHost, name string) bool {
	for _, held := range host.Names() {
		if held == name {
			return true
		}
	}
	return false
}

// focusedFrame is where the window receiving keys sits. The second result is
// false when no window has focus, which is a different fact from a window at
// the origin.
func focusedFrame(host WindowHost) (Frame, bool) {
	for _, name := range heldNames(host) {
		if !host.Focused(name) {
			continue
		}
		if frame, positioned := host.Frame(name); positioned {
			return frame, true
		}
	}
	return Frame{}, false
}
