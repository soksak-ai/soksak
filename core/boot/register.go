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
	"github.com/soksak/soksak-core/core/composition"
	"github.com/soksak/soksak-core/core/control"
	"github.com/soksak/soksak-core/core/daemon"
	"github.com/soksak/soksak-core/core/files"
	"github.com/soksak/soksak-core/core/i18n"
	"github.com/soksak/soksak-core/core/identity"
	"github.com/soksak/soksak-core/core/install"
	corenet "github.com/soksak/soksak-core/core/net"
	"github.com/soksak/soksak-core/core/process"
	"github.com/soksak/soksak-core/core/scan"
	"github.com/soksak/soksak-core/core/secret"
	"github.com/soksak/soksak-core/core/service"
	"github.com/soksak/soksak-core/core/store"
	"github.com/soksak/soksak-core/core/workspace"
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
	// Recent is what a live operator can still see. Separate from Ledger
	// because admission and retention have separate owners, and separate from
	// storage because the process that most needs to be asked what just
	// happened is the one that cannot write.
	Recent *activity.Tail
	// Now supplies timestamps. Passed in so the ledger stays testable and the
	// core keeps reading nothing ambient.
	Now func() int64

	// UserHome is the operating system user's home, which is not Identity.Home.
	// Several rules need to tell them apart — a workspace root may sit anywhere
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

	// Emit delivers an event to the owner of windows. The core determines that
	// something changed; delivery needs a host, so the host supplies this.
	// Nil means nobody is listening, which is what headless is — not an error.
	Emit func(event string, payload any)
	// LiveWindows answers which windows exist. The workspace claim ledger uses it
	// to separate a claim held by a live window from one left behind by a window
	// that closed.
	// Nil answers none, which is the truth with no host.
	LiveWindows func() []string

	// Run starts a process and waits for it. Nil refuses the commands that
	// shell out, by name.
	Run files.Runner
	// Watch is the operating system's filesystem watcher. Nil refuses watch_dir
	// by name, because a subscription that can never fire is not one.
	Watch files.Backend
	// Spawner starts long-lived children. Nil means this host owns none and
	// declares that, rather than answering as if it had.
	Spawner process.Spawner
	// Secrets resolves a child's declared secrets. Nil means this host holds no
	// vault; a spawn that requires one is refused by name, because an empty
	// token turns a missing vault into the child's authentication failure.
	Secrets process.SecretSource
	// ProcessSink is where a child's output and exit reach a consumer.
	ProcessSink process.Sink
	// OS is the operating system this process runs on, as a value. install
	// reports what was installed and where, and reading runtime.GOOS inside
	// would answer what this binary is rather than what the caller asked.
	OS string
	// Arch is the processor family, for the same reason.
	Arch string
	// Keys is the operating system's key store — Keychain, Credential Manager,
	// Secret Service. Nil means this host has no key store, and the vault
	// declares that rather than putting secrets somewhere it cannot protect them.
	Keys secret.KeyStore
	// Reaper answers what a live pid is running. A daemon that cannot ask
	// declares the commands that need it rather than guessing a pid is its own.
	Reaper daemon.Reaper
}

// Wired is state RegisterCore built that a host needs the same instance of.
//
// A host that built its own would answer from a second ledger: releasing a
// window's workspaces would free claims nobody was holding while the real ones
// stayed locked.
type Wired struct {
	// Claims is the workspace claim ledger. The host frees a window's roots when
	// that window is destroyed.
	Claims *workspace.Ledger
	// Processes owns the running children. The host stops them when it quits.
	Processes *process.Manager
	Secrets   process.SecretSource
}

// liveWindows adapts the launcher's function to the interface the claim ledger
// declares. The core takes a function because a function is what a host can
// supply before it has anything to report.
type liveWindows func() []string

func (live liveWindows) Live() []string {
	if live == nil {
		return nil
	}
	return live()
}

