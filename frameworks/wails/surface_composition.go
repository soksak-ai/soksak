package wails

import (
	"fmt"

	"github.com/soksak/soksak-core/core/control"
	"github.com/soksak/soksak-core/core/i18n"
)

// The surface group: what the native composition currently is.
//
// The application declares native surfaces in the DOM and never positions them.
// One delivery holds a complete inventory, and one receipt reports what was
// actually applied. Both halves speak CSS points with a top-left origin, so the
// compositing verdict is a subtraction rather than a conversion — and this file
// is where the subtraction happens.
//
// The compositor is registered as a service, which makes it reachable from the
// page and from nowhere else. A caller outside the process — an agent, a test,
// a person at a terminal — could not ask what the composition was, so the only
// available verdict was a screenshot and an opinion about it.
//
// Three of this group's four names are refused rather than served, and the
// refusals are the contract rather than an absence of work: see
// registerInventoryRefusals.

// SurfaceFrame is one native surface's rectangle in CSS points with a top-left
// origin — the coordinate contract the declaration and the receipt already
// share.
//
// The keys are w and h rather than width and height because they are the
// caller's, not this package's: the page reads frame.w and frame.h, and a
// payload spelling them width and height hands it undefined. Every overflow
// subtraction downstream then becomes NaN, NaN compares false against the
// tolerance, and the "is this surface inside the window" check reports a clean
// pass for a surface drawn hundreds of points off screen.
type SurfaceFrame struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

// Area reports whether this rectangle can hold any pixels at all.
func (frame SurfaceFrame) Area() bool { return frame.W > 0 && frame.H > 0 }

// Overlaps reports whether this rectangle puts any pixels inside other.
//
// Touching edges do not overlap: a surface whose right edge is the crop's left
// edge contributes no column, and drawing it would place a zero-width image the
// composite would have to special-case anyway.
func (frame SurfaceFrame) Overlaps(other SurfaceFrame) bool {
	return frame.X < other.X+other.W && other.X < frame.X+frame.W &&
		frame.Y < other.Y+other.H && other.Y < frame.Y+frame.H
}

// SurfacePlacement is one surface at one commit: what the document declared and
// what the native layer reported back, read in the same instant.
//
// Same instant is the whole point. Read from two places at two moments, a live
// resize turns a correct layer into a drift report and back again depending on
// which read won — the same defect NATIVE-LAYER.md records for capture, where
// mixing an earlier window frame with later pixels produced a frame that was
// never on screen.
type SurfacePlacement struct {
	ID         string
	Kind       string
	Generation uint64
	Layer      int

	Declared        SurfaceFrame
	DeclaredVisible bool
	DeclaredAlpha   float64

	Applied        SurfaceFrame
	AppliedVisible bool
	AppliedAlpha   float64

	// Misparented reports that the surface is in a different window from the one
	// whose document declared it, read off the native object rather than restated
	// from the declaration.
	//
	// Every other number here describes a rectangle inside some window, so all of
	// them read correct while the rectangle is inside a window nobody is looking at.
	Misparented bool

	// Undeclared marks a surface the native layer holds that the document never
	// asked for. It is the defect a ledger-only ghost hunt cannot see: the
	// application walks its own records, so a surface that left the records and
	// stayed on screen is invisible to every check the application makes.
	Undeclared bool
}

// Drift is the applied rectangle minus the declared one, per component.
//
// Exact, with no tolerance. Both halves are the same float64 travelling one
// commit, so zero is reachable; a tolerance chosen without a measurement would
// be a silent fallback that hides the first hundredth of a point of the next
// coordinate bug. A caller that wants to forgive a rounding difference has the
// number and can.
func (placement SurfacePlacement) Drift() SurfaceFrame {
	return SurfaceFrame{
		X: placement.Applied.X - placement.Declared.X,
		Y: placement.Applied.Y - placement.Declared.Y,
		W: placement.Applied.W - placement.Declared.W,
		H: placement.Applied.H - placement.Declared.H,
	}
}

