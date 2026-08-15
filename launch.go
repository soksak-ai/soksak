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

// own does everything this installation owns: it opens the store, fills the
// registry, and runs the framework. It returns when the application quits.
//
// It is one function rather than a sequence in main so that nothing it does can
// happen before the claim above it. A store opened first and a window drawn
// later are the same mistake at different costs.
type own func(listener net.Listener) error

// launch is the order a process becomes this installation's backend in.
//
// Nothing this installation owns is touched until the home is claimed. A second
// process therefore dies without a window and without having opened the
// database — two writers on one SQLite do not collide, the driver serialises
// them, so that damage is silent and the loser looks like it did nothing.
//
// That ordering used to be the order of two statements with the store opened
// above both. Measured 2026-08-15: pid 66355, started at 09:22 and orphaned to
// launchd, held ~/.soksak-wails/soksak.db-shm open beside the live process for
// three hours. It was invisible to every search, because those searched for the
// application's name and this one was called app-mcp. "I thought I had closed
// it" is a belief; this is what makes the belief unnecessary.
func launch(resolved identity.Resolved, claim claimHome, run own) error {
	listener, err := claim(resolved.Socket)
	if err != nil {
		// Named rather than shrugged off. A process that failed to claim the
		// home and started anyway would answer no command from outside while
		// looking exactly like the one that did.
		return fmt.Errorf("this installation already has a backend: %w", err)
	}
	defer func() { _ = listener.Close() }()

	return run(listener)
}

// serveControl answers the control plane on a listener until it closes.
//
// Started as its own goroutine because Run owns the calling thread from here
// on. A failure is logged rather than returned: the socket stopping is not a
// reason to take the windows down, and a caller that finds nothing answering
// finds that by connecting.
func serveControl(listener net.Listener, registry *control.Registry, identifier string, onStop func(error)) {
	go func() {
		if err := control.Serve(listener, registry, identifier); err != nil {
			onStop(err)
		}
	}()
}
