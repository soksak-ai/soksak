// Package daemon owns the long-running processes a workspace declares.
//
// A daemon here is a line a workspace wrote down — `npm run dev`,
// `docker compose up`, a service sidecar — that this build starts, keeps the
// recent output of, ends, and matches against what a previous run left behind.
// There is no daemon of this application's own: the process this package starts
// is the daemon, and nothing supervises it from outside the app.
//
// A sidecar is one of these, and it is not a second interface. The plan is that
// a sidecar is a plugin in its own process speaking the same control envelope
// core/control already answers on — never a second ABI — which is why the
// readiness rule below is written in that envelope's terms: the daemon names
// its own socket and the protocol version it speaks, and a mismatch is refused
// at the announcement rather than at the first command that behaves
// differently.
//
// Nothing here reads the environment, the working directory, or the operating
// system at run time. The shell, the platform, the clock, the timer, the
// environment rule, the spawner and the reaper all arrive as values, so the
// same rules answer the same way in a window, in a headless server, and in a
// test.
package daemon

import (
	"time"

	"github.com/soksak-ai/soksak-core/core/control"
	"github.com/soksak-ai/soksak-core/core/process"
)

// Deps is what the surrounding process supplies. Every field is something this
// package refuses to read for itself.
type Deps struct {
	// Spawner starts the daemons. Nil means this host starts no processes, and
	// the two commands that start one are declared unserved by name rather than
	// answering as if they had.
	Spawner process.Spawner
	// LoginShell is the shell a daemon's line runs through. Empty refuses the
	// commands that need one rather than reading $SHELL, which would tie the
	// answer to whatever launched this process.
	LoginShell string
	// Windows is the platform, as an argument. Reading runtime.GOOS here would
	// answer what this binary is rather than what the caller asked.
	Windows bool
	// Environment builds one child's environment from the caller's overrides,
	// as "NAME=value".
	//
	// A function rather than a list, because "what a child may inherit" is a
	// rule that already has an owner — core/process strips the internal
	// SOKSAK_* names so a vault master key never enters a child — and a second
	// copy of that rule here would drift from the first the moment either
	// changed. Nil means this host declared no such rule, and the commands that
	// start a process are refused by name: handing a daemon this process's own
	// environment instead is exactly how an internal name leaves the app.
	Environment func(overrides map[string]string) []string
	// Now supplies epoch milliseconds. It is what uptime is measured with; nil
	// is a wiring fault rather than a runtime condition, and Register names it.
	Now func() int64
	// After fires a function once a duration has passed, and is what both a
	// run-once deadline and the scheduler's next wake are. Injected so a test
	// drives time instead of waiting for it. Nil takes time.AfterFunc.
	//
	// It must not run the function inline. The scheduler arms its next wake
	// while it holds the job table, and a fire that came back on the same
	// goroutine would take that lock a second time and stop the process.
	After func(time.Duration, func())
	// Reaper ends a process this build did not start. Nil means this host
	// cannot query what a live pid is running, and daemon_reap is refused by
	// name — ending a recorded pid without matching it would kill whatever
	// inherited that number.
	Reaper Reaper
	// Announce delivers one daemon's row to the owner of windows, when it names
	// its socket, when it refuses to, and when it exits. Nil means nobody is
	// listening, which is what headless is rather than an error.
	//
	// It exists so readiness never has to be asked for twice. A caller with no
	// event has only one way to learn a daemon came up, and that way is to look
	// again.
	Announce func(Daemon)
}

// The names this group answers to.
const (
	commandStart   = "daemon_start"
	commandStop    = "daemon_stop"
	commandStatus  = "daemon_status"
	commandLogs    = "daemon_logs"
	commandReap    = "daemon_reap"
	commandRunOnce = "daemon_run_once"
)

// commandNames is every name Register touches, served or refused.
var commandNames = []string{
	commandStart, commandStop, commandStatus,
	commandLogs, commandReap, commandRunOnce,
	commandScheduleSet, commandScheduleRegister,
	commandScheduleCancel, commandScheduleList, commandSchedulePoke,
}

// Reasons this build refuses. They reach the caller verbatim through the
// registry, so each states what is missing rather than that something is.
const (
	noSpawner = "this host was given no spawner and starts no processes, so there is nothing here to make a daemon out of"

	noProcessGroups = "this host cannot put a daemon in its own process group — core/process states so per build tag for windows, where a job object would be needed — " +
		"and a daemon line starts a server the shell owns: a stop would reach the shell and leave the server holding the port while the caller was told it stopped"

	noShell = "this process was given no login shell and a daemon declaration is a shell line; " +
		"running it through a guessed shell would run it with a PATH the user never set, and the daemon would fail on a tool that is plainly installed"

	noEnvironmentRule = "this host declared no environment rule for a child (daemon.Deps.Environment); " +
		"starting a daemon with this process's own environment instead is how an internal name — the vault's master key among them — leaves the app"

	noReaper = "this host was given no way to read a live pid's command line (daemon.Deps.Reaper); " +
		"a pid is a recycled number, and ending a recorded one without matching it first would kill whatever inherited it"
)

