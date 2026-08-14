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
	"os"
	"path/filepath"
	"runtime"

	"github.com/soksak/soksak-core/core/control"
	"github.com/soksak/soksak-core/core/identity"
	"github.com/soksak/soksak-core/core/store"
	"github.com/soksak/soksak-core/frameworks/wails"
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
const defaultIdentifier = "com.soksak.dev"

func main() {
	identifier := os.Getenv("SOKSAK_IDENTIFIER")
	if identifier == "" {
		identifier = defaultIdentifier
	}

	// The ambient is read here, once, and passed as values. Reading it deeper
	// would let two parts of the process disagree about which home they are in.
	resolved, err := identity.Require(identifier, identity.Environment{
		Windows:     runtime.GOOS == "windows",
		Home:        os.Getenv("HOME"),
		UserProfile: os.Getenv("USERPROFILE"),
	})
	if err != nil {
		log.Fatal(err)
	}

	kv, err := store.OpenKV(filepath.Join(resolved.Home, "soksak.db"))
	if err != nil {
		log.Fatal(err)
	}
	defer func() { _ = kv.Close() }()

	registry := control.NewRegistry()
	control.RegisterCore(registry, control.Boot{
		Identity:     resolved,
		BuildProfile: buildProfile,
		KV:           kv,
	})

	err = wails.Run(wails.Options{
		Assets:             assets,
		TraceTerminalInput: os.Getenv("SOKSAK_TERMINAL_INPUT_TRACE") == "1",
		CaptureProbe:       os.Getenv("SOKSAK_CAPTURE_PROBE"),
		Registry:           registry,
	})
	if err != nil {
		log.Fatal(err)
	}
}