// Displaced reports that this surface is not where it was declared to be.
//
// Three ways: a rectangle that does not match, a window that does not match, or
// no declaration at all. A surface with no declaration cannot match a rectangle
// that does not exist, and answering false would make it the one thing on the
// list that looks correct.
func (placement SurfacePlacement) Displaced() bool {
	return placement.Undeclared || placement.Misparented || placement.Drift() != SurfaceFrame{}
}

// EffectivelyHidden reports that this surface puts no light on the screen.
//
// Three ways to arrive there, all read from the applied half: the native layer
// hid it, it is fully transparent, or it has no area. There is no fourth,
// inherited way — these surfaces are attached directly to the window's content
// view, so there is no ancestor to be hidden by.
func (placement SurfacePlacement) EffectivelyHidden() bool {
	return !placement.AppliedVisible || placement.AppliedAlpha == 0 || !placement.Applied.Area()
}

// Composition is the last inventory the native layer accepted.
type Composition struct {
	// Sequence is the commit this composition came from. Zero means no
	// inventory has ever been applied, which is a different answer from an
	// inventory that was applied and held nothing: one is a window whose panes
	// declare no native surface, the other is a compositor that has never run.
	Sequence uint64
	// Placements is one entry per surface the native layer reported.
	Placements []SurfacePlacement
	// Unapplied names the surfaces the document declared and the native layer
	// did not report back. A count that agreed while the screen did not is what
	// this list exists to prevent.
	Unapplied []string
	// Failure is what the native layer said about the most recent attempt that
	// did not land, empty when the last attempt did land. Without it a
	// compositor that refuses every new inventory keeps answering with the last
	// healthy one, and every reading reports the layer as fine.
	Failure string
	// FailedSequence is the sequence of that attempt.
	FailedSequence uint64
}

// CompositionSource answers with the latest applied inventory.
//
// An interface rather than the compositor itself, because the compositor is a
// separate module with its own release and its own native backend — a rule that
// names it can only be checked by building the whole application.
// Per window. One window's inventory is no answer about another's: measured
// 2026-08-16, a window-blind reading answered `main` and
// `win-8ed56cd7d9305935` with the same single surface at the same rectangle
// with zero drift, while only one of those windows had a browser in it and
// neither had it in the right place.
type CompositionSource interface {
	Latest(window string) Composition
}

// SurfaceDeps is what the process supplies.
type SurfaceDeps struct {
	// Composition is where both halves of one commit were recorded. A nil one
	// is refused at registration rather than answered around: an empty
	// composition and a composition nobody is recording are the same payload,
	// and the caller would read "this window has no native surfaces" for a
	// window full of them.
	Composition CompositionSource
	// NativeParent reports whether the native container these surfaces attach
	// to exists right now — the named window's content view. A nil one is
	// refused for the same reason: answering false with nobody to ask makes
	// "the window is not up yet" and "the window is gone" one answer, and a
	// caller cannot act on either.
	//
	// By name, because the question is about the window being asked about. A
	// host that answered for whichever window it happened to hold would report
	// a present parent for a window that has none, which is the difference
	// between "this pane declared nothing" and "this pane has nowhere to draw".
	NativeParent func(window string) bool
}

// surfaceWindow is the window a surface reading is about.
//
// The caller's own by default, because a page asking what it declared means its
// own window; an outside operator names one, because it has no window and every
// window is equally its business. Neither is guessed: a reading that answered
// about whichever window the host happened to hold is what let a workspace
// window's browser be reported present while its pane was empty.
func surfaceWindow(args control.Args) (string, error) {
	name, err := control.OptionalArg(args, "window", "")
	if err != nil {
		return "", err
	}
	if name == "" {
		name, err = control.OptionalArg(args, control.CallerWindowArgument, "")
		if err != nil {
			return "", err
		}
	}
	if name == "" {
		return "", i18n.Errorf("wails.surface.needsWindow", nil)
	}
	return name, nil
}

