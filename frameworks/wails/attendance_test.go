package wails

import (
	"os"
	"testing"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// A launch nobody is watching does not come to the front.
//
// Nine gates start this application on their own home over one verify run. Measured 2026-08-20 with
// `System Events`: each one took the frontmost position and put an icon in the dock, so a person
// working through a verify had nine windows appear over what they were doing and nine dock icons
// arrive and go.
//
// The application cannot tell — a window is a window. The launch can: a gate is about to measure a
// window nobody is looking at, and a person opening the application is the opposite case. So it is
// declared there and passed in, the same way the home and the identifier are.
//
// This is not a test mode. Attended is a fact about the launch, and a build deriving it from
// anything else is guessing about who is in the room.
func TestAnUnattendedLaunchDoesNotTakeTheFront(t *testing.T) {
	if policy := macActivation(false); policy != application.ActivationPolicyAccessory {
		t.Fatalf("an unattended launch asks for activation policy %d.\n"+
			"Regular activates the application and puts it in the dock, so a measurement run "+
			"interrupts whoever is at the machine — which is the one thing a measurement must not do.",
			policy)
	}
}

// An attended launch is a person's application and behaves like one.
//
// Stated separately because a build that is always an accessory has no dock icon and never comes
// forward when it is opened, which reads as an application that did not start.
func TestAnAttendedLaunchIsAnOrdinaryApplication(t *testing.T) {
	if policy := macActivation(true); policy != application.ActivationPolicyRegular {
		t.Fatalf("an attended launch asks for activation policy %d rather than regular", policy)
	}
}

// An unattended launch ends when whoever started it does.
//
// Measured 2026-08-20: three application processes were running from earlier gate runs, the oldest
// for an hour and seventeen minutes, each holding a window and a home under <local-evidence>. A gate quits its
// application on the way out, and that path does not run when the test binary itself is killed —
// an interrupt, a timeout, a crash — so the child outlives the only thing that knew about it.
//
// A unit outliving its spawner is deliberate and is why `core/sidecar` exists. This is the opposite
// case: an unattended launch exists for one run, and after that run nothing can reach it, quit it,
// or say what it is for.
//
// The channel is the spawner's own pipe. Nothing is sent on it; what is read is its end. That makes
// the death an event rather than a state to look for on a timer (AGENTS.md L7), and it needs no
// pid, no signal and no platform branch.
func TestAnUnattendedLaunchEndsWithItsSpawner(t *testing.T) {
	closed := make(chan struct{})
	spawner, held, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	go endWithSpawner(spawner, func() { close(closed) })

	// The spawner goes.
	_ = held.Close()

	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("the spawner's channel closed and the application was not asked to quit.\n" +
			"It keeps a window and a home nobody can reach — measured 2026-08-20, three of them at " +
			"once, the oldest an hour and seventeen minutes old.")
	}
}

// A channel that stays open ends nothing.
//
// Without this a quit on any read at all passes the test above while ending every gate the moment
// it starts.
func TestAnOpenChannelDoesNotEndAnything(t *testing.T) {
	asked := make(chan struct{})
	spawner, held, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()
	go endWithSpawner(spawner, func() { close(asked) })

	if _, err := held.Write([]byte("anything")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-asked:
		t.Fatal("bytes on the channel were read as the spawner going")
	case <-time.After(250 * time.Millisecond):
	}
}
