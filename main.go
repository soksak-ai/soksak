// Command soksak-core launches the workspace.
//
// This file is the door: it reads the ambient once, resolves what installation
// this process is, opens what that installation owns, and hands the result to a
// framework. Nothing below it reads the environment, so the same core answers
// the same way with or without a window.
package main

import (
	"embed"
	"log"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/soksak/soksak-core/core/activity"
	"github.com/soksak/soksak-core/core/boot"
	"github.com/soksak/soksak-core/core/control"
	"github.com/soksak/soksak-core/core/files"
	"github.com/soksak/soksak-core/core/identity"
	"github.com/soksak/soksak-core/core/process"
	"github.com/soksak/soksak-core/core/store"
	"github.com/soksak/soksak-core/frameworks/wails"
	terminalplugin "github.com/soksak/soksak-plugin-terminal-xterm"
)

// The frontend build is embedded here because embed paths cannot climb out of
// the directory that declares them.
//
//go:embed all:frontend/dist
var assets embed.FS

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

func main() {
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
	})
	if err != nil {
		log.Fatal(err)
	}

	// The half of the host that does not exist yet. The registry is filled
	// before the framework starts, so the commands that need to reach a window
	// are handed this and Run fills it in.
	bridge := &wails.Bridge{}

	// The session owner is built here rather than by the host: a PTY needs no
	// window, and a terminal that only a windowed process could have would put
	// this group outside headless for no reason the code requires.
	terminals := terminalplugin.NewService(
		wails.NewTerminalSink(bridge, os.Getenv("SOKSAK_TERMINAL_INPUT_TRACE") == "1"),
		terminalplugin.DefaultOptions(),
	)

	registry := control.NewRegistry()
	// Filled once the home is ours. Nothing this installation owns — least of
	// all its database — is touched by a process that has not claimed it.
	fill := func(kv *store.KV) {
		boot.RegisterCore(registry, boot.Boot{
			Identity:     resolved,
			BuildProfile: buildProfile,
			KV:           kv,
			Ledger:       activity.NewLedger(),
			Recent:       activity.NewTail(0),
			Now:          func() int64 { return time.Now().UnixMilli() },

			UserHome:    userHome,
			LoginShell:  os.Getenv("SHELL"),
			Windows:     runtime.GOOS == "windows",
			OS:          runtime.GOOS,
			Arch:        runtime.GOARCH,
			PID:         os.Getpid(),
			Environment: os.Environ(),
			PidAlive:    pidAlive,

			Emit:        bridge.Emit,
			LiveWindows: bridge.Live,

			Run: files.SystemRunner{},
			// No filesystem watcher is built into this binary yet, so watch_dir is
			// refused by name rather than accepting a subscription that can never
			// fire.
			Watch:   nil,
			Spawner: process.OSSpawner{},
			// This host holds no vault. A spawn that asks for a secret is refused
			// by name; handing back an empty value would surface later as the
			// child's own authentication failure.
			Secrets: nil,
			// No operating-system key store is wired into this binary yet, so
			// the vault refuses by name rather than holding secrets somewhere it
			// cannot protect them.
			Keys: nil,
			// No process inspector either: a daemon that cannot ask what a pid
			// is running declares the commands that need it, rather than
			// assuming a live pid is the child it started.
			Reaper:      nil,
			ProcessSink: processEventSink{bridge: bridge},
		})
	}

	// The home is claimed before anything is drawn — see launch. Everything this
	// application can do is reachable from outside it, which is what makes a
	// feature verifiable rather than only clickable.
	err = launch(resolved, control.Listen, func(listener net.Listener) error {
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
			Bridge:       bridge,
			Terminal:     terminals,
			UnitRoot:     filepath.Join(resolved.Home, "plugins"),
		})
	})
	if err != nil {
		log.Fatal(err)
	}
}
