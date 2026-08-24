package wails

import (
	"fmt"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

const windowInputPointerEvent = "window.input.pointer"
const windowNativeCloseEvent = "window.native-close-requested"

// WindowPointerReceipt records a pointer edge before WebKit processes DOM delivery.
// Sequence identifies one down/up pair.
type WindowPointerReceipt struct {
	Sequence uint64  `json:"sequence"`
	Phase    string  `json:"phase"`
	Source   string  `json:"source"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
	AtUnixMs float64 `json:"atUnixMs"`
	Window   string  `json:"window"`
}

type windowInputMonitor struct {
	mu             sync.RWMutex
	active         bool
	last           *WindowPointerReceipt
	delivered      map[string]struct{}
	lookup         func(native uintptr) string
	dispatch       func(window, event string, payload any) error
	queue          chan windowPointerEnvelope
	worker         sync.WaitGroup
	dropped        atomic.Uint64
	waiters        map[uint64][]chan WindowPointerReceipt
	closePending   map[string]NativeCloseRequest
	closeExpected  map[uint64]NativeCloseRequest
	closeCompleted map[uint64]NativeCloseOutcome
}

type windowPointerEnvelope struct {
	native      uintptr
	sequence    uint64
	phase       string
	source      string
	x           float64
	y           float64
	atUnixMs    float64
	nativeClose bool
}

type NativeCloseRequest struct {
	Window   string  `json:"window"`
	Sequence uint64  `json:"sequence"`
	AtUnixMs float64 `json:"atUnixMs"`
}

type NativeCloseOutcome struct {
	Window   string `json:"window"`
	Sequence uint64 `json:"sequence"`
	Closed   bool   `json:"closed"`
}

func newWindowInputMonitor(
	lookup func(native uintptr) string,
	dispatch func(window, event string, payload any) error,
) *windowInputMonitor {
	if lookup == nil || dispatch == nil {
		panic("wails: window input monitor needs lookup and dispatch")
	}
	return &windowInputMonitor{
		delivered:      map[string]struct{}{},
		lookup:         lookup,
		dispatch:       dispatch,
		queue:          make(chan windowPointerEnvelope, 128),
		waiters:        map[uint64][]chan WindowPointerReceipt{},
		closePending:   map[string]NativeCloseRequest{},
		closeExpected:  map[uint64]NativeCloseRequest{},
		closeCompleted: map[uint64]NativeCloseOutcome{},
	}
}

func (monitor *windowInputMonitor) start() {
	monitor.mu.Lock()
	if monitor.active {
		monitor.mu.Unlock()
		return
	}
	monitor.active = true
	monitor.worker.Add(1)
	go monitor.run()
	monitor.mu.Unlock()
	installWindowInputMonitor(monitor)
}

func (monitor *windowInputMonitor) run() {
	defer monitor.worker.Done()
	for edge := range monitor.queue {
		_ = monitor.deliverWithSource(edge.native, edge.sequence, edge.phase, edge.source, edge.x, edge.y, edge.atUnixMs)
		if edge.nativeClose && edge.phase == "up" {
			_ = monitor.requestNativeClose(edge.native, edge.sequence, edge.atUnixMs)
		}
	}
}

func (monitor *windowInputMonitor) enqueueNativeClose(edge windowPointerEnvelope) bool {
	monitor.mu.RLock()
	defer monitor.mu.RUnlock()
	if !monitor.active {
		return false
	}
	edge.nativeClose = true
	select {
	case monitor.queue <- edge:
		return true
	default:
		monitor.dropped.Add(1)
		return false
	}
}

func (monitor *windowInputMonitor) requestNativeClose(native uintptr, sequence uint64, atUnixMs float64) error {
	window := monitor.lookup(native)
	if window == "" {
		return i18n.Errorf("wails.input.windowUnknown", nil)
	}
	request := NativeCloseRequest{Window: window, Sequence: sequence, AtUnixMs: atUnixMs}
	monitor.expectNativeClose(request)
	return monitor.dispatch(window, windowNativeCloseEvent, request)
}

func (monitor *windowInputMonitor) expectNativeClose(request NativeCloseRequest) {
	monitor.mu.Lock()
	monitor.closePending[request.Window] = request
	monitor.closeExpected[request.Sequence] = request
	monitor.mu.Unlock()
}

func (monitor *windowInputMonitor) nativeCloseExpectation(sequence uint64) (NativeCloseOutcome, bool) {
	monitor.mu.RLock()
	defer monitor.mu.RUnlock()
	if outcome, found := monitor.closeCompleted[sequence]; found {
		return outcome, true
	}
	if request, found := monitor.closeExpected[sequence]; found {
		return NativeCloseOutcome{Window: request.Window, Sequence: sequence}, true
	}
	for _, request := range monitor.closePending {
		if request.Sequence == sequence {
			return NativeCloseOutcome{Window: request.Window, Sequence: sequence}, true
		}
	}
	return NativeCloseOutcome{}, false
}

func (monitor *windowInputMonitor) finishNativeClose(outcome NativeCloseOutcome) {
	monitor.mu.Lock()
	delete(monitor.closePending, outcome.Window)
	delete(monitor.closeExpected, outcome.Sequence)
	delete(monitor.closeCompleted, outcome.Sequence)
	monitor.mu.Unlock()
}

func (monitor *windowInputMonitor) nativeCloseWindowGone(window string) {
	monitor.mu.Lock()
	request, found := monitor.closePending[window]
	if !found {
		monitor.mu.Unlock()
		return
	}
	delete(monitor.closePending, window)
	outcome := NativeCloseOutcome{Window: window, Sequence: request.Sequence, Closed: false}
	monitor.closeCompleted[request.Sequence] = outcome
	monitor.mu.Unlock()
}

func (monitor *windowInputMonitor) drain() int {
	monitor.mu.Lock()
	if !monitor.active {
		monitor.mu.Unlock()
		return 0
	}
	monitor.mu.Unlock()
	removeWindowInputMonitor(monitor)
	monitor.mu.Lock()
	monitor.active = false
	close(monitor.queue)
	monitor.mu.Unlock()
	monitor.worker.Wait()
	return 1
}

// enqueue is the only operation performed inside the platform's physical
// input callback. It never dispatches into a webview and never waits for one.
func (monitor *windowInputMonitor) enqueue(edge windowPointerEnvelope) {
	monitor.mu.RLock()
	defer monitor.mu.RUnlock()
	if !monitor.active {
		return
	}
	select {
	case monitor.queue <- edge:
	default:
		// A saturated consumer must not freeze physical input. The loss is a
		// public counter rather than a silent drop.
		monitor.dropped.Add(1)
	}
}

func (monitor *windowInputMonitor) latest() *WindowPointerReceipt {
	monitor.mu.RLock()
	defer monitor.mu.RUnlock()
	if monitor.last == nil {
		return nil
	}
	copy := *monitor.last
	return &copy
}

func (monitor *windowInputMonitor) queueState() (queued int, dropped uint64) {
	return len(monitor.queue), monitor.dropped.Load()
}

func (monitor *windowInputMonitor) waitForUp(sequence uint64, timeout time.Duration) (WindowPointerReceipt, error) {
	ready := make(chan WindowPointerReceipt, 1)
	monitor.mu.Lock()
	if monitor.last != nil && monitor.last.Sequence == sequence && monitor.last.Phase == "up" {
		receipt := *monitor.last
		monitor.mu.Unlock()
		return receipt, nil
	}
	monitor.waiters[sequence] = append(monitor.waiters[sequence], ready)
	monitor.mu.Unlock()

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case receipt := <-ready:
		return receipt, nil
	case <-timer.C:
		monitor.mu.Lock()
		waiting := monitor.waiters[sequence]
		for index, waiter := range waiting {
			if waiter == ready {
				waiting = append(waiting[:index], waiting[index+1:]...)
				break
			}
		}
		if len(waiting) == 0 {
			delete(monitor.waiters, sequence)
		} else {
			monitor.waiters[sequence] = waiting
		}
		monitor.mu.Unlock()
		return WindowPointerReceipt{}, i18n.Errorf("wails.input.pointerTimeout", map[string]string{"sequence": strconv.FormatUint(sequence, 10), "timeout": timeout.String()})
	}
}

func (monitor *windowInputMonitor) deliver(native uintptr, sequence uint64, phase string, x, y, atUnixMs float64) error {
	return monitor.deliverWithSource(native, sequence, phase, "system", x, y, atUnixMs)
}

func (monitor *windowInputMonitor) deliverWithSource(native uintptr, sequence uint64, phase, source string, x, y, atUnixMs float64) error {
	if phase != "down" && phase != "up" {
		return i18n.Errorf("wails.input.invalidPhase", map[string]string{"phase": phase})
	}
	window := monitor.lookup(native)
	if window == "" {
		return i18n.Errorf("wails.input.windowUnknown", nil)
	}
	receipt := WindowPointerReceipt{
		Sequence: sequence,
		Phase:    phase,
		Source:   source,
		X:        x,
		Y:        y,
		AtUnixMs: atUnixMs,
		Window:   window,
	}
	key := fmt.Sprintf("%d/%s", sequence, phase)
	monitor.mu.Lock()
	if !monitor.active {
		monitor.mu.Unlock()
		return i18n.Errorf("wails.input.monitorInactive", nil)
	}
	if _, duplicate := monitor.delivered[key]; duplicate {
		monitor.mu.Unlock()
		return nil
	}
	monitor.delivered[key] = struct{}{}
	// A sequence has only two edges. Once an up arrives, older keys no longer
	// participate in idempotency and can be discarded without a growing ledger.
	if phase == "up" {
		for prior := range monitor.delivered {
			if prior != key {
				delete(monitor.delivered, prior)
			}
		}
	}
	monitor.last = &receipt
	waiters := []chan WindowPointerReceipt(nil)
	if phase == "up" {
		waiters = monitor.waiters[sequence]
		delete(monitor.waiters, sequence)
	}
	monitor.mu.Unlock()
	for _, waiter := range waiters {
		waiter <- receipt
	}
	return monitor.dispatch(window, windowInputPointerEvent, receipt)
}