// RegisterCore registers the host-independent commands the frontend calls
// during boot. Each is answerable with no window, which is what makes headless
// possible at all.
func RegisterCore(registry *control.Registry, boot Boot) Wired {
	if boot.Recent == nil {
		// A process that was given no tail still keeps one. The alternative is
		// a build that publishes into nothing and answers "nothing happened",
		// which is the state this exists to end.
		boot.Recent = activity.NewTail(0)
	}
	if boot.Ledger == nil {
		boot.Ledger = activity.NewLedger()
	}
	if boot.Now == nil {
		// Zero rather than the wall clock: reading the clock here would make
		// the core decide "now" for itself, which is the launcher's to supply.
		boot.Now = func() int64 { return 0 }
	}
	registry.MustRegister(control.Command{
		Name: "app_environment",
		Handler: func(control.Args) (any, error) {
			return app.Describe(boot.Identity, boot.BuildProfile, boot.LoginShell), nil
		},
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
				return nil, i18n.Errorf("boot.args.missing", map[string]string{"command": "data_kv_set", "name": "value"})
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
			entry := boot.Ledger.Admit(uint64(boot.Now()), kind, source, args["payload"])
			// Kept so it can be asked for. Before this, a renderer exception
			// reached here, was stamped, and was dropped — the only way to read
			// one was to have a person look at the window.
			boot.Recent.Keep(entry)
			return entry, nil
		},
	})

	registry.MustRegister(control.Command{
		Name: "activity_recent",
		Handler: func(args control.Args) (any, error) {
			kinds, err := control.OptionalArg[[]string](args, "kinds", nil)
			if err != nil {
				return nil, err
			}
			limit, err := control.OptionalArg(args, "limit", 0)
			if err != nil {
				return nil, err
			}
			// A list, never null: "nothing has happened" and "this build cannot
			// tell you" must not arrive as the same answer.
			entries := boot.Recent.Recent(kinds, limit)
			if entries == nil {
				entries = []activity.Entry{}
			}
			return entries, nil
		},
	})

	registry.MustRegister(control.Command{
		Name: "service_ledger_sync",
		Handler: func(args control.Args) (any, error) {
			ledger, present := args["ledger"]
			if !present {
				return nil, i18n.Errorf("boot.args.missing", map[string]string{"command": "service_ledger_sync", "name": "ledger"})
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
			// One unit is one directory holding plugin.json, not one .json
			// file. Reading files here answered an empty list for every home
			// that had plugins in it (measured 2026-08-15).
			return scan.Units(filepath.Join(boot.Identity.Home, "plugins"))
		},
	})

	registry.MustRegister(control.Command{
		Name: "plugin_remove",
		Handler: func(args control.Args) (any, error) {
			id, err := control.Arg[string](args, "id")
			if err != nil {
				return nil, err
			}
			return nil, scan.RemoveUnit(filepath.Join(boot.Identity.Home, "plugins"), id)
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

	claims := workspace.NewLedger(liveWindows(boot.LiveWindows))
	workspace.Register(registry, workspace.Deps{
		Home:     boot.Identity.Home,
		UserHome: boot.UserHome,
		Manifest: boot.KV,
		Claims:   claims,
		Changed:  emit,
	})

	vault := secret.Register(registry, secret.Deps{
		KV:       boot.KV,
		KeyStore: boot.Keys,
	})
	secretSource := boot.Secrets
	if secretSource == nil {
		secretSource = vault
	}

	processes := process.Register(registry, process.Deps{
		Home:        boot.Identity.Home,
		Environment: boot.Environment,
		Sink:        boot.ProcessSink,
		Spawner:     boot.Spawner,
		Secrets:     secretSource,
	})

	install.Register(registry, install.Deps{
		Home:       boot.Identity.Home,
		OS:         boot.OS,
		Arch:       boot.Arch,
		LoginShell: boot.LoginShell,
		Run:        boot.Run,
	})

	composition.Register(registry, composition.Deps{Home: boot.Identity.Home})

	daemon.Register(registry, daemon.Deps{
		Spawner:    boot.Spawner,
		LoginShell: boot.LoginShell,
		Windows:    boot.Windows,
		Now:        boot.Now,
		Reaper:     boot.Reaper,
		// The environment rule has one owner. A second copy here would drift the
		// moment either changed, and the way it drifts is that an internal
		// SOKSAK_* stops being stripped — a vault master key in a child's
		// environment, found later in somebody's log.
		Environment: func(overrides map[string]string) []string {
			return process.ChildEnvironment(boot.Environment, boot.Identity.Home, overrides)
		},
		Announce: func(d daemon.Daemon) { emit("daemon:changed", d) },
	})

	// What this build does not answer yet, named with the reason. A
	// caller receives "not built" instead of "unknown command".
	declareUnbuilt(registry)

	return Wired{Claims: claims, Processes: processes, Secrets: secretSource}
}
