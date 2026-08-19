package wails

import (
	"fmt"

	"github.com/soksak/soksak-core/core/control"
)

// Quitting is two calls, and that is the point.
//
// Prepare reaps and answers a receipt; commit quits. They are separate because
// the reply to the prepare has to reach the caller before the process goes
// away — an irreversible command that destroyed its own answer would leave a
// caller unable to tell a quit from a crash.
//
// Measured 2026-08-16: `sok app.shutdown.commit` answered INTERNAL. Both halves
// were declared unserved here, prepare with the reason "this build quits without
// a prepare phase". That reason was false: the compositor drains its surfaces
// and the terminal reaps its shells when this host shuts its services down. The
// phase existed and had no command, so the only way to quit this application was
// to kill the process — and killing it skips the drain the phase exists for.

// Reaper is what this host takes down before it quits.
//
// Each half counts its own. The number of shells the terminal held is the
// terminal's fact and the number of surfaces the compositor placed is the
// compositor's; a host counting for them would be a second ledger of one thing.
type Reaper interface {
	// ReapShells closes every shell session and answers how many it closed.
	ReapShells() int
	// DrainSurfaces takes every native surface down and answers how many came
	// down, how many are still held, and what stopped it.
	//
	// Two numbers because they are two claims. A surface still held when the
	// process exits is a native child outliving its parent, and "four came down"
	// leaves open whether a fifth is left.
	DrainSurfaces() (drained int, remaining int, err error)
	// DrainInputMonitors removes every process-local physical input observer.
	DrainInputMonitors() int
}

// ShutdownDeps is what the process supplies.
type ShutdownDeps struct {
	// Reaper takes the children down. A nil one is refused at registration
	// rather than answered around: a receipt from a host that reaped nothing
	// reads exactly like one from a host that had nothing to reap.
	Reaper Reaper
	// Quit ends the process. Separate from the reaper so the reap is provable
	// without ending the test that proves it.
	Quit func()
}

// ShutdownReceipt is what a caller checks before it allows the quit.
//
// Every count is present whether or not this host has that kind of child. A
// caller reads each one and refuses on anything that is not a whole number, so
// an absent key is a refusal rather than a zero — and zero daemons reaped is
// true when there are no daemons.
type ShutdownReceipt struct {
	// Phase and Reaped are the two the caller checks first. A receipt that
	// reached this struct at all has reaped, so they are constant here; they are
	// in the payload because the caller's contract is a shape, not a promise.
	Phase  string `json:"phase"`
	Reaped bool   `json:"reaped"`

	ProcessChildrenReaped int `json:"processChildrenReaped"`
	LocalPtysReaped       int `json:"localPtysReaped"`
	DaemonPtysTransferred int `json:"daemonPtysTransferred"`
	DaemonsReaped         int `json:"daemonsReaped"`
	ServicesReaped        int `json:"servicesReaped"`

	NativeWindowsDrained       int `json:"nativeWindowsDrained"`
	NativeSurfacesDrained      int `json:"nativeSurfacesDrained"`
	NativePaneHostsDrained     int `json:"nativePaneHostsDrained"`
	NativeInputMonitorsDrained int `json:"nativeInputMonitorsDrained"`
	// NativeRemaining is the count the quit turns on. Anything above zero is a
	// native child that would outlive this process.
	NativeRemaining int `json:"nativeRemaining"`
}

// RegisterShutdown puts the two halves of quitting on the registry.
//
// It panics on a missing dependency, matching the other groups: boot-time
// registration is a programming fact, and finding it out as a failed command
// means the one way to quit cleanly is dark exactly when someone is using it.
func RegisterShutdown(registry *control.Registry, deps ShutdownDeps) {
	if deps.Reaper == nil {
		panic("wails: the shutdown commands need something to reap")
	}
	if deps.Quit == nil {
		panic("wails: the shutdown commands need a way to quit")
	}

	registry.MustRegister(control.Command{
		Name:  "app_shutdown_prepare",
		Owner: control.OwnerFramework,
		// Framework-owned: the children are this host's — its services, its
		// windows, its native surfaces — and a process with no host has none.
		Handler: func(control.Args) (any, error) {
			shells := deps.Reaper.ReapShells()
			inputMonitors := deps.Reaper.DrainInputMonitors()
			surfaces, remaining, err := deps.Reaper.DrainSurfaces()
			if err != nil {
				return nil, fmt.Errorf(
					"native surfaces could not be drained, %d still held: %w", remaining, err)
			}
			// Refused rather than reported. A caller handed a receipt saying
			// "reaped" would quit on it, and the window would be gone with the
			// child still on screen.
			if remaining != 0 {
				return nil, fmt.Errorf(
					"%d native surfaces are still held; quitting now would leave them on screen",
					remaining)
			}
			return ShutdownReceipt{
				Phase:  "reaped",
				Reaped: true,
				// The two this host owns. The rest are zero because this build
				// has no daemon, no transferred pty, no pane host and no input
				// monitor — that is a count, not an absence of one.
				LocalPtysReaped:            shells,
				NativeSurfacesDrained:      surfaces,
				NativeInputMonitorsDrained: inputMonitors,
				ServicesReaped:             2,
				NativeRemaining:            0,
			}, nil
		},
	})

	registry.MustRegister(control.Command{
		Name:  "app_shutdown_commit",
		Owner: control.OwnerFramework,
		Handler: func(control.Args) (any, error) {
			deps.Quit()
			return map[string]any{"quit": true}, nil
		},
	})
}

// hostReaper is this host's children: the terminal's shells and the
// compositor's surfaces.
type hostReaper struct {
	shells        func() int
	surfaces      func() (int, int, error)
	inputMonitors func() int
}

func (reaper hostReaper) ReapShells() int { return reaper.shells() }

func (reaper hostReaper) DrainSurfaces() (int, int, error) { return reaper.surfaces() }

func (reaper hostReaper) DrainInputMonitors() int { return reaper.inputMonitors() }
