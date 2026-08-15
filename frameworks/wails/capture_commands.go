package wails

import (
	"fmt"

	"github.com/soksak/soksak-core/core/control"
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
func RegisterCapture(registry *control.Registry, service *CaptureService) {
	if service == nil {
		panic("wails: the capture commands need a capture service")
	}

	registry.MustRegister(control.Command{
		Name:  "window_snapshot",
		Owner: control.OwnerFramework,
		Handler: func(args control.Args) (any, error) {
			path, err := control.Arg[string](args, "path")
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
