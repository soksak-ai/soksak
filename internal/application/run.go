// Command soksak-core launches the workspace.
//
// This file is the door: it reads the ambient once, resolves what installation
// this process is, opens what that installation owns, and hands the result to a
// framework. Nothing below it reads the environment, so the same core answers
// the same way with or without a window.
package application

import (
	"embed"
	"log"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/soksak-ai/soksak-core/core/activity"
	"github.com/soksak-ai/soksak-core/core/boot"
	"github.com/soksak-ai/soksak-core/core/control"
	coreenvironment "github.com/soksak-ai/soksak-core/core/environment"
	"github.com/soksak-ai/soksak-core/core/files"
	"github.com/soksak-ai/soksak-core/core/identity"
	"github.com/soksak-ai/soksak-core/core/process"
	"github.com/soksak-ai/soksak-core/core/sidecar"
	"github.com/soksak-ai/soksak-core/core/store"
	"github.com/soksak-ai/soksak-core/frameworks/wails"
)

// The frontend build is embedded here because embed paths cannot climb out of
// the directory that declares them.
//
// buildProfile describes how this binary was compiled, which is a different
// fact from which installation it serves: a debug build can run the release
// identity.
const buildProfile = "debug"

// defaultIdentifier is what this build serves when the launcher names nothing.
// It is a build fact, not a guess: the core still refuses to derive one.
//
// The environment axis is what separates homes: `~/.soksak-<env>`. A framework
// axis deliberately does not, because one home holds one backend and may have
// several frontends.
//
// So this build takes its own environment rather than a framework name.
// Measured 2026-08-15: `com.soksak.dev` opened ~/.soksak-dev/soksak.db while
// another process held live sockets in that directory. The store is
// single-writer by design and SQLite does not refuse a second writer — it
// serialises — so the collision would have stayed silent.
const defaultIdentifier = "com.soksak.wails"

// startWatcher answers the operating system's watcher, or nil with the reason.
//
// Nil is a state the build declares, not a failure to start: `watch_dir` refuses by name and names
// the host it was refused on. A host that stopped booting over a watcher would trade a directory
// that does not refresh for a window that does not open.
func startWatcher() (files.Backend, error) {
	return files.NewOSWatcher()
}

