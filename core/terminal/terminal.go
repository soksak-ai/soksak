// Package terminal routes the terminal command group to whoever owns the PTY.
//
// It opens no pseudo-terminal, reads no bytes, and reaps no process. The kernel
// object, the read loop and the process-group kill belong to whoever holds the
// file descriptor; this package holds the command names, the identity table
// that pairs a caller's id with an owner's handle, and the rules about what may
// be asked.
//
// Why routing rather than a second implementation: a command registers once and
// is reached through every transport, and nothing may bypass the registry — a
// second path drifts from the first, and the drift stays quiet until the two
// give different answers. Two terminal paths would be exactly that. The owner
// arrives through the interfaces declared below, so this package names no
// vendor and answers identically in a window, in a headless server, and in a
// test.
//
// Backpressure is deliberately absent here, and that is a gap rather than a
// design: see the reason attached to ack_terminal.
package terminal

import (
	"fmt"

	"github.com/soksak/soksak-core/core/control"
)

// Sessions is the base contract every terminal owner satisfies.
//
// Handles rather than ids cross it: a stale handle fails against the owner's
// generation check instead of landing in the session that replaced it.
//
// The key names the session, and it is the only thing about the caller's pane
// the owner receives. It is read by splitting it on "/": two fields are
// (windowLabel, paneId) and three are a session the caller gave no pane id,
// whose window half is still the first field. Neither half of a pair may
// contain the separator, so the two shapes cannot be confused. That grammar is
// written here because an owner needs the pair back — an earlier build injected
// it into the shell as SOKSAK_WINDOW and SOKSAK_CALLER_TAB, which is how a tool
// running inside a pane names the pane it is running in; an owner handed one
// opaque string could only guess at it.
//
// Opening over a key that already holds a live session replaces it, and the
// owner closes the one it replaced. This package drops the replaced id in the
// same step and then holds no other way to reach that shell, so an owner that
// keeps both leaks the first one with nothing left to close it by.
type Sessions interface {
	Open(key string, cols, rows uint16) (Handle, error)
	Write(handle Handle, data string) error
	Resize(handle Handle, cols, rows uint16) error
	Close(handle Handle) error
}

// Placement starts the shell somewhere, or starts a different one.
//
// An owner without it makes spawn_terminal refuse a cwd or a shell rather than
// disregard it — a shell started in the wrong directory looks like it worked.
type Placement interface {
	OpenAt(key string, cols, rows uint16, cwd, shell string) (Handle, error)
}

// Flow is the owner counting delivered bytes and pausing its reader.
//
// An owner without it makes ack_terminal a declared refusal rather than a
// counter kept over a stream this package never carries.
type Flow interface {
	Ack(handle Handle, bytes uint64) error
}

// Foreground is the process group of the command running in the pane right now
// — read from the PTY master the owner holds, not the shell's own pid.
//
// An owner without it makes pty_pane_pid a declared refusal rather than an
// answer about a different process.
type Foreground interface {
	ForegroundGroup(handle Handle) (int, error)
}

// Deps is what the process supplies. Nothing here is read from the environment:
// the owner is constructed where the framework is known and injected from
// there, which is what keeps this package host-independent.
type Deps struct {
	Sessions Sessions
}

// Spawned is what spawn_terminal answers with.
//
// ID is what the caller sends back to write, resize, ack and close. Handle is
// the owner's coordinate, and it is what the output event carries — a caller
// matches bytes to a pane by it, because bytes have never crossed this return
// value.
type Spawned struct {
	ID     uint32 `json:"id"`
	Handle Handle `json:"handle"`
}

