package wails

import (
	"testing"
	"time"
)

// Session state receives every frame. Plugin events are limited to one per pane per 100 ms.
func TestFrameStateIsForwardedAlwaysAndEmittedAtMostTenPerSecond(t *testing.T) {
	var noted []uint64
	var emitted []any
	moment := time.Unix(0, 0)
	notify := terminalStateNotifier(
		func(_ string, seq uint64) { noted = append(noted, seq) },
		func(_ string, payload any) { emitted = append(emitted, payload) },
		func() time.Time { return moment },
	)
	notify("tab-1.1", 1)
	moment = moment.Add(10 * time.Millisecond)
	notify("tab-1.1", 2)
	moment = moment.Add(200 * time.Millisecond)
	notify("tab-1.1", 3)
	if len(noted) != 3 {
		t.Fatalf("the sessions hear every frame, got %d", len(noted))
	}
	if len(emitted) != 2 {
		t.Fatalf("two emits expected (first and after the window), got %d", len(emitted))
	}
	payload, shaped := emitted[1].(map[string]any)
	if !shaped || payload["pane"] != "tab-1.1" || payload["sequence"] != uint64(3) {
		t.Fatalf("the state payload names the pane and its sequence: %#v", emitted[1])
	}
}

func TestAThrottledFinalFrameIsEmittedAtTheWindowEnd(t *testing.T) {
	emitted := make(chan map[string]any, 2)
	notify := terminalStateNotifier(
		func(string, uint64) {},
		func(_ string, payload any) { emitted <- payload.(map[string]any) },
		time.Now,
	)
	notify("tab-1.1", 1)
	<-emitted
	notify("tab-1.1", 2)
	select {
	case payload := <-emitted:
		if payload["sequence"] != uint64(2) {
			t.Fatalf("trailing state sequence = %#v", payload["sequence"])
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("the final throttled frame was dropped")
	}
}
