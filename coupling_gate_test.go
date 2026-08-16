package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The core names no plugin and no rendering engine (C1).
//
// A core that holds one plugin's id has that plugin as a dependency whether or
// not it imports it: removing the plugin then leaves a name behind that resolves
// to nothing, and the next plugin needs an edit here to be equal to it. The same
// holds for an engine — a core written against one cannot host a terminal built
// on anything else.
//
// Measured 2026-08-15: a saved-session migration table mapped an old plugin id
// to a new one, and the frontend carried six @xterm packages behind one dead
// file. Both are gone; this keeps them gone.
//
// The composition root is not the core. main.go names the plugins it wires,
// which is what a composition root is for, and it is not scanned.
//
// frameworks/ IS scanned. It was exempt as "the host", and that exemption is
// how a browser feature reached this repository: the host held the rule that
// decided which content view event a moved property became, including whether
// a step backwards existed (measured 2026-08-16). Wiring a plugin is one line
// and it is allowed by file below; holding a plugin's rule is not.
var (
	pluginName = regexp.MustCompile(`soksak-plugin-[a-z0-9]+(-[a-z0-9]+)*`)
	engineName = regexp.MustCompile(`(?i)@xterm/|xterm\.js|codemirror|monaco-editor`)
)

// couplingAllowed is a name that reads like a plugin but is not one. Each entry
// states why: an allowlist with no reasons grows until the gate means nothing
// (C5).
var couplingAllowed = map[string]string{
	"soksak-plugin-registry": "the discovery index every plugin is listed in, not a plugin",
}

// couplingWiring is a file in frameworks/ that may name a plugin, and why.
//
// Two of these are debts, said so here rather than left to be discovered. A
// debt with a reason written next to it is a thing someone can pay; an
// unexplained exemption is the shape the browser rule hid inside.
var couplingWiring = map[string]string{
	"frameworks/wails/host.go": "the Wails host's composition root — it constructs the plugins this " +
		"binary ships with and hands each one what it needs. Every line here is a construction or a " +
		"hand-off; a rule about what a plugin's data means belongs to the plugin.",
	"frameworks/wails/register.go": "DEBT: HostDeps.Sessions is typed terminalcmd.Sessions. The " +
		"interface is the plugin's, so a second terminal plugin needs a second field. The core owns " +
		"no session contract yet for it to be typed against.",
	"frameworks/wails/terminal_sink.go": "DEBT: EmitTerminalInputTrace takes terminal.Handle and " +
		"terminal.InputTrace. EmitStream beside it names nothing and is the shape the trace should " +
		"take; the core owns no trace contract yet.",
}

func TestTheCoreNamesNoPluginAndNoEngine(t *testing.T) {
	var plugins []string
	var engines []string
	scanned := 0

	for _, root := range []string{filepath.Join("frontend", "src"), "core", "frameworks"} {
		err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return err
			}
			if info.IsDir() {
				if skippedTrees[info.Name()] {
					return filepath.SkipDir
				}
				return nil
			}
			if !scannedCode[filepath.Ext(path)] {
				return nil
			}
			clean := filepath.ToSlash(path)
			// A test may name a plugin: it is the caller in that moment, and a
			// fixture that named nothing would prove nothing.
			if strings.Contains(clean, ".test.") || strings.HasSuffix(clean, "_test.go") {
				return nil
			}
			body, readErr := os.ReadFile(path)
			if readErr != nil {
				return readErr
			}
			scanned++
			_, wiring := couplingWiring[clean]
			for index, line := range strings.Split(string(body), "\n") {
				for _, name := range pluginName.FindAllString(line, -1) {
					if _, allowed := couplingAllowed[name]; allowed {
						continue
					}
					if wiring {
						continue
					}
					plugins = append(plugins, clean+":"+itoa(index+1)+" "+name)
				}
				if engine := engineName.FindString(line); engine != "" {
					engines = append(engines, clean+":"+itoa(index+1)+" "+engine)
				}
			}
			return nil
		})
		if err != nil {
			t.Fatalf("scanning %s: %v", root, err)
		}
	}
	if scanned == 0 {
		t.Fatal("no core source was scanned; the roots are wrong")
	}

	if len(plugins) > 0 {
		t.Errorf("the core names a plugin in %d places:\n%s\n"+
			"Take the name out. A plugin declares what it is; the core reads the declaration.",
			len(plugins), strings.Join(plugins, "\n"))
	}
	if len(engines) > 0 {
		t.Errorf("the core names a rendering engine in %d places:\n%s\n"+
			"The engine belongs to the plugin that renders with it.",
			len(engines), strings.Join(engines, "\n"))
	}
}

// An exemption outliving the file it excuses is how an allowlist stops meaning
// anything (C5). The list is checked against the tree, not trusted.
func TestEveryWiringExemptionStillHasAFile(t *testing.T) {
	for path, reason := range couplingWiring {
		if strings.TrimSpace(reason) == "" {
			t.Errorf("%s is exempt for no stated reason", path)
		}
		if _, err := os.Stat(filepath.FromSlash(path)); err != nil {
			t.Errorf("%s is exempt and does not exist: %v\nTake the entry out.", path, err)
		}
	}
}

// An exemption that excuses nothing is the same defect from the other side: the
// file stopped naming a plugin and the entry stayed, so the next file to be
// added under that path inherits a pass nobody granted it.
func TestEveryWiringExemptionStillExcusesSomething(t *testing.T) {
	for path := range couplingWiring {
		body, err := os.ReadFile(filepath.FromSlash(path))
		if err != nil {
			continue // the test above reports this
		}
		if !pluginName.Match(body) {
			t.Errorf("%s names no plugin and is still exempt.\nTake the entry out.", path)
		}
	}
}