// RegisterSurface adds the surface group to the registry.
//
// The name is RegisterSurface rather than Register because this package already
// has a Register: the window group took it, and this is one Go package.
//
// It panics on a missing dependency, matching MustRegister: boot-time
// registration is a programming fact, and finding it out as a failed command
// means the one window into the native layer is dark exactly when someone is
// using it to find out why the screen is wrong.
func RegisterSurface(registry *control.Registry, deps SurfaceDeps) {
	if deps.Composition == nil {
		panic("wails: the surface commands need a composition to read")
	}
	if deps.NativeParent == nil {
		panic("wails: the surface commands need to be able to ask whether the native parent is there")
	}

	// Names the frontend calls that this host does not answer. Declared here so
	// a caller reads the reason instead of "unknown command".
	for name, because := range map[string]string{
		"webview_list":         "surfaces are read from the composition receipt; this host enumerates none",
		"webview_health_query": "this host keeps no per-surface health record",
	} {
		if err := registry.DeclareUnserved(name, because); err != nil {
			panic(err)
		}
	}

	registry.MustRegister(control.Command{
		Name:  "engine_surface_stats",
		Owner: control.OwnerFramework,
		// Framework-owned: a process with no window has no native layer, so
		// there is no host-independent answer to what it applied.
		Handler: func(args control.Args) (any, error) {
			window, err := surfaceWindow(args)
			if err != nil {
				return nil, err
			}
			return surfaceStatsOf(deps.Composition.Latest(window), deps.NativeParent(window)), nil
		},
	})

	registry.MustRegister(control.Command{
		Name:  "surface.composition",
		Owner: control.OwnerFramework,
		// Framework-owned for the same reason as engine_surface_stats: a
		// process with no window applied nothing.
		Handler: func(args control.Args) (any, error) {
			window, err := surfaceWindow(args)
			if err != nil {
				return nil, err
			}
			return compositionJudgementOf(deps.Composition.Latest(window), deps.NativeParent(window)), nil
		},
	})

	registerInventoryRefusals(registry)
}

// compositionJudgement is the answer to "does the screen hold the layout".
//
// engine_surface_stats has the same halves per surface. Taking the maximum
// there would put the rule in each caller, and two callers reading one commit
// could then disagree about it. It is taken once, here, next to the coordinate
// system it was measured in.
type compositionJudgement struct {
	Sequence uint64 `json:"sequence"`
	// Coordinates names the frame both halves are in. The declaration is
	// written by the document in CSS pixels from the top left, and the native
	// layer reports back in the same frame — a reader who assumes the
	// platform's own origin subtracts two numbers that are not comparable.
	Coordinates string `json:"coordinates"`
	// NativeParentPresent separates "no surfaces because none were declared"
	// from "no surfaces because there is nothing to attach them to". Both are
	// worst 0, and one of them is a broken window.
	NativeParentPresent bool `json:"nativeParentPresent"`

	// Worst is the largest difference between a declared rectangle and the
	// applied one, over every surface and every component. Exact, with no
	// tolerance: both halves are the same float64 travelling one commit, so
	// zero is reachable, and a tolerance chosen without a measurement hides the
	// first hundredth of a point of the next coordinate bug.
	Worst     float64            `json:"worst"`
	Displaced int                `json:"displaced"`
	Surfaces  []compositionPlace `json:"surfaces"`

	// Unapplied and Undeclared are surfaces with one half. Neither is a
	// difference — there is no second rectangle to subtract — so folding them
	// into worst would answer a number for something that has none, and folding
	// them into zero would call a pane with no surface correct.
	Unapplied  []string `json:"unapplied"`
	Undeclared []string `json:"undeclared"`

	// Misparented names the surfaces in a window other than the one that
	// declared them. Not a difference either — a window is not a distance — so it
	// is its own list rather than a number folded into worst.
	Misparented []string `json:"misparented"`

	// Failure names the most recent attempt that did not land. The compositor
	// keeps answering with the last inventory that did, so a layer refusing
	// every new one reports zero difference forever without this.
	Failure        string `json:"failure,omitempty"`
	FailedSequence uint64 `json:"failedSequence,omitempty"`
}

