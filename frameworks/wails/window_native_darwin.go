//go:build darwin

package wails

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework AppKit
#include <stdlib.h>
#include "window_native_darwin.h"
*/
import "C"

import (
	"strconv"
	"sync"
	"unsafe"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

func applyNativeDecorations(window unsafe.Pointer, decorations []preparedNativeDecoration) (bool, int, error) {
	var native *C.SoksakNativeDecoration
	allocations := make([]unsafe.Pointer, 0, 1+len(decorations)*3)
	if len(decorations) > 0 {
		memory := C.malloc(C.size_t(len(decorations)) * C.size_t(C.sizeof_SoksakNativeDecoration))
		if memory == nil {
			return true, 0, i18n.Errorf("wails.decoration.allocation", map[string]string{"kind": "snapshot"})
		}
		allocations = append(allocations, memory)
		native = (*C.SoksakNativeDecoration)(memory)
		rows := unsafe.Slice(native, len(decorations))
		for index, decoration := range decorations {
			identifier := C.CString(decoration.ID)
			allocations = append(allocations, unsafe.Pointer(identifier))
			rows[index].identifier = identifier
			rows[index].strokeR = C.double(decoration.StrokeR)
			rows[index].strokeG = C.double(decoration.StrokeG)
			rows[index].strokeB = C.double(decoration.StrokeB)
			rows[index].strokeA = C.double(decoration.StrokeA)
			rows[index].strokeWidth = C.double(decoration.StrokeWidth)
			rows[index].commandCount = C.int(len(decoration.commands))
			commandMemory := C.malloc(C.size_t(len(decoration.commands)) * C.size_t(C.sizeof_SoksakNativePathCommand))
			if commandMemory == nil {
				for _, allocation := range allocations {
					C.free(allocation)
				}
				return true, 0, i18n.Errorf("wails.decoration.allocation", map[string]string{"kind": "path"})
			}
			allocations = append(allocations, commandMemory)
			rows[index].commands = (*C.SoksakNativePathCommand)(commandMemory)
			commands := unsafe.Slice((*C.SoksakNativePathCommand)(commandMemory), len(decoration.commands))
			for commandIndex, command := range decoration.commands {
				commands[commandIndex] = C.SoksakNativePathCommand{
					op: C.int(command.op), x1: C.double(command.x1), y1: C.double(command.y1),
					x2: C.double(command.x2), y2: C.double(command.y2),
				}
			}
			rows[index].dashCount = C.int(len(decoration.Dash))
			if len(decoration.Dash) > 0 {
				dashMemory := C.malloc(C.size_t(len(decoration.Dash)) * C.size_t(C.sizeof_double))
				if dashMemory == nil {
					for _, allocation := range allocations {
						C.free(allocation)
					}
					return true, 0, i18n.Errorf("wails.decoration.allocation", map[string]string{"kind": "dash"})
				}
				allocations = append(allocations, dashMemory)
				rows[index].dash = (*C.double)(dashMemory)
				dash := unsafe.Slice((*C.double)(dashMemory), len(decoration.Dash))
				for dashIndex, value := range decoration.Dash {
					dash[dashIndex] = C.double(value)
				}
			}
		}
	}
	defer func() {
		for _, allocation := range allocations {
			C.free(allocation)
		}
	}()
	var applied C.int
	if status := C.soksakApplyNativeDecorations(window, native, C.int(len(decorations)), &applied); status != 0 {
		return true, 0, i18n.Errorf("wails.decoration.nativeRefused", map[string]string{"status": strconv.Itoa(int(status))})
	}
	return true, int(applied), nil
}

var windowInputMonitorOwner struct {
	sync.RWMutex
	monitor *windowInputMonitor
	token   unsafe.Pointer
}

//export soksakWindowInputPointer
func soksakWindowInputPointer(window unsafe.Pointer, sequence C.ulonglong, phase C.int, x, y, atUnixMs C.double) {
	windowInputMonitorOwner.RLock()
	monitor := windowInputMonitorOwner.monitor
	windowInputMonitorOwner.RUnlock()
	if monitor == nil {
		return
	}
	edge := "down"
	switch phase {
	case 1:
		edge = "up"
	case 2:
		edge = "move"
	}
	monitor.enqueue(windowPointerEnvelope{
		native: uintptr(window), sequence: uint64(sequence), phase: edge, source: "system",
		x: float64(x), y: float64(y), atUnixMs: float64(atUnixMs),
	})
}

//export soksakWindowNativeClosePointer
func soksakWindowNativeClosePointer(window unsafe.Pointer, sequence C.ulonglong, phase C.int, x, y, atUnixMs C.double) C.bool {
	windowInputMonitorOwner.RLock()
	monitor := windowInputMonitorOwner.monitor
	windowInputMonitorOwner.RUnlock()
	if monitor == nil {
		return C.bool(false)
	}
	edge := "down"
	if phase == 1 {
		edge = "up"
	}
	accepted := monitor.enqueueNativeClose(windowPointerEnvelope{
		native: uintptr(window), sequence: uint64(sequence), phase: edge, source: "system",
		x: float64(x), y: float64(y), atUnixMs: float64(atUnixMs), nativeClose: true,
	})
	return C.bool(accepted)
}

func installWindowInputMonitor(monitor *windowInputMonitor) {
	windowInputMonitorOwner.Lock()
	defer windowInputMonitorOwner.Unlock()
	if windowInputMonitorOwner.monitor != nil {
		panic("wails: a window input monitor is already installed")
	}
	windowInputMonitorOwner.monitor = monitor
	windowInputMonitorOwner.token = C.soksakInstallWindowInputMonitor()
	if windowInputMonitorOwner.token == nil {
		windowInputMonitorOwner.monitor = nil
		panic("wails: AppKit refused the window input monitor")
	}
}

func removeWindowInputMonitor(monitor *windowInputMonitor) {
	windowInputMonitorOwner.Lock()
	defer windowInputMonitorOwner.Unlock()
	if windowInputMonitorOwner.monitor != monitor {
		return
	}
	C.soksakRemoveWindowInputMonitor(windowInputMonitorOwner.token)
	windowInputMonitorOwner.token = nil
	windowInputMonitorOwner.monitor = nil
}

// orderWindowFrontWithoutKey brings a window forward and leaves the keyboard
// where it is. The caller is on the main thread.
func orderWindowFrontWithoutKey(window unsafe.Pointer) error {
	if window == nil {
		// A nil window here is a window with no native lifetime, and ordering
		// nothing forward would report a reveal that never happened.
		return i18n.Errorf("wails.window.noNativeLifetimeFront", nil)
	}
	C.soksakOrderFrontRegardless(window)
	return nil
}

// presentCaptureOnlyWindow keeps WebKit's public display clock alive while
// AppKit keeps the window transparent, mouse-transparent and non-key.
func presentCaptureOnlyWindow(window unsafe.Pointer) error {
	if window == nil {
		return i18n.Errorf("wails.window.noNativeLifetimeFront", nil)
	}
	C.soksakPresentCaptureOnlyWindow(window)
	return nil
}

// activateApplication brings this application forward. The caller is on the
// main thread.
func activateApplication() error {
	if !bool(C.soksakActivateApplication()) {
		// Named rather than silently ignored: the caller asked for the
		// application to come forward, and a quiet success here would be
		// followed by a window that is in front and receives no keys.
		return i18n.Errorf("wails.app.noActivationRequest", nil)
	}
	return nil
}

// ForegroundProcessID returns the application that receives input without using Apple Events.
func ForegroundProcessID() int {
	return int(C.soksakFrontmostProcessID())
}

// nativeWindowTitle copies a window's title. The caller is on the main thread.
//
// The frontend writes its boot progress here, and that channel survives a dead
// binding path — so a window that answers nothing else still reports how far it
// got. The framework only sets titles, so this is the read half.
func nativeWindowTitle(window unsafe.Pointer) (string, error) {
	if window == nil {
		return "", i18n.Errorf("wails.window.noNativeLifetimeTitle", nil)
	}
	copied := C.soksakCopyWindowTitle(window)
	if copied == nil {
		// Distinct from an empty title: one window has never been given a name
		// and the other was given "".
		return "", i18n.Errorf("wails.window.noTitle", nil)
	}
	defer C.free(unsafe.Pointer(copied))
	return C.GoString(copied), nil
}

// contentSize answers the area a document occupies, in device-independent
// points. The caller is on the main thread.
//
// Fractional: a window on a scaled display has a fractional content size, and
// truncating it here would answer a size no document ever had.
func contentSize(window unsafe.Pointer) (float64, float64, error) {
	if window == nil {
		return 0, 0, i18n.Errorf("wails.window.noNativeLifetimeContent", nil)
	}
	var width, height C.double
	C.soksakWindowContentSize(window, &width, &height)
	return float64(width), float64(height), nil
}

// webviewFrame answers where the document's view is inside the window, in
// device-independent points. The caller is on the main thread.
//
// A negative size means no such view was found, which is a different answer
// from a view of no size.
func webviewFrame(window unsafe.Pointer) (x, y, width, height float64, err error) {
	if window == nil {
		return 0, 0, 0, 0, i18n.Errorf("wails.window.noNativeLifetimeView", nil)
	}
	var cx, cy, cw, ch C.double
	C.soksakWebviewFrame(window, &cx, &cy, &cw, &ch)
	if float64(cw) < 0 {
		return 0, 0, 0, 0, i18n.Errorf("wails.window.noWebView", nil)
	}
	return float64(cx), float64(cy), float64(cw), float64(ch), nil
}

// fitWebviewToWindow makes the document's view exactly as large as the area it
// can be seen in. The caller is on the main thread.
func fitWebviewToWindow(window unsafe.Pointer) error {
	if window == nil {
		return i18n.Errorf("wails.window.noNativeLifetimeViewToFit", nil)
	}
	C.soksakFitWebviewToWindow(window)
	return nil
}

// windowPresence reads whether this window is putting light on the screen. The
// caller is on the main thread.
func windowPresence(window unsafe.Pointer) WindowPresence {
	if window == nil {
		return WindowPresence{}
	}
	read := C.soksakWindowPresence(window)
	return WindowPresence{
		Known:        true,
		Visible:      bool(read.visible),
		Key:          bool(read.key),
		Main:         bool(read.principal),
		Miniaturized: bool(read.miniaturized),
		Occluded:     bool(read.occluded),
		Alpha:        float64(read.alpha),
	}
}

func windowInputState(window unsafe.Pointer) (WindowInputState, error) {
	read := C.soksakWindowInputState(window)
	defer freeWindowInputState(read)
	if read.errorMessage != nil {
		return WindowInputState{}, i18n.Errorf("wails.input.stateFailed", map[string]string{"reason": C.GoString(read.errorMessage)})
	}
	return WindowInputState{
		WindowFocused:   bool(read.windowFocused),
		InputOwner:      C.GoString(read.inputOwner),
		ResponderMarked: bool(read.marked),
	}, nil
}

func setWindowMarkedText(window unsafe.Pointer, text string) (WindowInputState, error) {
	nativeText := C.CString(text)
	defer C.free(unsafe.Pointer(nativeText))
	read := C.soksakSetWindowMarkedText(window, nativeText)
	defer freeWindowInputState(read)
	if read.errorMessage != nil {
		return WindowInputState{}, i18n.Errorf("wails.input.markFailed", map[string]string{"reason": C.GoString(read.errorMessage)})
	}
	return WindowInputState{
		WindowFocused:   bool(read.windowFocused),
		InputOwner:      C.GoString(read.inputOwner),
		ResponderMarked: bool(read.marked),
	}, nil
}

func clickWindowPointer(window unsafe.Pointer, sequence uint64, x, y float64) (bool, bool, bool, error) {
	read := C.soksakClickWindowPointer(window, C.ulonglong(sequence), C.double(x), C.double(y))
	defer C.free(unsafe.Pointer(read.errorMessage))
	if read.errorMessage != nil {
		return false, bool(read.windowFocused), bool(read.foregroundPreserved), i18n.Errorf("wails.input.nativeDeliveryFailed", map[string]string{"reason": C.GoString(read.errorMessage)})
	}
	return bool(read.delivered), bool(read.windowFocused), bool(read.foregroundPreserved), nil
}

func pressWindowKey(window unsafe.Pointer, sequence uint64, key string, ctrl, meta, shift, alt bool) (bool, bool, bool, error) {
	nativeKey := C.CString(key)
	defer C.free(unsafe.Pointer(nativeKey))
	read := C.soksakPressWindowKey(
		window, C.ulonglong(sequence), nativeKey,
		C.bool(ctrl), C.bool(meta), C.bool(shift), C.bool(alt),
	)
	defer C.free(unsafe.Pointer(read.errorMessage))
	if read.errorMessage != nil {
		return false, bool(read.windowFocused), bool(read.foregroundPreserved), i18n.Errorf("wails.input.nativeDeliveryFailed", map[string]string{"reason": C.GoString(read.errorMessage)})
	}
	return bool(read.delivered), bool(read.windowFocused), bool(read.foregroundPreserved), nil
}

func nativeCloseStatus(window unsafe.Pointer) (NativeCloseStatus, error) {
	if window == nil {
		return NativeCloseStatus{}, i18n.Errorf("wails.window.noNativeClose", nil)
	}
	read := C.soksakNativeCloseStatus(window)
	if !bool(read.present) {
		return NativeCloseStatus{}, i18n.Errorf("wails.window.noNativeClose", nil)
	}
	return NativeCloseStatus{
		Present: true, Enabled: bool(read.enabled), Visible: bool(read.visible),
		WindowVisible: bool(read.windowVisible), X: float64(read.x), Y: float64(read.y),
		Width: float64(read.width), Height: float64(read.height),
	}, nil
}

func clickNativeClose(window unsafe.Pointer, sequence uint64) (bool, error) {
	status, err := nativeCloseStatus(window)
	if err != nil {
		return false, err
	}
	if !status.Enabled || !status.Visible {
		return false, i18n.Errorf("wails.window.nativeCloseDisabled", nil)
	}
	if !bool(C.soksakClickNativeClose(window, C.ulonglong(sequence))) {
		return false, i18n.Errorf("wails.window.nativeCloseClickFailed", nil)
	}
	return true, nil
}

func freeWindowInputState(read C.SoksakWindowInputState) {
	C.free(unsafe.Pointer(read.inputOwner))
	C.free(unsafe.Pointer(read.errorMessage))
}
