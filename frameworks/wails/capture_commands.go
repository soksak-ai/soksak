package wails

import (
	"fmt"
	"unsafe"

	"github.com/soksak-ai/soksak-core/core/control"
	"github.com/soksak-ai/soksak-core/core/i18n"
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
//
// Interactive mode reads the window's compositor pixels. Capture-only mode keeps an alpha-zero
// window resident for its display clock and reads the main document, declaring documentOnly=true;
// neither path changes WebKit scheduling or draws replacement pixels into the answer.
func RegisterCapture(registry *control.Registry, host WindowHost, frames StreamSink, presentation PresentationMode) {
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
		return NewCaptureService(name, func() unsafe.Pointer { return handle }, presentation), nil
	}

	registry.MustRegister(control.Command{
		Name:  "window_capture_present",
		Owner: control.OwnerFramework,
		Handler: func(args control.Args) (any, error) {
			service, err := target(args)
			if err != nil {
				return nil, err
			}
			handle, err := service.target()
			if err != nil {
				return nil, err
			}
			return map[string]any{"ordered": PresentWindowForCapture(handle)}, nil
		},
	})

	registry.MustRegister(control.Command{
		Name:  "window_capture_restore",
		Owner: control.OwnerFramework,
		Handler: func(args control.Args) (any, error) {
			ordered, err := control.Arg[bool](args, "ordered")
			if err != nil {
				return nil, err
			}
			service, err := target(args)
			if err != nil {
				return nil, err
			}
			handle, err := service.target()
			if err != nil {
				return nil, err
			}
			RestoreWindowAfterCapture(handle, ordered)
			return map[string]any{"restored": ordered}, nil
		},
	})

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
		// The image comes back rather than going to a file, because the callers
		// that crop are measuring: a tab capture hands the bytes to a writer of
		// its own, and a pixel measurement never wants a file at all. A path is
		// therefore optional, and given, the file is written as well as answered
		// — the two are separate axes and compose freely.
		Handler: func(args control.Args) (any, error) {
			path, err := control.OptionalArg(args, "path", "")
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
			return service.PixelsAt(path, rect)
		},
	})

	registry.MustRegister(control.Command{
		Name:  "window_record",
		Owner: control.OwnerFramework,
		// The same window axis and the same region axis as a single capture, so
		// a burst of the whole window and a burst of one tab are one command
		// with a different rect. A separate recording command would resolve the
		// region a second way, and the day the two disagree the recording is of
		// somewhere else than the snapshot beside it.
		Handler: func(args control.Args) (any, error) {
			dir, err := control.Arg[string](args, "dir")
			if err != nil {
				return nil, err
			}
			count, err := control.Arg[float64](args, "frames")
			if err != nil {
				return nil, err
			}
			interval, err := control.OptionalArg(args, "intervalMs", float64(0))
			if err != nil {
				return nil, err
			}
			maxBytes, err := control.OptionalArg(args, "maxBytes", float64(0))
			if err != nil {
				return nil, err
			}
			frameTimeout, err := control.OptionalArg(args, "frameTimeoutMs", float64(0))
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
			// A receiver is optional. The frames land on disk either way; without one
			// a caller reads the count in the report instead of a clock.
			if stream, streamErr := control.StreamArg(args, "onFrame"); streamErr == nil && frames != nil {
				service.frames = func(index int) { frames(stream, index) }
			}
			return service.Record(RecordRequest{
				Dir:            dir,
				Frames:         int(count),
				IntervalMs:     int(interval),
				MaxBytes:       int64(maxBytes),
				Region:         rect,
				FrameTimeoutMs: int(frameTimeout),
			})
		},
	})
}

// captureRect reads a window-relative rect in CSS points.
//
// The keys are x, y, w and h because they are the caller's, not this package's:
// the page measures a node and hands over w and h, the same spelling a surface
// frame already travels in. Reading width and height here made every region
// caller — a tab capture, a pixel measurement, a recording — fail on a missing
// argument, and the answer they received named neither the key nor the command
// (measured 2026-08-16 on the running application: INTERNAL, three times).
//
// No region at all is the whole window: that is how the callers ask for one.
// A region half named is a mistake rather than a request, because the component
// left out would decode as zero — a legitimate origin and an impossible size.
//
// A region of zero area is refused rather than quietly widened to the whole
// window: those are different requests, and a caller who asked for a region and
// received the window would compare the wrong pixels.
func captureRect(args control.Args) (Rect, error) {
	named := 0
	for _, name := range []string{"x", "y", "w", "h"} {
		if _, given := args[name]; given {
			named++
		}
	}
	if named == 0 {
		return Whole, nil
	}

	var rect Rect
	for name, into := range map[string]*float64{
		"x": &rect.X, "y": &rect.Y, "w": &rect.Width, "h": &rect.Height,
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
