package wails

import (
	"sort"
	"sync"
	"unsafe"

	compositor "github.com/soksak/wails-service-native-compositor"
)

// SurfaceRecorder is the witness on the one path a native inventory travels.
//
// The compositor validates and sequences an inventory, hands it to a backend,
// and keeps the receipt. It does not keep the inventory: after the commit, the
// declared rectangles are gone and only the applied ones remain. That makes the
// composition unjudgeable — an applied frame on its own says where a surface is
// and nothing about where it was supposed to be.
//
// Rather than ask the compositor to hold its input, this sits between it and
// the real backend. Both halves are in hand in the same call, which is stronger
// than a getter would be: no second read can arrive from a different moment.
//
// It writes nothing and refuses nothing. The inventory goes through unchanged
// and the backend's answer comes back unchanged, so what this reports is the
// composition rather than a description of itself.
type SurfaceRecorder struct {
	inner compositor.Backend

	mu     sync.Mutex
	latest Composition
}

// NewSurfaceRecorder wraps the backend that owns the native technology.
//
// A nil backend is refused here rather than at the first commit: a recorder
// with nothing underneath it would report every inventory as applied while
// nothing was ever created, and the screen would be empty with a clean ledger.
func NewSurfaceRecorder(inner compositor.Backend) *SurfaceRecorder {
	if inner == nil {
		panic("wails: a surface recorder needs the backend it records")
	}
	return &SurfaceRecorder{inner: inner}
}

// Apply hands the inventory to the real backend and records both halves.
func (recorder *SurfaceRecorder) Apply(window unsafe.Pointer, snapshot compositor.Snapshot) ([]compositor.AppliedSurface, error) {
	applied, err := recorder.inner.Apply(window, snapshot)

	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	if err != nil {
		// The composition is what is on screen, and a refused batch changed
		// nothing there. Replacing it would answer with an empty layer while
		// the previous surfaces are still visible.
		recorder.latest.Failure = err.Error()
		recorder.latest.FailedSequence = snapshot.Sequence
		return nil, err
	}
	recorder.latest = pairCommit(snapshot, applied)
	return applied, nil
}

// Latest is the last inventory that landed.
func (recorder *SurfaceRecorder) Latest() Composition {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	// Copied out. The slices are rebuilt on every commit and never mutated in
	// place, so handing the same headers to a caller that outlives the next
	// commit is safe; the struct copy is what keeps the failure fields from
	// being read half-updated.
	return recorder.latest
}

// pairCommit joins the declaration to the read-back.
//
// Paired by surface identity, never by position. Nothing in the backend
// contract says the applied inventory comes back in the order it was given —
// the compositor sorts it by id after the fact, and the browser backend plans
// its batch in layer order — so pairing by index would subtract one surface's
// rectangle from another's and report two displacements that are one surface
// each in the right place.
func pairCommit(snapshot compositor.Snapshot, applied []compositor.AppliedSurface) Composition {
	declared := make(map[string]compositor.Surface, len(snapshot.Surfaces))
	for _, surface := range snapshot.Surfaces {
		declared[surface.ID] = surface
	}

	placements := make([]SurfacePlacement, 0, len(applied))
	for _, surface := range applied {
		placement := SurfacePlacement{
			ID:             surface.ID,
			Generation:     surface.Generation,
			Layer:          surface.Layer,
			Applied:        surfaceFrameOf(surface.Frame),
			AppliedVisible: surface.Visible,
			AppliedAlpha:   surface.Alpha,
		}
		declaration, asked := declared[surface.ID]
		if asked {
			placement.Kind = string(declaration.Kind)
			placement.Declared = surfaceFrameOf(declaration.Frame)
			placement.DeclaredVisible = declaration.Visible
			placement.DeclaredAlpha = declaration.Alpha
			delete(declared, surface.ID)
		} else {
			placement.Undeclared = true
		}
		placements = append(placements, placement)
	}
	sort.Slice(placements, func(i, j int) bool { return placements[i].ID < placements[j].ID })

	// What is left is declared and never answered about. Named rather than
	// counted: a caller can act on a name.
	unapplied := make([]string, 0, len(declared))
	for id := range declared {
		unapplied = append(unapplied, id)
	}
	sort.Strings(unapplied)

	return Composition{
		Sequence:   snapshot.Sequence,
		Placements: placements,
		Unapplied:  unapplied,
	}
}

// surfaceFrameOf renames the fields and changes nothing else. Both types are
// CSS points with a top-left origin; only the caller's spelling of the size
// differs, and this package answers in the page's.
func surfaceFrameOf(frame compositor.Frame) SurfaceFrame {
	return SurfaceFrame{X: frame.X, Y: frame.Y, W: frame.Width, H: frame.Height}
}
