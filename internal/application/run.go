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

	"encoding/json"
	"fmt"
	terminalsurface "github.com/min-median-max/wails-service-terminal-surface"
	controlwire "github.com/soksak-ai/soksak-contract-control"
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
	"strconv"
	"sync/atomic"
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
var defaultIdentifier = "com.soksak.wails"

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
	processLabel, err := launchProcessLabel(os.Getenv(controlwire.ProcessLabelEnvironment))
	if err != nil {
		return fmt.Errorf("PROCESS_LABEL_INVALID: %w", err)
	}
	presentation, err := presentationFromEnvironment(os.Getenv("SOKSAK_PRESENTATION"))
	if err != nil {
		return err
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
		Home:         resolved.Home,
		Runtime:      resolved.Runtime,
		Spawner:      process.OSSpawner{},
		Environment:  os.Environ(),
		ProcessLabel: processLabel,
		Dial:         sidecar.DialLocal,
		// The application's own session layer starts units by name: the
		// environment record is the resolver, exactly what an installed or
		// developed sidecar declared (a name with no record refuses by name).
		ResolvePath: func(name string) (string, error) {
			unit, err := coreenvironment.ResolveSelectedSidecar(resolved.Home, name)
			if err != nil {
				return "", err
			}
			return unit.Process, nil
		},
		ResolveBindings: func() (map[string]string, error) {
			return coreenvironment.SelectedSidecarBindings(resolved.Home)
		},
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
		Resolve: func(consumer sidecar.Consumer, reference sidecar.DependencyReference) (sidecar.Resolved, error) {
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
			ProcessLabel: processLabel,
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
			return fmt.Errorf("environment initialize: %w", err)
		}
		kv, err := store.OpenKV(filepath.Join(resolved.Home, "soksak.db"))
		if err != nil {
			return err
		}
		defer func() { _ = kv.Close() }()
		fill(kv)

		serveControl(listener, registry, resolved.Identifier, processLabel, func(err error) {
			log.Printf("control plane stopped: %v", err)
		})
		if err := announceControlReady(os.Stdout, resolved, os.Getpid()); err != nil {
			log.Printf("control readiness event failed: %v", err)
		}
		return wails.Run(wails.Options{
			Assets:        assets,
			Identity:      resolved.Identifier,
			TerminalLinks: terminalSurfaceLinks(units),
			TerminalUnitStarts: func(listener func(string)) func() {
				return units.ObserveStarted(func(open sidecar.Open) { listener(open.Name) })
			},
			CaptureProbe: os.Getenv("SOKSAK_CAPTURE_PROBE"),
			Registry:     registry,
			Release:      listener.Close,
			Bridge:       bridge,
			Reapers:      []wails.UnitReaper{units},
			// Declared by whoever started this process. Unset is a person at the application, which
			// is what a launch with nothing stated about it is. A measurement run declares the
			// opposite and gets a window that draws without taking the front.
			Presentation: presentation,
			HostReady: func() {
				if err := announceHostReady(os.Stdout, resolved, os.Getpid()); err != nil {
					log.Printf("host readiness event failed: %v", err)
				}
			},
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

// terminalSurfaceLinks adapts the relay's send half to the terminal surface
// service: one request, one unwrapped answer. The generic Answer shape is the
// wire's own (controlwire.Answer), so a refusal keeps its code.
func terminalSurfaceLinks(units *sidecar.Host) terminalsurface.Links {
	var next atomic.Uint64
	return terminalsurface.Links{Send: func(unit, command string, request map[string]any) (map[string]any, error) {
		// The service socket expects its request under args.request. Flat control-plane args
		// decode as an empty service request.
		payload, err := json.Marshal(request)
		if err != nil {
			return nil, fmt.Errorf("%s %s: %w", unit, command, err)
		}
		args := map[string]json.RawMessage{"request": payload}
		response, err := units.Send(unit, controlwire.Request{
			ID:      "terminal-surface-" + strconv.FormatUint(next.Add(1), 10),
			Command: command,
			Args:    args,
		})
		if err != nil {
			return nil, err
		}
		if !response.Ok {
			return nil, fmt.Errorf("%s %s: %s", unit, command, response.Error)
		}
		encoded, err := json.Marshal(response.Result)
		if err != nil {
			return nil, fmt.Errorf("%s %s: %w", unit, command, err)
		}
		var answer struct {
			Code    string         `json:"code"`
			Message string         `json:"message"`
			Data    map[string]any `json:"data"`
		}
		if err := json.Unmarshal(encoded, &answer); err != nil {
			return nil, fmt.Errorf("%s %s: %w", unit, command, err)
		}
		if answer.Code != "" && answer.Code != "OK" {
			if answer.Message != "" {
				return nil, fmt.Errorf("%s: %s", answer.Code, answer.Message)
			}
			return nil, fmt.Errorf("%s %s answered %s", unit, command, answer.Code)
		}
		if answer.Data == nil {
			answer.Data = map[string]any{}
		}
		return answer.Data, nil
	}}
}
