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
// Measured 2026-08-20: none. The core binary links no plugin package.
//
// It linked three that morning. The browser unit's native half was never that unit's — it drives a
// child web view, which every unit holding the `webview` permission is served by, so it is the host
// service it always was. The terminal unit's staged, spawned, supervised and relayed to a daemon,
// which `core/daemon` and `core/sidecar` already do for any declared process; nothing had to move
// for it to go, only the manifest had to declare the unit.
//
// The rule and the reading are one number now.
//
// They were two: a ratchet held the count at a written-down debt, so a build with the debt still in
// it was green under a test named for the rule. That is a test answering a question nobody asked —
// "is the debt what it was" — while the one in its name went unanswered, and a debt that a green
// test reports is a debt nobody is looking at.
//
// A ratchet was right while the count could only come down slowly. It came down to zero in a day,
// and keeping the machinery would leave the next person a dial to turn instead of a rule to keep.

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

	if len(linked) != 0 {
		t.Fatalf("the core binary links %d plugin package(s):\n  %s\n"+
			"A plugin is installed, not compiled. A package here makes the core need a rebuild to gain "+
			"a plugin, and makes removing that plugin break the build — which is what C1a refuses.\n"+
			"What it needs instead: the plugin declares what it needs in its manifest, and the core "+
			"reads the declaration.",
			len(linked), strings.Join(linked, "\n  "))
	}
}