// compositionPlace is one surface with both halves and their difference.
type compositionPlace struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	Generation uint64 `json:"generation"`
	Layer      int    `json:"layer"`

	Declared        SurfaceFrame `json:"declared"`
	DeclaredVisible bool         `json:"declaredVisible"`
	DeclaredAlpha   float64      `json:"declaredAlpha"`

	Applied        SurfaceFrame `json:"applied"`
	AppliedVisible bool         `json:"appliedVisible"`
	AppliedAlpha   float64      `json:"appliedAlpha"`

	// Misparented is the surface being in a window other than the one that
	// declared it. Separate from drift: drift is a distance and this is not.
	Misparented bool         `json:"misparented"`
	Drift       SurfaceFrame `json:"drift"`
	Worst       float64      `json:"worst"`
}

// compositionJudgementOf takes the maximum over one recorded composition.
func compositionJudgementOf(composition Composition, parentPresent bool) compositionJudgement {
	// Never nil: a nil slice encodes as null, and a caller reading length on
	// null gets an error where it asked a question.
	places := make([]compositionPlace, 0, len(composition.Placements))
	undeclared := make([]string, 0)
	misparented := make([]string, 0)
	unapplied := make([]string, 0, len(composition.Unapplied))
	unapplied = append(unapplied, composition.Unapplied...)

	worst := 0.0
	displaced := 0
	for _, placement := range composition.Placements {
		if placement.Undeclared {
			undeclared = append(undeclared, placement.ID)
			displaced++
			continue
		}
		drift := placement.Drift()
		here := largestComponent(drift)
		if here > worst {
			worst = here
		}
		if placement.Displaced() {
			displaced++
		}
		if placement.Misparented {
			misparented = append(misparented, placement.ID)
		}
		places = append(places, compositionPlace{
			ID:              placement.ID,
			Kind:            placement.Kind,
			Generation:      placement.Generation,
			Layer:           placement.Layer,
			Declared:        placement.Declared,
			DeclaredVisible: placement.DeclaredVisible,
			DeclaredAlpha:   placement.DeclaredAlpha,
			Applied:         placement.Applied,
			AppliedVisible:  placement.AppliedVisible,
			AppliedAlpha:    placement.AppliedAlpha,
			Misparented:     placement.Misparented,
			Drift:           drift,
			Worst:           here,
		})
	}

	return compositionJudgement{
		Sequence:            composition.Sequence,
		Coordinates:         "css-top-left",
		NativeParentPresent: parentPresent,
		Worst:               worst,
		Displaced:           displaced,
		Surfaces:            places,
		Unapplied:           unapplied,
		Undeclared:          undeclared,
		Misparented:         misparented,
		Failure:             composition.Failure,
		FailedSequence:      composition.FailedSequence,
	}
}

// largestComponent is how far a rectangle is from where it was declared, as one
// number. Every component counts: a surface that is the right size in the wrong
// place and one that is the right place in the wrong size are both wrong, and
// reading only the origin reports the second as correct.
func largestComponent(drift SurfaceFrame) float64 {
	worst := 0.0
	for _, component := range []float64{drift.X, drift.Y, drift.W, drift.H} {
		if component < 0 {
			component = -component
		}
		if component > worst {
			worst = component
		}
	}
	return worst
}

// registerInventoryRefusals declares the three names that ask this backend to
// write one surface.
//
// One delivery holds a complete inventory and a second writer is refused
// before anything mutates. A command here that closed or hid a single surface
// would be that second writer, and it would not even survive: the next full
// commit reconciles against the declaration and puts the surface straight back.
// The caller would watch it return with nothing to read that explains why.
//
// Each refusal names the attribute that actually owns the outcome, so a caller
// receives somewhere to go rather than a dead end.
func registerInventoryRefusals(registry *control.Registry) {
	for name, reason := range map[string]string{
		"webview_close": "a native surface's lifetime is owned by its declaration; " +
			"remove the element carrying data-native-surface and the next inventory commit destroys it. " +
			"Closing one from here is a second writer the next commit reverts",
		"webview_recover": "nothing in this build records a native surface crash, " +
			"so there is no breaker state to reset and no per-surface reload to run. " +
			"Re-declare the surface with a higher data-native-generation to have it rebuilt",
	} {
		if err := registry.DeclareUnserved(name, reason); err != nil {
			panic(fmt.Sprintf("wails: declaring %s unserved: %v", name, err))
		}
	}
}

