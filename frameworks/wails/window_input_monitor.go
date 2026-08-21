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
	mu        sync.RWMutex
	active    bool
	last      *WindowPointerReceipt
	delivered map[string]struct{}
	lookup    func(native uintptr) string
	dispatch  func(window, event string, payload any) error
	queue     chan windowPointerEnvelope
	worker    sync.WaitGroup
	dropped   atomic.Uint64
	waiters   map[uint64][]chan WindowPointerReceipt
}

type windowPointerEnvelope struct {
	native   uintptr
	sequence uint64
	phase    string
	source   string
	x        float64
	y        float64
	atUnixMs float64
}

func newWindowInputMonitor(
	lookup func(native uintptr) string,
	dispatch func(window, event string, payload any) error,
) *windowInputMonitor {
	if lookup == nil || dispatch == nil {
		panic("wails: window input monitor needs lookup and dispatch")
	}
	return &windowInputMonitor{
		delivered: map[string]struct{}{},
		lookup:    lookup,
		dispatch:  dispatch,
		queue:     make(chan windowPointerEnvelope, 128),
		waiters:   map[uint64][]chan WindowPointerReceipt{},
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
	}
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
