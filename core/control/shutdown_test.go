package control

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func shutdownRegistry(released Generation, failure error) *Registry {
	registry := NewRegistry()
	Register(registry, Deps{
		ReleaseGeneration: func() (Generation, error) { return released, failure },
	})
	return registry
}

func TestASignedReceiptCarriesEveryFieldTheCallerChecks(t *testing.T) {
	// The caller quits on this answer, so the answer is the last observation
	// anyone gets. A field it reads and this build does not write decodes to
	// zero on its side and passes the check by accident.
	answer, err := shutdownRegistry(Generation{
		ProcessChildren:       2,
		LocalPTYs:             3,
		DaemonPTYsTransferred: 1,
		Daemons:               4,
		Services:              5,
		NativeWindows:         6,
		NativeSurfaces:        7,
		NativePaneHosts:       8,
		NativeInputMonitors:   9,
	}, nil).Invoke(commandShutdownPrepare, Args{})
	if err != nil {
		t.Fatalf("app_shutdown_prepare: %v", err)
	}

	encoded, err := json.Marshal(answer)
	if err != nil {
		t.Fatalf("encoding the receipt: %v", err)
	}
	var receipt map[string]any
	if err := json.Unmarshal(encoded, &receipt); err != nil {
		t.Fatalf("decoding the receipt: %v", err)
	}
	for name, want := range map[string]any{
		"phase":                      "reaped",
		"reaped":                     true,
		"processChildrenReaped":      float64(2),
		"localPtysReaped":            float64(3),
		"daemonPtysTransferred":      float64(1),
		"daemonsReaped":              float64(4),
		"servicesReaped":             float64(5),
		"nativeWindowsDrained":       float64(6),
		"nativeSurfacesDrained":      float64(7),
		"nativePaneHostsDrained":     float64(8),
		"nativeInputMonitorsDrained": float64(9),
		"nativeRemaining":            float64(0),
	} {
		got, present := receipt[name]
		if !present {
			t.Errorf("the receipt has no %q; the caller reads it and would see zero", name)
			continue
		}
		if got != want {
			t.Errorf("receipt %q = %v, want %v", name, got, want)
		}
	}
}

func TestAnythingStillHeldRefusesToSign(t *testing.T) {
	// Quitting destroys the channel this answer came back on. A receipt that
	// said "reaped" with surfaces still alive would be the last thing anyone
	// saw, and nothing downstream could contradict it.
	_, err := shutdownRegistry(Generation{NativeWindows: 2, Remaining: 3}, nil).
		Invoke(commandShutdownPrepare, Args{})
	if err == nil {
		t.Fatal("a generation that was not released must not be signed off")
	}
	if !strings.Contains(err.Error(), "3 native object(s) are still held") {
		t.Errorf("the refusal reads %q and does not say how much remains", err)
	}
}

func TestANegativeCountIsRefusedByField(t *testing.T) {
	// A subsystem that lost track, not a shutdown that went unusually well.
	_, err := shutdownRegistry(Generation{LocalPTYs: -1}, nil).
		Invoke(commandShutdownPrepare, Args{})
	if err == nil {
		t.Fatal("a negative count was signed off")
	}
	if !strings.Contains(err.Error(), "localPtysReaped") {
		t.Errorf("the refusal reads %q and does not name the field", err)
	}
}

func TestAFailedReleaseAnswersNoReceipt(t *testing.T) {
	answer, err := shutdownRegistry(Generation{}, errors.New("pty 7 would not close")).
		Invoke(commandShutdownPrepare, Args{})
	if err == nil {
		t.Fatalf("a failed release answered %v", answer)
	}
	if !strings.Contains(err.Error(), "pty 7 would not close") {
		t.Errorf("the failure reads %q and loses what went wrong", err)
	}
}

func TestAProcessThatHoldsNothingStillSignsARealReceipt(t *testing.T) {
	// All zeroes is a true answer for a build that started nothing, and it must
	// still be a signed one — otherwise headless can never be told to quit.
	answer, err := shutdownRegistry(Generation{}, nil).Invoke(commandShutdownPrepare, Args{})
	if err != nil {
		t.Fatalf("app_shutdown_prepare: %v", err)
	}
	receipt, ok := answer.(ShutdownReceipt)
	if !ok {
		t.Fatalf("app_shutdown_prepare answered %T", answer)
	}
	if receipt.Phase != phaseReaped || !receipt.Reaped {
		t.Errorf("receipt = %+v", receipt)
	}
}

func TestNoWayToReleaseIsRefusedRatherThanAnsweredWithZeroes(t *testing.T) {
	// A receipt of zeroes from a process that never looked reads exactly like a
	// clean shutdown, and the children outlive the application.
	registry := NewRegistry()
	Register(registry, Deps{})

	if _, err := registry.Invoke(commandShutdownPrepare, Args{}); err == nil {
		t.Fatal("a process that cannot release what it started must not sign a receipt")
	}
}