// surfaceRow is one surface as a caller receives it.
//
// The key names are the page's. label rather than id because that is what the
// page calls a surface on this side; alpha and effectiveAlpha are both carried
// and are equal here, because these surfaces attach directly to the window's
// content view and there is no ancestor alpha to multiply through — which is
// itself the fact worth publishing, rather than dropping a key the page reads.
type surfaceRow struct {
	Label      string `json:"label"`
	Kind       string `json:"kind"`
	Generation uint64 `json:"generation"`
	Layer      int    `json:"layer"`

	Hidden            bool    `json:"hidden"`
	EffectivelyHidden bool    `json:"effectivelyHidden"`
	Alpha             float64 `json:"alpha"`
	EffectiveAlpha    float64 `json:"effectiveAlpha"`
	DeclaredAlpha     float64 `json:"declaredAlpha"`
	DeclaredVisible   bool    `json:"declaredVisible"`

	// Frame is the applied rectangle — where the surface actually is. The page
	// judges "inside the window" against this, and judging against the
	// declaration would compare the layout with itself.
	Frame      SurfaceFrame `json:"frame"`
	Declared   SurfaceFrame `json:"declared"`
	Drift      SurfaceFrame `json:"drift"`
	Displaced  bool         `json:"displaced"`
	Undeclared bool         `json:"undeclared"`
}

// surfaceStats is the whole answer.
type surfaceStats struct {
	// Registered and ProviderParentPresent are the page's names for "how many
	// surfaces the native layer holds" and "is the container they attach to
	// there". The page falls back to registered:-1 when the read itself fails,
	// so zero here always means a real, measured zero.
	Registered            int  `json:"registered"`
	ProviderParentPresent bool `json:"providerParentPresent"`

	Sequence  uint64       `json:"sequence"`
	Surfaces  []surfaceRow `json:"surfaces"`
	Displaced int          `json:"displaced"`
	Unapplied []string     `json:"unapplied"`

	Failure        string `json:"failure,omitempty"`
	FailedSequence uint64 `json:"failedSequence,omitempty"`
}

// surfaceStatsOf turns one recorded composition into the payload.
func surfaceStatsOf(composition Composition, parentPresent bool) surfaceStats {
	// Never nil. A nil slice encodes as null, and the page reads
	// surfaces?.surfaces ?? [] — which turns "the compositor answered null"
	// into the same empty list as "there are no surfaces".
	rows := make([]surfaceRow, 0, len(composition.Placements))
	displaced := 0
	for _, placement := range composition.Placements {
		row := surfaceRow{
			Label:             placement.ID,
			Kind:              placement.Kind,
			Generation:        placement.Generation,
			Layer:             placement.Layer,
			Hidden:            !placement.AppliedVisible,
			EffectivelyHidden: placement.EffectivelyHidden(),
			Alpha:             placement.AppliedAlpha,
			EffectiveAlpha:    placement.AppliedAlpha,
			DeclaredAlpha:     placement.DeclaredAlpha,
			DeclaredVisible:   placement.DeclaredVisible,
			Frame:             placement.Applied,
			Declared:          placement.Declared,
			Drift:             placement.Drift(),
			Displaced:         placement.Displaced(),
			Undeclared:        placement.Undeclared,
		}
		if row.Displaced {
			displaced++
		}
		rows = append(rows, row)
	}

	unapplied := composition.Unapplied
	if unapplied == nil {
		unapplied = []string{}
	}

	return surfaceStats{
		Registered:            len(rows),
		ProviderParentPresent: parentPresent,
		Sequence:              composition.Sequence,
		Surfaces:              rows,
		Displaced:             displaced,
		Unapplied:             unapplied,
		Failure:               composition.Failure,
		FailedSequence:        composition.FailedSequence,
	}
}
