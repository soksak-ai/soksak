// Command soksak-core launches the workspace.
//
// This file is the door: it owns the embedded frontend and picks the framework
// that will run it. Nothing else in this module names a framework.
package main

import (
	"embed"
	"log"
	"os"

	"github.com/soksak/soksak-core/frameworks/wails"
)

// The frontend build is embedded here because embed paths cannot climb out of
// the directory that declares them.
//
//go:embed all:frontend/dist
var assets embed.FS

func main() {
	err := wails.Run(wails.Options{
		Assets:             assets,
		TraceTerminalInput: os.Getenv("SOKSAK_TERMINAL_INPUT_TRACE") == "1",
	})
	if err != nil {
		log.Fatal(err)
	}
}