// Reasons this build refuses. They reach the caller verbatim through the
// registry, so each says what is missing rather than that something is.
const (
	// The reader that has to pause lives with the owner, and this package never
	// sees the bytes. A counter kept here would account for a stream it does
	// not carry: it could report a paused reader while the reader kept running.
	// An earlier build split it the same way — on its daemon leg "the watermark
	// is owned by the daemon side (we relay the ack)".
	//
	// For whoever implements the owner half, with the measurements that set the
	// numbers: pause at 1,000,000 unacked bytes and resume at 500,000. Those
	// bound memory per pane and are not the throughput ceiling — widening the
	// window from 100k to 1 MB, a factor of ten, moved t1_plain from 3.02 to
	// 3.35 MB/s, a factor of 1.11 (results 20260711-141852 vs -145114). Detach
	// must reset the count and resume, or a pane nobody is attached to freezes
	// its shell. The ceiling is the delivery unit instead: cost attaches to the
	// number of crossings, not to the bytes.
	ackUnserved = "this terminal owner does not count delivered bytes, so there is no reader to pause; " +
		"a count kept in the core would report a pause that never happened"

	// The pgid of the command running in the pane pairs with the AI session id
	// (command/pid/sessionId). An owner's shell pid is a different process, so
	// answering with it would attach that tracking to the shell instead of to
	// the command the shell launched.
	panePidUnserved = "this terminal owner does not expose the pane's foreground process group; " +
		"its shell pid names a different process"

	// The writer was a supervisor and the opener was the vault; neither exists
	// here. Answering null would report an empty checkpoint store rather than a
	// missing feature, and the consumer would draw a blank screen and conclude
	// the session had none.
	sealedScreenUnserved = "nothing seals screen checkpoints in this build — there is no supervisor writing them and no vault opening them"

	// It relays one NDJSON round trip to a service sidecar's unix socket
	// because a webview cannot open one. The core cannot stand in for the
	// sidecar. An earlier build made a connection failure an explicit error —
	// never silence, never a hang — because it is the loud signal the sidecar
	// died; refusing preserves that.
	sidecarUnserved = "there is no service sidecar in this build for the core to relay to"

	// "No such component" and "component down" must not collapse. The catalogue
	// builds a "restart it" hint out of running:false, and the restart would
	// then fail against a daemon that was never there.
	daemonStatusUnserved  = "there is no PTY session daemon in this build — reporting it as not running would read as one that is down and can be restarted"
	daemonRestartUnserved = "there is no PTY session daemon in this build to restart"

	// An earlier build refuses the handoff outright when the outgoing daemon
	// does not declare the contract, rather than trying and losing shells: the
	// plan is made by the outgoing daemon, and a build that cannot keep it
	// kills shells or silently stops output. With no daemon at all this is the
	// same rule at its limit.
	daemonUpgradeUnserved = "there is no PTY session daemon in this build to hand off from"
)

