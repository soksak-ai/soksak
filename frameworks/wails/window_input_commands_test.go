package wails

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/soksak-ai/soksak-core/core/control"
)

type inputHostFixture struct {
	window string
	marked string
}

func (h *inputHostFixture) InputState(window string) (WindowInputState, error) {
	h.window = window
	return WindowInputState{WindowFocused: true, InputOwner: "web-content", ResponderMarked: h.marked != ""}, nil
}

func (h *inputHostFixture) SetMarkedText(window, text string) (WindowInputState, error) {
	h.window = window
	h.marked = text
	return WindowInputState{WindowFocused: true, InputOwner: "web-content", ResponderMarked: text != ""}, nil
}

func (h *inputHostFixture) WaitInputPointer(sequence uint64, _ time.Duration) (WindowPointerReceipt, error) {
	return WindowPointerReceipt{Sequence: sequence, Phase: "up", Window: h.window}, nil
}

func (h *inputHostFixture) InjectInputPointer(window string, x, y float64) (WindowPointerInjectionReceipt, error) {
	h.window = window
	return WindowPointerInjectionReceipt{Sequence: 9, Posted: true, InputRoute: "contract-injection", X: x, Y: y}, nil
}

func (h *inputHostFixture) NativeCloseStatus(window string) (NativeCloseStatus, error) {
	h.window = window
	return NativeCloseStatus{Window: window, Present: true, Enabled: true, Visible: true}, nil
}

func (h *inputHostFixture) ClickNativeClose(window string) (NativeCloseClickReceipt, error) {
	h.window = window
	return NativeCloseClickReceipt{Window: window, Sequence: 10, Posted: true, Tracked: true}, nil
}
func (h *inputHostFixture) WaitNativeClose(sequence uint64, _ time.Duration) (NativeCloseOutcome, error) {
	return NativeCloseOutcome{Window: h.window, Sequence: sequence, Closed: true}, nil
}

func TestWindowInputCommandsUseTheNamedWindowAndExposeDeliveryReceipts(t *testing.T) {
	registry := control.NewRegistry()
	host := &inputHostFixture{}
	RegisterWindowInput(registry, host)

	caller := control.Args{control.CallerWindowArgument: jsonString("win-a")}
	if answer, err := registry.Invoke("window.input.mark", mergeControlArgs(caller, control.Args{"text": jsonString("x")})); err != nil {
		t.Fatalf("mark: %v", err)
	} else if !answer.(WindowInputState).ResponderMarked {
		t.Fatalf("marked state was not exposed: %+v", answer)
	}
	answer, err := registry.Invoke("window.input.pointer.inject", mergeControlArgs(caller, control.Args{"x": json.RawMessage("40"), "y": json.RawMessage("60")}))
	if err != nil {
		t.Fatalf("inject: %v", err)
	}
	receipt := answer.(WindowPointerInjectionReceipt)
	if host.window != "win-a" || receipt.Sequence != 9 || !receipt.Posted || receipt.X != 40 || receipt.Y != 60 {
		t.Fatalf("injection receipt lost request facts: window=%q receipt=%+v", host.window, receipt)
	}
	waited, err := registry.Invoke("window.input.pointer.wait", control.Args{
		"sequence": json.RawMessage("9"), "timeoutMs": json.RawMessage("2000"),
	})
	if err != nil || waited.(WindowPointerReceipt).Phase != "up" {
		t.Fatalf("pointer wait = %+v, %v", waited, err)
	}
}

func TestWindowInputCommandsExposeNativeControlStatusAndClick(t *testing.T) {
	registry := control.NewRegistry()
	RegisterWindowInput(registry, &inputHostFixture{})
	served := map[string]bool{}
	for _, command := range registry.Describe().Commands {
		served[command.Name] = true
	}
	for _, name := range []string{"window_native_close_status", "window_native_close_click", "window_native_close_wait"} {
		if !served[name] {
			t.Errorf("%s is not exposed", name)
		}
	}
}

func mergeControlArgs(left, right control.Args) control.Args {
	out := control.Args{}
	for key, value := range left {
		out[key] = value
	}
	for key, value := range right {
		out[key] = value
	}
	return out
}
