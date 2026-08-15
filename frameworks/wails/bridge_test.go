package wails

import "testing"

func TestAnUnfilledBridgeAnswersRatherThanPanics(t *testing.T) {
	// The launcher hands this to the core before Run exists to fill it. A
	// command that fires in that window — a store change during boot, say —
	// must not take the process down.
	var bridge Bridge
	bridge.Emit("anything", map[string]any{"a": 1})

	if live := bridge.Live(); len(live) != 0 {
		t.Errorf("an unfilled bridge reported %v as live windows", live)
	}
}

func TestABridgeReportsTheHostsWindows(t *testing.T) {
	bridge := Bridge{host: startedHost(liveWindow("main"), liveWindow("win-a"))}

	live := bridge.Live()
	if len(live) != 2 {
		t.Fatalf("reported %v, want both windows", live)
	}
}

func TestANilBridgeIsSafe(t *testing.T) {
	// A launcher that passes none is a launcher with no windows, which is what
	// headless is. It must not be a different code path.
	var bridge *Bridge
	bridge.Emit("anything", nil)
	if live := bridge.Live(); live != nil {
		t.Errorf("a nil bridge reported %v", live)
	}
}
