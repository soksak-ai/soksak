package wails

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/soksak/soksak-core/core/control"
)

// This build has a prepare phase, and answers a receipt for it.
//
// `app.shutdown.commit` reaps first and quits after the reply is delivered: an
// irreversible command that destroyed its own answer would leave a caller unable
// to tell a quit from a crash. The reap is `app_shutdown_prepare`, and its
// receipt is what the caller checks before allowing the quit.
//
// Measured 2026-08-16: `sok app.shutdown.commit` answered INTERNAL. The command
// was declared unserved here with the reason "this build quits without a prepare
// phase", and that reason was false — the compositor drains its surfaces and the
// terminal reaps its shells on shutdown. The phase existed and had no command,
// so the one way to quit this application was to kill the process.
type reaper struct {
	shells   int
	surfaces int
	left     int
	err      error
}

func (r *reaper) ReapShells() int { return r.shells }

func (r *reaper) DrainSurfaces() (int, int, error) { return r.surfaces, r.left, r.err }

func shutdownRegistry(t *testing.T, deps ShutdownDeps) *control.Registry {
	t.Helper()
	registry := control.NewRegistry()
	RegisterShutdown(registry, deps)
	return registry
}

func receiptOf(t *testing.T, registry *control.Registry) map[string]any {
	t.Helper()
	answer, err := registry.Invoke("app_shutdown_prepare", nil)
	if err != nil {
		t.Fatalf("app_shutdown_prepare: %v", err)
	}
	encoded, err := json.Marshal(answer)
	if err != nil {
		t.Fatalf("encoding the receipt: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatalf("decoding the receipt: %v", err)
	}
	return payload
}

// The payload is the contract: the caller reads these keys and refuses the quit
// when one is missing or negative, so they are checked as a caller receives them
// rather than as the Go value.
func TestThePrepareReceiptSaysWhatItReaped(t *testing.T) {
	registry := shutdownRegistry(t, ShutdownDeps{
		Reaper: &reaper{shells: 3, surfaces: 4},
		Quit:   func() {},
	})

	receipt := receiptOf(t, registry)

	for key, want := range map[string]any{
		"phase":            "reaped",
		"reaped":           true,
		"localPtysReaped":  float64(3),
		"nativeSurfacesDrained": float64(4),
		"nativeRemaining":  float64(0),
	} {
		if receipt[key] != want {
			t.Errorf("receipt[%q] = %v, want %v", key, receipt[key], want)
		}
	}

	// Every count the caller checks is present and not negative. A key it reads
	// as undefined fails its `Number.isSafeInteger` check and refuses the quit.
	for _, key := range []string{
		"processChildrenReaped", "daemonPtysTransferred", "daemonsReaped", "servicesReaped",
		"nativeWindowsDrained", "nativePaneHostsDrained", "nativeInputMonitorsDrained",
	} {
		value, present := receipt[key].(float64)
		if !present {
			t.Errorf("the receipt has no %q; the caller reads it and refuses the quit", key)
			continue
		}
		if value < 0 {
			t.Errorf("receipt[%q] = %v", key, value)
		}
	}
}

// A drain that left something behind is not a quit this build may take.
//
// A surface still held when the process exits is a native child outliving its
// parent. Reporting the failure as a clean receipt would let the caller quit on
// it, and the window would be gone with the child still on screen.
func TestAPrepareThatCouldNotDrainRefusesRatherThanReport(t *testing.T) {
	registry := shutdownRegistry(t, ShutdownDeps{
		Reaper: &reaper{shells: 1, surfaces: 0, left: 2},
		Quit:   func() {},
	})

	_, err := registry.Invoke("app_shutdown_prepare", nil)
	if err == nil {
		t.Fatal("a drain that left 2 surfaces answered a clean receipt")
	}
	if !strings.Contains(err.Error(), "2") {
		t.Errorf("the refusal does not say how many are left: %v", err)
	}
}

// The commit is what actually quits, and it is a separate call because the reply
// to the prepare has to reach the caller first.
func TestTheCommitQuits(t *testing.T) {
	quit := 0
	registry := shutdownRegistry(t, ShutdownDeps{
		Reaper: &reaper{},
		Quit:   func() { quit++ },
	})

	if _, err := registry.Invoke("app_shutdown_commit", nil); err != nil {
		t.Fatalf("app_shutdown_commit: %v", err)
	}
	if quit != 1 {
		t.Errorf("the commit quit %d times, want 1", quit)
	}
}