// Register puts this group's commands on the registry.
//
// Everything is OwnerCore: none of these needs a window. They are registered
// from wherever the owner is built only because that is where the owner exists.
//
// Each optional contract the owner does not satisfy turns exactly one command
// into a declared refusal, so served, refused-with-a-reason, and unknown stay
// three different answers.
func Register(registry *control.Registry, deps Deps) {
	if deps.Sessions == nil {
		// A process that registered these over no owner would nil-dereference
		// on a user's first spawn, inside a pane, rather than while it started.
		panic("terminal: Register needs a session owner; the process that holds the PTY injects it")
	}
	sessions := newTable()
	placement, _ := deps.Sessions.(Placement)
	flow, _ := deps.Sessions.(Flow)
	foreground, _ := deps.Sessions.(Foreground)

	declare := func(name, reason string) {
		if err := registry.DeclareUnserved(name, reason); err != nil {
			panic(err)
		}
	}
	serve := func(name string, handler control.Handler) {
		registry.MustRegister(control.Command{Name: name, Owner: control.OwnerCore, Handler: handler})
	}

	serve("spawn_terminal", func(args control.Args) (any, error) {
		const command = "spawn_terminal"
		// Every argument is checked before the owner is touched: a refusal that
		// had already opened a PTY leaks a shell the caller holds no id for.
		cols, err := size(command, args, "cols")
		if err != nil {
			return nil, err
		}
		rows, err := size(command, args, "rows")
		if err != nil {
			return nil, err
		}
		if err := replaySpawns(command, args); err != nil {
			return nil, err
		}
		windowLabel, _, err := optionalText(command, args, "windowLabel")
		if err != nil {
			return nil, err
		}
		paneID, named, err := optionalText(command, args, "paneId")
		if err != nil {
			return nil, err
		}
		cwd, placed, err := optionalText(command, args, "cwd")
		if err != nil {
			return nil, err
		}
		shell, chosen, err := optionalText(command, args, "shell")
		if err != nil {
			return nil, err
		}

		var key string
		if named {
			if key, err = paneKey(command, windowLabel, paneID); err != nil {
				return nil, err
			}
		} else {
			// No pane id is no reattach key. The session is still real and
			// still needs a name the owner can hold it by, and that name keeps
			// the window half: the caller sent a window label either way, and
			// an earlier build injected it into every session's shell whether or
			// not the session had a pane. Dropping it here would be the silent
			// disregard this command refuses two arguments earlier.
			if err := windowHalf(command, windowLabel); err != nil {
				return nil, err
			}
			paneID = ""
			key = sessions.anonymous(windowLabel)
		}

		var handle Handle
		switch {
		case placed || chosen:
			if placement == nil {
				name := "cwd"
				if !placed {
					name = "shell"
				}
				return nil, fmt.Errorf("%s: argument %q is set and this terminal owner cannot honour it — "+
					"disregarding it would start the shell somewhere the caller did not ask for, with no way to tell", command, name)
			}
			handle, err = placement.OpenAt(key, cols, rows, cwd, shell)
		default:
			handle, err = deps.Sessions.Open(key, cols, rows)
		}
		if err != nil {
			return nil, fmt.Errorf("%s: %w", command, err)
		}

		return Spawned{ID: sessions.install(key, paneID, handle), Handle: handle}, nil
	})

	serve("write_terminal", func(args control.Args) (any, error) {
		const command = "write_terminal"
		id, err := sessionID(command, args)
		if err != nil {
			return nil, err
		}
		data, err := requiredText(command, args, "data")
		if err != nil {
			return nil, err
		}
		found, err := held(command, sessions, id)
		if err != nil {
			return nil, err
		}
		// The bytes go through unchanged. The shell interprets them, so a
		// newline translated or a space trimmed here changes what was typed.
		if err := deps.Sessions.Write(found.handle, data); err != nil {
			return nil, fmt.Errorf("%s: session %d: %w", command, id, err)
		}
		return nil, nil
	})

	serve("resize_terminal", func(args control.Args) (any, error) {
		const command = "resize_terminal"
		id, err := sessionID(command, args)
		if err != nil {
			return nil, err
		}
		cols, err := size(command, args, "cols")
		if err != nil {
			return nil, err
		}
		rows, err := size(command, args, "rows")
		if err != nil {
			return nil, err
		}
		found, err := held(command, sessions, id)
		if err != nil {
			return nil, err
		}
		if err := deps.Sessions.Resize(found.handle, cols, rows); err != nil {
			return nil, fmt.Errorf("%s: session %d: %w", command, id, err)
		}
		return nil, nil
	})

	serve("close_terminal", func(args control.Args) (any, error) {
		const command = "close_terminal"
		id, err := sessionID(command, args)
		if err != nil {
			return nil, err
		}
		found, exists := sessions.lookup(id)
		if !exists {
			// Closing what is already gone reached the caller's intent. The
			// earlier build answered the same way, and a double close is an
			// ordinary sequence rather than a defect.
			//
			// Closing a pane discards its shell — this build reaps it. The
			// earlier build's other half, where app exit preserved shells under a
			// supervisor, does not hold: nothing outlives the app here, so
			// exiting reaps every session.
			return nil, nil
		}
		if err := deps.Sessions.Close(found.handle); err != nil {
			// The row stays. A shell the owner could not reap is still running,
			// and dropping the id here would make the caller's retry answer
			// "already gone" — a success for work nobody did.
			return nil, fmt.Errorf("%s: session %d: %w", command, id, err)
		}
		// Released only once the owner has confirmed, which is why two closes
		// racing each other can both reach it. An owner already has to tolerate
		// that: a shell can exit under it between any lookup and any call.
		sessions.remove(id)
		return nil, nil
	})

	if flow == nil {
		declare("ack_terminal", ackUnserved)
	} else {
		serve("ack_terminal", func(args control.Args) (any, error) {
			const command = "ack_terminal"
			id, err := sessionID(command, args)
			if err != nil {
				return nil, err
			}
			bytes, err := byteCount(command, args, "bytes")
			if err != nil {
				return nil, err
			}
			found, err := held(command, sessions, id)
			if err != nil {
				return nil, err
			}
			if err := flow.Ack(found.handle, bytes); err != nil {
				return nil, fmt.Errorf("%s: session %d: %w", command, id, err)
			}
			return nil, nil
		})
	}

	serve("pty_pane_alive", func(args control.Args) (any, error) {
		const command = "pty_pane_alive"
		paneID, err := paneArgument(command, args)
		if err != nil {
			return nil, err
		}
		// This says "this process holds a row for that pane" and nothing more.
		// It is not the question the caller asks, and it errs in both
		// directions. An earlier build asked a daemon that outlived the app, so
		// it answered true across a restart before anything reattached; this
		// one answers false there, and a caller reading it an earlier build's
		// way skips a spawn it needs. The costlier direction is the other one:
		// a shell that exits on its own — a user typing exit — is released by
		// the owner, which has no way to say so through the contract below, so
		// the row outlives the shell and this keeps answering true. Closing
		// that needs the owner to report a death or to be asked; both are the
		// injected contract's half, not this table's.
		//
		// Absence is false — an ordinary answer, not a failure.
		_, alive := sessions.pane(paneID)
		return alive, nil
	})

	if foreground == nil {
		declare("pty_pane_pid", panePidUnserved)
	} else {
		serve("pty_pane_pid", func(args control.Args) (any, error) {
			const command = "pty_pane_pid"
			paneID, err := paneArgument(command, args)
			if err != nil {
				return nil, err
			}
			handle, alive := sessions.pane(paneID)
			if !alive {
				// A pane with no session has no foreground group. The
				// earlier build answered Option<i32>, and the caller treats null
				// as "no command is running", which is what is true.
				return nil, nil
			}
			group, err := foreground.ForegroundGroup(handle)
			if err != nil {
				return nil, fmt.Errorf("%s: pane %q: %w", command, paneID, err)
			}
			return group, nil
		})
	}

	// Five commands whose subject does not exist in this generation. Inventing
	// a plausible answer for any of them would report an empty store or a
	// downed component instead of a missing one, and the caller acts on that.
	declare("pty_read_sealed_screen", sealedScreenUnserved)
	declare("pty_sidecar_request", sidecarUnserved)
	declare("pty_daemon_status", daemonStatusUnserved)
	declare("pty_daemon_restart", daemonRestartUnserved)
	declare("pty_daemon_upgrade", daemonUpgradeUnserved)
}

// held finds the session behind an id, failing by name when there is none.
//
// A write or resize that quietly went nowhere reads as a hung shell, and the
// reader then investigates the shell rather than the id.
func held(command string, sessions *table, id uint32) (entry, error) {
	found, exists := sessions.lookup(id)
	if !exists {
		return entry{}, fmt.Errorf("%s: no session %d — it was never opened here, or it was closed or replaced", command, id)
	}
	return found, nil
}
