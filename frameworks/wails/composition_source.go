package wails

import (
	compositor "github.com/soksak/wails-service-native-compositor"
)

// CompositorSource reads the compositor's last commit as a Composition.
//
// The compositor is a separate module with its own release, so the surface
// commands declare what they need (CompositionSource) and this translates. A
// rule that named the compositor could only be checked by building the whole
// application.
type CompositorSource struct {
	service *compositor.Service
}

// NewCompositorSource joins the surface commands to the compositor.
func NewCompositorSource(service *compositor.Service) *CompositorSource {
	return &CompositorSource{service: service}
}

// Latest pairs each declared surface with what the native layer reported.
//
// Both halves come from one commit. Reading the declared half from the document
// instead would compare a later frame against an earlier application, and the
// difference would be attributed to the native layer.
//
// A declared surface the native layer did not report is named in Unapplied
// rather than dropped: a count that agreed while the screen did not is what
// that list exists to prevent.
func (source *CompositorSource) Latest(window string) Composition {
	if source == nil || source.service == nil {
		return Composition{}
	}
	committed := source.service.Latest(window)

	applied := make(map[string]compositor.AppliedSurface, len(committed.Applied.Surfaces))
	for _, surface := range committed.Applied.Surfaces {
		applied[surface.ID] = surface
	}

	composition := Composition{
		Sequence:       committed.Applied.Sequence,
		Failure:        committed.Failure,
		FailedSequence: committed.FailedSequence,
	}
	declared := make(map[string]bool, len(committed.Declared.Surfaces))
	for _, surface := range committed.Declared.Surfaces {
		declared[surface.ID] = true
		reported, landed := applied[surface.ID]
		if !landed {
			composition.Unapplied = append(composition.Unapplied, surface.ID)
			continue
		}
		composition.Placements = append(composition.Placements, SurfacePlacement{
			ID:              surface.ID,
			Kind:            string(surface.Kind),
			Generation:      surface.Generation,
			Layer:           surface.Layer,
			Declared:        compositorFrame(surface.Frame),
			DeclaredVisible: surface.Visible,
			DeclaredAlpha:   surface.Alpha,
			Applied:         compositorFrame(reported.Frame),
			AppliedVisible:  reported.Visible,
			AppliedAlpha:    reported.Alpha,
			Misparented:     reported.Misparented,
		})
	}
	// A surface the native layer holds that the document never asked for. It is
	// the defect a ledger-only check cannot see: the application walks its own
	// records, so a surface that left the records and stayed on screen is
	// invisible to every check the application makes.
	for _, surface := range committed.Applied.Surfaces {
		if declared[surface.ID] {
			continue
		}
		composition.Placements = append(composition.Placements, SurfacePlacement{
			ID:             surface.ID,
			Generation:     surface.Generation,
			Layer:          surface.Layer,
			Applied:        compositorFrame(surface.Frame),
			AppliedVisible: surface.Visible,
			AppliedAlpha:   surface.Alpha,
			Undeclared:     true,
		})
	}
	return composition
}

func compositorFrame(frame compositor.Frame) SurfaceFrame {
	return SurfaceFrame{X: frame.X, Y: frame.Y, W: frame.Width, H: frame.Height}
}
