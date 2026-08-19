package wails

import (
	"strconv"
	"time"

	"github.com/soksak/soksak-core/core/control"
	"github.com/soksak/soksak-core/core/i18n"
)

// WindowInputState identifies the native object that currently owns keyboard
// input for one window. The names are deliberately platform-neutral: AppKit,
// Win32 and GTK answer this contract through separate adapters.
type WindowInputState struct {
	WindowFocused        bool                  `json:"windowFocused"`
	InputOwner           string                `json:"inputOwner"`
	ResponderMarked      bool                  `json:"responderMarked"`
	LastPointer          *WindowPointerReceipt `json:"lastPointer"`
	PointerEventsQueued  int                   `json:"pointerEventsQueued"`
	PointerEventsDropped uint64                `json:"pointerEventsDropped"`
}

// WindowPointerInjectionReceipt identifies one test event request.
type WindowPointerInjectionReceipt struct {
	Sequence                uint64  `json:"sequence"`
	Posted                  bool    `json:"posted"`
	InputRoute              string  `json:"inputRoute"`
	CursorPositionMayChange bool    `json:"cursorPositionMayChange"`
	X                       float64 `json:"x"`
	Y                       float64 `json:"y"`
	WindowFocused           bool    `json:"windowFocused"`
}

// WindowInputHost provides keyboard composition and pointer event diagnostics.
// Platform handles do not cross this interface.
type WindowInputHost interface {
	InputState(window string) (WindowInputState, error)
	SetMarkedText(window, text string) (WindowInputState, error)
	InjectInputPointer(window string, x, y float64) (WindowPointerInjectionReceipt, error)
	WaitInputPointer(sequence uint64, timeout time.Duration) (WindowPointerReceipt, error)
}

func RegisterWindowInput(registry *control.Registry, host WindowInputHost) {
	if host == nil {
		panic("wails: window input commands require a host")
	}
	window := func(args control.Args) (string, error) {
		name, err := surfaceWindow(args)
		if err != nil {
			return "", err
		}
		return name, nil
	}
	registry.MustRegister(control.Command{Name: "window.input.state", Owner: control.OwnerFramework,
		Handler: func(args control.Args) (any, error) {
			name, err := window(args)
			if err != nil {
				return nil, err
			}
			return host.InputState(name)
		},
	})
	registry.MustRegister(control.Command{Name: "window.input.mark", Owner: control.OwnerFramework,
		Handler: func(args control.Args) (any, error) {
			name, err := window(args)
			if err != nil {
				return nil, err
			}
			text, err := control.OptionalArg(args, "text", "")
			if err != nil {
				return nil, err
			}
			return host.SetMarkedText(name, text)
		},
	})
	registry.MustRegister(control.Command{Name: "window.input.pointer.wait", Owner: control.OwnerFramework,
		Handler: func(args control.Args) (any, error) {
			sequence, err := control.Arg[uint64](args, "sequence")
			if err != nil {
				return nil, err
			}
			timeoutMs, err := control.Arg[int](args, "timeoutMs")
			if err != nil {
				return nil, err
			}
			if timeoutMs < 1 || timeoutMs > 30000 {
				return nil, i18n.Errorf("wails.input.invalidTimeout", map[string]string{"timeout": strconv.Itoa(timeoutMs)})
			}
			return host.WaitInputPointer(sequence, time.Duration(timeoutMs)*time.Millisecond)
		},
	})
	registry.MustRegister(control.Command{Name: "window.input.pointer.inject", Owner: control.OwnerFramework,
		Handler: func(args control.Args) (any, error) {
			name, err := window(args)
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
			if x < 0 || y < 0 {
				return nil, i18n.Errorf("wails.input.negativeCoordinates", map[string]string{"x": strconv.FormatFloat(x, 'f', -1, 64), "y": strconv.FormatFloat(y, 'f', -1, 64)})
			}
			return host.InjectInputPointer(name, x, y)
		},
	})
}