// Register puts this group's commands on the registry and answers with the
// supervisor.
//
// The supervisor comes back because none of these six commands ends the
// daemons when the application quits, and a group that can be registered and
// never told to stop leaves a dev server holding a port after the last window
// is gone. The host calls StopAll.
//
// Every command is OwnerCore: none needs a window, which is what lets a
// headless process answer them identically.
func Register(registry *control.Registry, deps Deps) *Supervisor {
	if deps.Now == nil {
		// A wiring fact, decided before anything runs. Defaulting to a clock
		// read here would make this package decide what "now" is, which is the
		// launcher's to supply; defaulting to zero would report every daemon as
		// having started this instant, forever.
		panic("daemon: Register needs a clock; set daemon.Deps.Now")
	}
	if deps.After == nil {
		deps.After = func(after time.Duration, fire func()) { time.AfterFunc(after, fire) }
	}
	supervisor := newSupervisor(deps)

	declare := func(name, reason string) {
		if err := registry.DeclareUnserved(name, reason); err != nil {
			panic(err)
		}
	}
	serve := func(name string, handler control.Handler) {
		registry.MustRegister(control.Command{Name: name, Owner: control.OwnerCore, Handler: handler})
	}

	// One reason, chosen in the order a host would fix them: what is missing
	// first is what a caller acts on first.
	spawningRefusal := ""
	switch {
	case deps.Spawner == nil:
		spawningRefusal = noSpawner
	case deps.Windows:
		spawningRefusal = noProcessGroups
	case deps.LoginShell == "":
		spawningRefusal = noShell
	case deps.Environment == nil:
		spawningRefusal = noEnvironmentRule
	}

	if spawningRefusal != "" {
		declare(commandStart, spawningRefusal)
		declare(commandRunOnce, spawningRefusal)
	} else {
		serve(commandStart, func(args control.Args) (any, error) {
			root, err := namedText(commandStart, args, "root")
			if err != nil {
				return nil, err
			}
			name, err := namedText(commandStart, args, "name")
			if err != nil {
				return nil, err
			}
			cmd, err := namedText(commandStart, args, "cmd")
			if err != nil {
				return nil, err
			}
			// Every argument is read before the spawner is touched: a refusal
			// that had already started a server leaves one running that the
			// caller holds no pid for.
			if err := refuseRestartPolicy(commandStart, args); err != nil {
				return nil, err
			}
			return supervisor.Start(root, name, cmd)
		})

		serve(commandRunOnce, func(args control.Args) (any, error) {
			root, err := namedText(commandRunOnce, args, "root")
			if err != nil {
				return nil, err
			}
			cmd, err := namedText(commandRunOnce, args, "cmd")
			if err != nil {
				return nil, err
			}
			timeout, err := runSeconds(commandRunOnce, args)
			if err != nil {
				return nil, err
			}
			overrides, err := environmentOverrides(commandRunOnce, args)
			if err != nil {
				return nil, err
			}
			return supervisor.RunOnce(root, cmd, overrides, timeout)
		})
	}

	// Stop, status and logs answer about the table this process holds. With no
	// spawner the table stays empty and they say so, which is true — "nothing
	// is running" is a different answer from "nothing can be started here", and
	// the second one is what the refusal above states.
	serve(commandStop, func(args control.Args) (any, error) {
		root, err := namedText(commandStop, args, "root")
		if err != nil {
			return nil, err
		}
		name, err := optionalText(commandStop, args, "name")
		if err != nil {
			return nil, err
		}
		return supervisor.Stop(root, name)
	})

	serve(commandStatus, func(args control.Args) (any, error) {
		root, err := namedText(commandStatus, args, "root")
		if err != nil {
			return nil, err
		}
		return supervisor.Status(root), nil
	})

	serve(commandLogs, func(args control.Args) (any, error) {
		root, err := namedText(commandLogs, args, "root")
		if err != nil {
			return nil, err
		}
		name, err := namedText(commandLogs, args, "name")
		if err != nil {
			return nil, err
		}
		count, err := lineCount(commandLogs, args)
		if err != nil {
			return nil, err
		}
		return supervisor.Logs(root, name, count)
	})

	// The scheduler needs nothing a host can be missing: it fires registry
	// commands with the clock and the timer this package already has.
	registerSchedule(registry, deps)

	if deps.Reaper == nil {
		declare(commandReap, noReaper)
	} else {
		serve(commandReap, func(args control.Args) (any, error) {
			records, err := recordedDaemons(commandReap, args)
			if err != nil {
				return nil, err
			}
			return adopt(deps.Reaper, records)
		})
	}

	return supervisor
}
