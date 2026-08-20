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
// Measured 2026-08-20: three packages, imported by `main.go` and `frameworks/wails/host.go`.
//
// The debt stands until the two native halves move behind the seam that exists for them. Their
// reason for being in this process is real — a parent view is process-local on macOS and a message
// pump needs this process's main queue — and it is a reason to be *loaded* here, not to be *built*
// here (SIDECARS.md S3). What is missing is the host that loads one.
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
const linkedPluginDebt = 3

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
