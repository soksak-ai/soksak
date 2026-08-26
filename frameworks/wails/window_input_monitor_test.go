package wails

import "testing"
import "time"

func TestWindowInputMonitorPublishesOneObservableEdgePerNativeSequence(t *testing.T) {
	var events []WindowPointerReceipt
	monitor := newWindowInputMonitor(
		func(native uintptr) string {
			if native == 41 {
				return "win-a"
			}
			return ""
		},
		func(window, event string, payload any) error {
			if window != "win-a" || event != windowInputPointerEvent {
				t.Fatalf("dispatch = %s %s", window, event)
			}
			events = append(events, payload.(WindowPointerReceipt))
			return nil
		},
	)
	monitor.active = true

	for _, phase := range []string{"down", "down", "up", "up"} {
		if err := monitor.deliver(41, 7, phase, 20, 30, 1000); err != nil {
			t.Fatalf("deliver %s: %v", phase, err)
		}
	}
	if len(events) != 2 || events[0].Phase != "down" || events[1].Phase != "up" {
		t.Fatalf("events = %+v", events)
	}
	if latest := monitor.latest(); latest == nil || latest.Sequence != 7 || latest.Phase != "up" {
		t.Fatalf("latest = %+v", latest)
	}
}

func TestWindowInputClickWaitsForItsExactObservedMouseUp(t *testing.T) {
	monitor := newWindowInputMonitor(func(uintptr) string { return "win-a" }, func(string, string, any) error { return nil })
	monitor.active = true
	waiting := make(chan WindowPointerReceipt, 1)
	go func() {
		receipt, _ := monitor.waitForUp(91, time.Second)
		waiting <- receipt
	}()
	if err := monitor.deliver(1, 90, "up", 1, 2, 3); err != nil {
		t.Fatal(err)
	}
	select {
	case <-waiting:
		t.Fatal("another pointer sequence satisfied the click receipt")
	default:
	}
	if err := monitor.deliver(1, 91, "up", 4, 5, 6); err != nil {
		t.Fatal(err)
	}
	if receipt := <-waiting; receipt.Sequence != 91 || receipt.X != 4 {
		t.Fatalf("receipt = %+v", receipt)
	}
}

func TestPhysicalInputCallbackQueuesBeforeAnyWebviewDispatch(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	monitor := newWindowInputMonitor(
		func(uintptr) string { return "win-a" },
		func(string, string, any) error {
			close(started)
			<-release
			return nil
		},
	)
	monitor.active = true
	monitor.worker.Add(1)
	go monitor.run()

	// If enqueue dispatches inline this call never returns: dispatch is waiting
	// on release, which is closed only below.
	monitor.enqueue(windowPointerEnvelope{native: 1, sequence: 1, phase: "down"})
	<-started
	close(release)
	monitor.mu.Lock()
	monitor.active = false
	close(monitor.queue)
	monitor.mu.Unlock()
	monitor.worker.Wait()
}

func TestNativeClosePointerWaitsForWindowDestruction(t *testing.T) {
	var monitor *windowInputMonitor
	closed := make(chan struct{})
	monitor = newWindowInputMonitor(
		func(uintptr) string { return "win-a" },
		func(window, event string, payload any) error {
			if event == windowNativeCloseEvent {
				request := payload.(NativeCloseRequest)
				if window != request.Window || request.Sequence != 44 {
					t.Fatalf("native close request=%+v window=%s", request, window)
				}
				monitor.nativeCloseWindowGone(window)
				close(closed)
			}
			return nil
		},
	)
	monitor.active = true
	monitor.worker.Add(1)
	go monitor.run()
	if !monitor.enqueueNativeClose(windowPointerEnvelope{native: 1, sequence: 44, phase: "down", atUnixMs: 10}) ||
		!monitor.enqueueNativeClose(windowPointerEnvelope{native: 1, sequence: 44, phase: "up", atUnixMs: 11}) {
		t.Fatal("native close pointer was not queued")
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("native close request was not dispatched")
	}
	outcome, found := monitor.nativeCloseExpectation(44)
	if !found || outcome.Closed || outcome.Window != "win-a" {
		t.Fatalf("native close outcome=%+v found=%t", outcome, found)
	}
	monitor.mu.Lock()
	monitor.active = false
	close(monitor.queue)
	monitor.mu.Unlock()
	monitor.worker.Wait()
}

func TestUnknownWindowCloseClickIsNotConsumed(t *testing.T) {
	dispatched := 0
	monitor := newWindowInputMonitor(
		func(native uintptr) string {
			if native == 41 {
				return "win-a"
			}
			return ""
		},
		func(string, string, any) error { dispatched++; return nil },
	)
	monitor.active = true
	if monitor.enqueueNativeClose(windowPointerEnvelope{native: 9, sequence: 5, phase: "down", atUnixMs: 1}) {
		t.Fatal("a close click on an unknown window was consumed")
	}
	if queued, dropped := monitor.queueState(); queued != 0 || dropped != 0 {
		t.Fatalf("queued=%d dropped=%d after an unknown window", queued, dropped)
	}
	if !monitor.enqueueNativeClose(windowPointerEnvelope{native: 41, sequence: 6, phase: "down", atUnixMs: 2}) {
		t.Fatal("a close click on a known window was not queued")
	}
	if queued, _ := monitor.queueState(); queued != 1 {
		t.Fatalf("queued=%d after a known window", queued)
	}
	if dispatched != 0 {
		t.Fatalf("enqueue dispatched %d events inline", dispatched)
	}
}
