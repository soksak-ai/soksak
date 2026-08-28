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
