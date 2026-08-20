package main

import (
	"os/exec"
	"sort"
	"strings"
	"testing"
)

// The core binary links no plugin (C1a).
//
// A plugin is installed. What the core reads to assemble it is the manifest and the artefacts
// beside it, never an import. A plugin whose package is in this binary is not installed, it is
// compiled: removing it breaks the build, adding the next one edits the core, and A9 — a plugin
// costs the core no diff — is false for both.
//
// The text scan in `coupling_gate_test.go` cannot see this. It allows one file as the composition
// root, and a composition root that requires a rebuild to compose is a build step wearing the name.
// What the linker did is a different reading, and it is the one that settles whether a plugin is
// installed or built in.
//
// Measured 2026-08-20: two packages, both the terminal unit's, imported by `main.go` and
// `frameworks/wails/host.go`.
//
// A third was the browser unit's, and it was never that unit's code. Its 1,290 lines of Go and
// Objective-C create, move, navigate and report a child web view — the capability `api.ts` declares
// as `app.webview`, which every unit holding the `webview` permission is served by. It was one
// unit's by where the file sat and by nothing else, and it now stands as the host service it is
// (`wails-services/wails-service-webview-surface`).
//
// What remains is the terminal unit's, and it is a different case: it stages a binary, spawns it,
// waits for it, supervises it and relays to it, which `core/daemon` and `core/process` already do
// for any declared process. Nothing has to move for it to go — the manifest has to declare the
// process, and this one does not.
//
// The rule is absolute and this gate is a ratchet, which are not the same thing and both are true.
// The rule — no plugin package in the core binary — is stated in full in `ARCHITECTURE.md` C1a and
// nothing here softens it. What this gate can do today is refuse the debt growing: a fourth package
// fails, and so does a third when one has gone, because a debt that shrinks without the number
// moving is a debt the next one can hide behind.
//
// Failing outright instead would leave the whole suite red for as long as the engine host takes,
// and a gate everyone runs past is worth less than one that blocks the next step. The debt is
// listed as not done in `GATES.md`, which is where a standard that is not met yet is named.
const linkedPluginDebt = 2

func TestTheCoreBinaryLinksNoPlugin(t *testing.T) {
	out, err := exec.Command("go", "list", "-deps", "./...").Output()
	if err != nil {
		t.Fatalf("reading the dependency graph: %v", err)
	}

	seen := map[string]bool{}
	for _, line := range strings.Split(string(out), "\n") {
		path := strings.TrimSpace(line)
		if strings.Contains(path, "/soksak-plugin-") {
			seen[path] = true
		}
	}
	linked := make([]string, 0, len(seen))
	for path := range seen {
		linked = append(linked, path)
	}
	sort.Strings(linked)

	if len(linked) > linkedPluginDebt {
		t.Fatalf("the core binary links %d plugin packages and the debt written down is %d:\n  %s\n"+
			"A plugin is installed, not compiled. Adding one here makes the core need a rebuild to "+
			"gain a plugin, which is what C1a refuses.",
			len(linked), linkedPluginDebt, strings.Join(linked, "\n  "))
	}
	if len(linked) < linkedPluginDebt {
		t.Fatalf("the core binary links %d plugin packages and the debt written down is %d.\n"+
			"One went. Lower linkedPluginDebt to %d so the next one cannot come back unnoticed.",
			len(linked), linkedPluginDebt, len(linked))
	}
}
