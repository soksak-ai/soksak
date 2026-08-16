package wails

import (
	compositor "github.com/soksak/wails-service-native-compositor"
)

// CompositorSource renames the compositor's composition into this package's.
//
// The compositor is a separate module with its own release, so the surface
// commands declare what they need (CompositionSource) and this translates. A
// rule that named the compositor could only be checked by building the whole
// application.
//
// Translation, and nothing else. Pairing the two halves of one commit, naming
// the surfaces with only one half, and the difference between the halves are
// the compositor's, next to the commit they are taken from — a caller of the
// service reads the composition without this package.
type CompositorSource struct {
	service *compositor.Service
}

// NewCompositorSource joins the surface commands to the compositor.
func NewCompositorSource(service *compositor.Service) *CompositorSource {
	return &CompositorSource{service: service}
}

// Latest renames one window's composition, field for field.
func (source *CompositorSource) Latest(window string) Composition {
	if source == nil || source.service == nil {
		return Composition{}
	}
	composed := source.service.Latest(window)

	composition := Composition{
		Sequence:       composed.Sequence,
		Unapplied:      composed.Unapplied,
		Failure:        composed.Failure,
		FailedSequence: composed.FailedSequence,
	}
	for _, placement := range composed.Surfaces {
		composition.Placements = append(composition.Placements, SurfacePlacement{
			ID:              placement.ID,
			Kind:            string(placement.Kind),
			Generation:      placement.Generation,
			Layer:           placement.Layer,
			Declared:        compositorFrame(placement.Declared),
			DeclaredVisible: placement.DeclaredVisible,
			DeclaredAlpha:   placement.DeclaredAlpha,
			Applied:         compositorFrame(placement.Applied),
			AppliedVisible:  placement.AppliedVisible,
			AppliedAlpha:    placement.AppliedAlpha,
			Misparented:     placement.Misparented,
			Undeclared:      placement.Undeclared,
			// Read, not recomputed. The service subtracted it from the two
			// halves of one commit; subtracting again here would be a second
			// definition of one number.
			Drift: driftOf(placement.Drift),
		})
	}
	return composition
}

// compositorFrame renames one rectangle. The compositor spells the two sides
// width and height; the page reads w and h.
func compositorFrame(frame compositor.Frame) SurfaceFrame {
	return SurfaceFrame{X: frame.X, Y: frame.Y, W: frame.Width, H: frame.Height}
}

// driftOf is the difference the compositor answered, in the page's spelling.
//
// Nil where the surface has only one half — an undeclared surface has no
// declaration to subtract from, and a zero rectangle there would read as "in
// exactly the right place" for a surface nobody asked for.
func driftOf(drift *compositor.Frame) SurfaceFrame {
	if drift == nil {
		return SurfaceFrame{}
	}
	return compositorFrame(*drift)
}
