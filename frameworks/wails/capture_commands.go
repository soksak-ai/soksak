package wails

import (
	"fmt"
	"unsafe"

	"github.com/soksak/soksak-core/core/control"
	"github.com/soksak/soksak-core/core/i18n"
)

// RegisterCapture puts the capture on the registry.
//
// It was reachable only through the frontend binding, which made the one thing
// that shows what the application looks like the one thing an outside caller
// could not ask for. A capability with no command cannot be verified from
// outside, and this is the surface that exists to be looked at.
//
// Framework-owned: the pixels belong to a window, and a host without one
// answers that rather than pretending.
// The surfaces argument is where a capture gets content that draws outside this process. A build
// with none passes nil, and the capture is then the window layer alone — which is what every
// capture was before native surfaces existed.
//
// It has to arrive here. A capture service built per call holds only the window it was handed,
// while the one built at composition holds the compositor; measured 2026-08-16, that split left
// every command-driven capture reporting 0 surfaces while surface.composition reported 1, and a
// browser pane was a flat rectangle in every screenshot.
func RegisterCapture(registry *control.Registry, host WindowHost, surfaces SurfaceImages) {
	if host == nil {
		panic("wails: the capture commands need a WindowHost")
	}

	// Which window's pixels. The caller's own by default, because a window
	// asking for a snapshot means its own; an outside operator names one,
	// because it has no window and every window is equally its business.
	//
	// Measured 2026-08-15: capture could only reach the window this host
	// captured at registration, so a theme defect in a workspace window
	// answered with a picture of the orchestrator.
	target := func(args control.Args) (*CaptureService, error) {
		name, err := control.OptionalArg(args, "window", "")
		if err != nil {
			return nil, err
		}
		if name == "" {
			name, err = control.OptionalArg(args, control.CallerWindowArgument, "")
			if err != nil {
				return nil, err
			}
		}
		if name == "" {
			return nil, i18n.Errorf("wails.capture.needsWindow", nil)
		}
		handle := host.NativeHandle(name)
		if handle == nil {
			return nil, i18n.Errorf("wails.capture.noPixels", map[string]string{"window": name})
		}
		return NewCaptureService(func() unsafe.Pointer { return handle }).withSurfaces(surfaces), nil
	}

	registry.MustRegister(control.Command{
		Name:  "window_snapshot",
		Owner: control.OwnerFramework,
		Handler: func(args control.Args) (any, error) {
			path, err := control.Arg[string](args, "path")
			if err != nil {
				return nil, err
			}
			service, err := target(args)
			if err != nil {
				return nil, err
			}
			// The written path is the answer, so a caller reads where the file
			// landed instead of assuming it went where they asked.
			return service.Snapshot(path)
		},
	})

	registry.MustRegister(control.Command{
		Name:  "window_snapshot_region",
		Owner: control.OwnerFramework,
		Handler: func(args control.Args) (any, error) {
			path, err := control.Arg[string](args, "path")
			if err != nil {
				return nil, err
			}
			rect, err := captureRect(args)
			if err != nil {
				return nil, err
			}
			service, err := target(args)
			if err != nil {
				return nil, err
			}
			return service.SnapshotRegion(path, rect)
		},
	})
}

// captureRect reads a window-relative rect in CSS points.
//
// A region of zero area is refused rather than quietly widened to the whole
// window: those are different requests, and a caller who asked for a region and
// received the window would compare the wrong pixels.
func captureRect(args control.Args) (Rect, error) {
	var rect Rect
	for name, into := range map[string]*float64{
		"x": &rect.X, "y": &rect.Y, "width": &rect.Width, "height": &rect.Height,
	} {
		value, err := control.Arg[float64](args, name)
		if err != nil {
			return Rect{}, err
		}
		*into = value
	}
	if rect.Width <= 0 || rect.Height <= 0 {
		return Rect{}, fmt.Errorf(
			"a capture region needs a positive size; %gx%g would answer with the whole window",
			rect.Width, rect.Height)
	}
	return rect, nil
}
