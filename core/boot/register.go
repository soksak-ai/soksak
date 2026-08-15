// Package boot is the backend's composition root: the one place that names every
// feature package and joins them to the registry.
//
// It exists so control stays a registry and nothing else. A registry that
// imports the features it holds cannot be imported by them, and every feature
// needs it — that cycle is what this package breaks. The frontend's src/boot
// plays the same part on the other side.
package boot

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"

	"github.com/soksak/soksak-core/core/activity"
	"github.com/soksak/soksak-core/core/app"
	"github.com/soksak/soksak-core/core/control"
	"github.com/soksak/soksak-core/core/files"
	"github.com/soksak/soksak-core/core/identity"
	corenet "github.com/soksak/soksak-core/core/net"
	"github.com/soksak/soksak-core/core/process"
	"github.com/soksak/soksak-core/core/project"
	"github.com/soksak/soksak-core/core/scan"
	"github.com/soksak/soksak-core/core/service"
	"github.com/soksak/soksak-core/core/store"
	"github.com/soksak/soksak-core/core/terminal"
)

// Boot is the state a process holds rather than receives per call.
//
// Callers send arguments; identity, home, and the database path are what this
// process is. Taking them per call would let one caller point the process at
// another installation.
type Boot struct {
	Identity     identity.Resolved
	BuildProfile string
	KV           *store.KV
	// Ledger stamps activity entries. Admission happens here even with no
	// window, because a record with a hole where the headless work happened is
	// worse than no record.
	Ledger *activity.Ledger
	// Now supplies timestamps. Passed in so the ledger stays testable and the
	// core keeps reading nothing ambient.
	Now func() int64

	// UserHome is the operating system user's home, which is not Identity.Home.
	// Several rules need to tell them apart — a project root may sit anywhere
	// under the first and nowhere under the second.
	UserHome string
	// LoginShell is the shell to build a command line with. Empty refuses the
	// commands that need one by name rather than reading $SHELL, which would
	// tie the answer to whatever launched this process.
	LoginShell string
	// Windows is the platform, as an argument. Reading runtime.GOOS here would
	// answer what this binary is rather than what the caller asked.
	Windows bool
	// PID names this process's work files, so a live owner's file is never
	// taken for crash debris.
	PID int
	// Environment is the environment the launcher inherited, as "K=V". It
	// travels as values because a Go child either inherits everything or
	// receives exactly what it is given.
	Environment []string
	// PidAlive answers whether a pid is still running. That question has a
	// different answer on every platform, so the branch stays with the caller.
	PidAlive func(pid int) bool

	// Emit carries an event to whoever owns windows. The core decides that
	// something changed; delivery needs a host, so the host supplies this.
	// Nil means nobody is listening, which is what headless is — not an error.
	Emit func(event string, payload any)
	// LiveWindows answers which windows exist. The project claim ledger tells a
	// claim held by a live window from one left behind by a window that closed.
	// Nil answers none, which is the truth with no host.
	LiveWindows func() []string

	// Run starts a process and waits for it. Nil refuses the commands that
	// shell out, by name.
	Run files.Runner
	// Watch is the operating system's filesystem watcher. Nil refuses watch_dir
	// by name, because a subscription that can never fire is not one.
	Watch files.Backend
	// Spawner starts long-lived children. Nil means this host owns none and
	// says so, rather than answering as if it had.
	Spawner process.Spawner
	// Secrets resolves a child's declared secrets. Nil means this host holds no
	// vault; a spawn that asks for one is refused by name, because an empty
	// token turns a missing vault into the child's authentication failure.
	Secrets process.SecretSource
	// ProcessSink is where a child's output and exit reach a consumer.
	ProcessSink process.Sink
	// Sessions owns the pseudo-terminals. The launcher builds it, because a
	// pseudo-terminal needs no window and a terminal only a windowed process
	// could have would leave this group outside headless for no reason the code
	// requires.
	Sessions terminal.Sessions
}

// Wired is state RegisterCore built that a host needs the same instance of.
//
// A host that built its own would answer from a second ledger: releasing a
// window's projects would free claims nobody was holding while the real ones
// stayed locked.
type Wired struct {
	// Claims is the project claim ledger. The host frees a window's roots when
	// that window is destroyed.
	Claims *project.Ledger
	// Processes owns the running children. The host stops them when it quits.
	Processes *process.Manager
}

// liveWindows adapts the launcher's function to the interface the claim ledger
// declares. The core asks for a function because a function is what a host can
// supply before it has anything to report.
type liveWindows func() []string

func (live liveWindows) Live() []string {
	if live == nil {
		return nil
	}
	return live()
}

