package wails

import (
	"strconv"
	"time"

	"github.com/soksak-ai/soksak-core/core/control"
	"github.com/soksak-ai/soksak-core/core/i18n"
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

type NativeCloseStatus struct {
	Window        string  `json:"window"`
	Present       bool    `json:"present"`
	Enabled       bool    `json:"enabled"`
	Visible       bool    `json:"visible"`
	WindowVisible bool    `json:"windowVisible"`
	X             float64 `json:"x"`
	Y             float64 `json:"y"`
	Width         float64 `json:"width"`
	Height        float64 `json:"height"`
}

type NativeCloseClickReceipt struct {
	Window   string `json:"window"`
	Sequence uint64 `json:"sequence"`
	Posted   bool   `json:"posted"`
	Tracked  bool   `json:"tracked"`
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

// WindowPointerClickReceipt records a native-window mouse down/up pair. The
// route names the platform boundary that accepted the pair; it is never a DOM
// event-dispatch alias.
type WindowPointerClickReceipt struct {
	Window                  string  `json:"window"`
	Sequence                uint64  `json:"sequence"`
	Delivered               bool    `json:"delivered"`
	InputRoute              string  `json:"inputRoute"`
	CursorPositionMayChange bool    `json:"cursorPositionMayChange"`
	X                       float64 `json:"x"`
	Y                       float64 `json:"y"`
	WindowFocused           bool    `json:"windowFocused"`
}

// WindowKeyPressReceipt records one native-window key down/up pair.
type WindowKeyPressReceipt struct {
	Window        string `json:"window"`
	Sequence      uint64 `json:"sequence"`
	Delivered     bool   `json:"delivered"`
	InputRoute    string `json:"inputRoute"`
	Key           string `json:"key"`
	WindowFocused bool   `json:"windowFocused"`
}

// WindowInputHost provides keyboard composition and pointer event diagnostics.
// Platform handles do not cross this interface.
type WindowInputHost interface {
	InputState(window string) (WindowInputState, error)
	SetMarkedText(window, text string) (WindowInputState, error)
	InjectInputPointer(window string, x, y float64) (WindowPointerInjectionReceipt, error)
	ClickInputPointer(window string, x, y float64) (WindowPointerClickReceipt, error)
	PressInputKey(window, key string, ctrl, meta, shift, alt bool) (WindowKeyPressReceipt, error)
	WaitInputPointer(sequence uint64, timeout time.Duration) (WindowPointerReceipt, error)
	NativeCloseStatus(window string) (NativeCloseStatus, error)
	ClickNativeClose(window string) (NativeCloseClickReceipt, error)
	WaitNativeClose(sequence uint64, timeout time.Duration) (NativeCloseOutcome, error)
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
	registry.MustRegister(control.Command{Name: "window.input.pointer.click", Owner: control.OwnerFramework,
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
			return host.ClickInputPointer(name, x, y)
		},
	})
	registry.MustRegister(control.Command{Name: "window.input.key.press", Owner: control.OwnerFramework,
		Handler: func(args control.Args) (any, error) {
			name, err := window(args)
			if err != nil {
				return nil, err
			}
			key, err := control.Arg[string](args, "key")
			if err != nil {
				return nil, err
			}
			if key == "" {
				return nil, i18n.Errorf("wails.input.emptyKey", nil)
			}
			ctrl, err := control.OptionalArg[bool](args, "ctrl", false)
			if err != nil {
				return nil, err
			}
			meta, err := control.OptionalArg[bool](args, "meta", false)
			if err != nil {
				return nil, err
			}
			shift, err := control.OptionalArg[bool](args, "shift", false)
			if err != nil {
				return nil, err
			}
			alt, err := control.OptionalArg[bool](args, "alt", false)
			if err != nil {
				return nil, err
			}
			return host.PressInputKey(name, key, ctrl, meta, shift, alt)
		},
	})
	registry.MustRegister(control.Command{Name: "window_native_close_status", Owner: control.OwnerFramework,
		Handler: func(args control.Args) (any, error) {
			name, err := window(args)
			if err != nil {
				return nil, err
			}
			return host.NativeCloseStatus(name)
		},
	})
	registry.MustRegister(control.Command{Name: "window_native_close_click", Owner: control.OwnerFramework,
		Handler: func(args control.Args) (any, error) {
			name, err := window(args)
			if err != nil {
				return nil, err
			}
			return host.ClickNativeClose(name)
		},
	})
	registry.MustRegister(control.Command{Name: "window_native_close_wait", Owner: control.OwnerFramework,
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
			return host.WaitNativeClose(sequence, time.Duration(timeoutMs)*time.Millisecond)
		},
	})
}