func Run(assets embed.FS) error {
	identifier := os.Getenv("SOKSAK_IDENTIFIER")
	if identifier == "" {
		identifier = defaultIdentifier
	}

	// The ambient is read here, once, and passed as values. Reading it deeper
	// would let two parts of the process disagree about which home they are in.
	userHome := os.Getenv("HOME")
	if runtime.GOOS == "windows" {
		userHome = os.Getenv("USERPROFILE")
	}
	resolved, err := identity.Require(identifier, identity.Environment{
		Windows:     runtime.GOOS == "windows",
		Home:        os.Getenv("HOME"),
		UserProfile: os.Getenv("USERPROFILE"),
		Persistent:  os.Getenv("SOKSAK_HOME"),
		Runtime:     os.Getenv("SOKSAK_RUNTIME"),
	})
	if err != nil {
		return err
	}

	// The half of the host that does not exist yet. The registry is filled
	// before the framework starts, so the commands that need to reach a window
	// are handed this and Run fills it in.
	bridge := &wails.Bridge{}

	// The units a plugin declares are started here rather than by the host: a process needs no
	// window, and a unit only a windowed process could start would put this outside headless for no
	// reason the code requires.
	//
	// Nothing about any particular unit is named. This host resolves a declared name to what an
	// install put on disk, starts it, and relays — the shell that used to be built into this binary
	// is a unit like any other now, and adding the next one edits no line here.
	units := sidecar.NewHost(sidecar.Deps{
		Home:        resolved.Home,
		Runtime:     resolved.Runtime,
		Spawner:     process.OSSpawner{},
		Environment: os.Environ(),
		Dial:        sidecar.DialLocal,
	})

	// Started before the registry so `watch_dir` is either served or refused by name from the first
	// command, never accepted and silently dead.
	watcher, watcherErr := startWatcher()
	if watcherErr != nil {
		// Reported once, at the edge; after that the refusal by name is the record. A host with no
		// watcher serves every other command normally.
		log.Println("soksak: no filesystem watcher:", watcherErr)
	}

	registry := control.NewRegistry()
	sidecar.Register(registry, sidecar.Registration{
		Host: units,
		Resolve: func(consumer sidecar.Consumer, reference sidecar.ReleaseReference) (sidecar.Resolved, error) {
			runtime, err := coreenvironment.ResolveSidecarForPlugin(resolved.Home, coreenvironment.PluginRef{ID: consumer.ID, Version: consumer.Version}, coreenvironment.PluginRef{ID: reference.ID, Version: reference.Version})
			if err != nil {
				return sidecar.Resolved{}, err
			}
			return sidecar.Resolved{Name: runtime.ID, Version: runtime.Version, Path: runtime.Process}, nil
		},
		Sink: wails.NewSidecarSink(bridge),
	})
	// Filled once the home is ours. Nothing this installation owns — least of
	// all its database — is touched by a process that has not claimed it.
	fill := func(kv *store.KV) {
		wired := boot.RegisterCore(registry, boot.Boot{
			Identity:     resolved,
			BuildProfile: buildProfile,
			KV:           kv,
			Ledger:       activity.NewLedger(),
			Recent:       activity.NewTail(0),
			Now:          func() int64 { return time.Now().UnixMilli() },

			UserHome:    userHome,
			LoginShell:  loginShell(),
			Windows:     runtime.GOOS == "windows",
			OS:          runtime.GOOS,
			Arch:        runtime.GOARCH,
			PID:         os.Getpid(),
			Environment: os.Environ(),
			PidAlive:    pidAlive,

			Emit:        bridge.Emit,
			LiveWindows: bridge.Live,

			Run: files.SystemRunner{},
			// The operating system's watcher. A host that could not start one passes nil, and
			// `watch_dir` is refused by name rather than accepting a subscription that can never
			// fire — which is what this binary did until 2026-08-17, with the file tree's live
			// refresh dead and three renderer errors in the activity stream saying so.
			Watch:   watcher,
			Spawner: process.OSSpawner{},
			Secrets: nil,
			Keys:    newSystemKeyStore(resolved.Identifier, keyStoreLabel(runtime.GOOS)),
			// No process inspector either: a daemon that cannot ask what a pid
			// is running declares the commands that need it, rather than
			// assuming a live pid is the child it started.
			Reaper:      nil,
			ProcessSink: processEventSink{bridge: bridge},
		})
		units.SetSecrets(wired.Secrets)
	}

	// The home is claimed before anything is drawn — see launch. Everything this
	// application can do is reachable from outside it, which is what makes a
	// feature verifiable rather than only clickable.
	err = launch(resolved, control.Listen, func(listener net.Listener) error {
		if err := coreenvironment.Initialize(resolved.Home); err != nil {
			return err
		}
		kv, err := store.OpenKV(filepath.Join(resolved.Home, "soksak.db"))
		if err != nil {
			return err
		}
		defer func() { _ = kv.Close() }()
		fill(kv)

		serveControl(listener, registry, resolved.Identifier, func(err error) {
			log.Printf("control plane stopped: %v", err)
		})
		return wails.Run(wails.Options{
			Assets:       assets,
			CaptureProbe: os.Getenv("SOKSAK_CAPTURE_PROBE"),
			Registry:     registry,
			Release:      listener.Close,
			Bridge:       bridge,
			Reapers:      []wails.UnitReaper{units},
			// Declared by whoever started this process. Unset is a person at the application, which
			// is what a launch with nothing stated about it is. A measurement run declares the
			// opposite and gets a window that draws without taking the front.
			Attended:         os.Getenv("SOKSAK_UNATTENDED") == "",
			PluginAssetRoots: func() ([]string, error) { return installedPluginRoots(resolved.Home) },
		})
	})
	return err
}

func installedPluginRoots(home string) ([]string, error) {
	records, err := coreenvironment.PluginManifests(home)
	if err != nil {
		return nil, err
	}
	roots := []string{}
	for _, record := range records {
		if record.Error == nil {
			roots = append(roots, record.InstallPath)
		}
	}
	return roots, nil
}