// RegisterCore registers the host-independent commands the frontend asks for
// during boot. Each is answerable with no window, which is what makes headless
// possible at all.
func RegisterCore(registry *control.Registry, boot Boot) Wired {
	registry.MustRegister(control.Command{
		Name:    "app_environment",
		Handler: func(control.Args) (any, error) { return app.Describe(boot.Identity, boot.BuildProfile), nil },
	})

	registry.MustRegister(control.Command{
		Name:    "app_is_release",
		Handler: func(control.Args) (any, error) { return boot.Identity.Release, nil },
	})

	registry.MustRegister(control.Command{
		Name: "data_kv_get",
		Handler: func(args control.Args) (any, error) {
			ns, err := control.Arg[string](args, "ns")
			if err != nil {
				return nil, err
			}
			key, err := control.Arg[string](args, "key")
			if err != nil {
				return nil, err
			}
			value, found, err := boot.KV.Get(ns, key)
			if err != nil {
				return nil, err
			}
			if !found {
				// Absence is null, not an error: the first read of every
				// setting would otherwise fail.
				return nil, nil
			}
			// Values are stored as JSON text, so they return as they were
			// written rather than through a second encoding.
			var decoded any
			if err := json.Unmarshal([]byte(value), &decoded); err != nil {
				return value, nil
			}
			return decoded, nil
		},
	})

	registry.MustRegister(control.Command{
		Name: "data_kv_set",
		Handler: func(args control.Args) (any, error) {
			ns, err := control.Arg[string](args, "ns")
			if err != nil {
				return nil, err
			}
			key, err := control.Arg[string](args, "key")
			if err != nil {
				return nil, err
			}
			raw, present := args["value"]
			if !present {
				return nil, fmt.Errorf("missing argument %q", "value")
			}
			return nil, boot.KV.Set(ns, key, string(raw))
		},
	})

	registry.MustRegister(control.Command{
		Name: "activity_publish",
		Handler: func(args control.Args) (any, error) {
			kind, err := control.Arg[string](args, "kind")
			if err != nil {
				return nil, err
			}
			source, err := control.Arg[string](args, "source")
			if err != nil {
				return nil, err
			}
			// The stamped entry is returned so the caller can fan it out. The
			// halves that need a window are not this command's to perform.
			return boot.Ledger.Admit(uint64(boot.Now()), kind, source, args["payload"]), nil
		},
	})

	registry.MustRegister(control.Command{
		Name: "unit_dev_list",
		Handler: func(control.Args) (any, error) {
			// Development units are declared under the home. A fresh home has
			// none, which is an empty list rather than a failure.
			return scan.Directory(filepath.Join(boot.Identity.Home, "units"), ".json")
		},
	})

	registry.MustRegister(control.Command{
		Name: "service_ledger_sync",
		Handler: func(args control.Args) (any, error) {
			ledger, present := args["ledger"]
			if !present {
				return nil, fmt.Errorf("missing argument %q", "ledger")
			}
			// Identical content is left alone, so the file's mtime only moves
			// when the bindings actually changed.
			_, err := service.WriteLedger(filepath.Join(boot.Identity.Home, "services", "ledger.json"), ledger)
			return nil, err
		},
	})

	registry.MustRegister(control.Command{
		Name: "net_http_request",
		Handler: func(args control.Args) (any, error) {
			var request corenet.Request
			encoded, err := json.Marshal(map[string]json.RawMessage(args))
			if err != nil {
				return nil, err
			}
			if err := json.Unmarshal(encoded, &request); err != nil {
				return nil, fmt.Errorf("net_http_request: %w", err)
			}
			return corenet.Do(context.Background(), request)
		},
	})

	registry.MustRegister(control.Command{
		Name: "themes_scan",
		Handler: func(control.Args) (any, error) {
			return scan.Directory(filepath.Join(boot.Identity.Home, "themes"), ".json")
		},
	})

	registry.MustRegister(control.Command{
		Name: "plugin_scan",
		Handler: func(control.Args) (any, error) {
			return scan.Directory(filepath.Join(boot.Identity.Home, "plugins"), ".json")
		},
	})

	return registerGroups(registry, boot)
}

// registerGroups joins the ported command groups to the same registry.
//
// Each one takes what it needs as values and declares what a missing dependency
// means, so this reads as a list of what the process has rather than as a list
// of what it can do.
func registerGroups(registry *control.Registry, boot Boot) Wired {
	emit := boot.Emit
	if emit == nil {
		// A host with nowhere to deliver is headless, not broken. The commands
		// still answer; only the fan-out is absent.
		emit = func(string, any) {}
	}

	store.Register(registry, store.Deps{
		KV:        boot.KV,
		Home:      boot.Identity.Home,
		NowMillis: boot.Now,
		PID:       boot.PID,
		PidAlive:  boot.PidAlive,
		Notify:    func(change store.Change) { emit("store:change", change) },
	})

	files.Register(registry, files.Deps{
		UserHome:   boot.UserHome,
		LoginShell: boot.LoginShell,
		Windows:    boot.Windows,
		Run:        boot.Run,
		Watch:      boot.Watch,
		EmitChange: func(dir string) { emit("files:changed", map[string]string{"dir": dir}) },
	})

	claims := project.NewLedger(liveWindows(boot.LiveWindows))
	project.Register(registry, project.Deps{
		Home:     boot.Identity.Home,
		UserHome: boot.UserHome,
		Manifest: boot.KV,
		Claims:   claims,
		Changed:  emit,
	})

	processes := process.Register(registry, process.Deps{
		Home:        boot.Identity.Home,
		Environment: boot.Environment,
		Sink:        boot.ProcessSink,
		Spawner:     boot.Spawner,
		Secrets:     boot.Secrets,
	})

	if boot.Sessions != nil {
		terminal.Register(registry, terminal.Deps{Sessions: boot.Sessions})
	} else {
		// A process given no session owner holds no pseudo-terminal. Saying so
		// is the point: a caller that hears "unknown command" cannot tell that
		// from a command this build forgot.
		for _, name := range terminal.CommandNames() {
			if err := registry.DeclareUnserved(name, "this process was given no session owner and holds no pseudo-terminal"); err != nil {
				panic(err)
			}
		}
	}

	return Wired{Claims: claims, Processes: processes}
}
