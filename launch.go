package main

import (
	"fmt"
	"net"

	"github.com/soksak/soksak-core/core/control"
	"github.com/soksak/soksak-core/core/identity"
)

// claimHome takes this installation's socket, or fails saying who already has it.
//
// A function value so the rule below can be held by a test: the ordering it
// enforces is the whole contract, and an ordering nothing checks is a line
// number rather than a rule.
type claimHome func(socket string) (net.Listener, error)

// showWindows starts the framework. It returns when the application quits.
type showWindows func(listener net.Listener) error

// launch is the order a process becomes this installation's backend in.
//
// The home is claimed before anything is drawn. A second process on one home
// therefore dies while it is still invisible — it never reaches a window, so
// there is no moment where two copies of this application are on screen
// disagreeing about who owns the store.
//
// That ordering used to be nothing but the order of two statements. Measured
// 2026-08-15: a second copy was started by hand, opened its own window, and was
// then mistaken for a defect in the first — twice, by two different readers of
// the same screen. "I thought I had closed it" is a belief; this is the fact
// that makes the belief unnecessary.
func launch(resolved identity.Resolved, claim claimHome, show showWindows) error {
	listener, err := claim(resolved.Socket)
	if err != nil {
		// Named rather than shrugged off. A process that failed to claim the
		// home and started anyway would answer no command from outside while
		// looking exactly like the one that did.
		return fmt.Errorf("this installation already has a backend: %w", err)
	}
	defer func() { _ = listener.Close() }()

	return show(listener)
}

// serveControl answers the control plane on a listener until it closes.
//
// Started as its own goroutine because Run owns the calling thread from here
// on. A failure is logged rather than returned: the socket stopping is not a
// reason to take the windows down, and a caller that finds nothing answering
// learns that by connecting.
func serveControl(listener net.Listener, registry *control.Registry, identifier string, onStop func(error)) {
	go func() {
		if err := control.Serve(listener, registry, identifier); err != nil {
			onStop(err)
		}
	}()
}
