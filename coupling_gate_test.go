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

// The core names no domain concept either (C1, C6).
//
// The scan above reads names. This one reads concepts, because they are two
// different couplings and only one of them is spelled out. A core that writes
// no plugin id and still holds `Bookmark { url, title }`, three `bookmark.*`
// commands and the browser panel's stylesheet is coupled to a browser exactly
// as hard as one that imports it — and the second browser plugin can use none
// of it, because all of it was shaped for the first.
//
// Measured 2026-08-16: the id scan had been green for a day while every one of
// those was in the tree.
//
// C6 puts membership to three questions — named after no domain, usable by a
// plugin that never heard of the first consumer, impossible across the plugin
// boundary. A word below is one that fails the first question outright: it names
// one kind of content, so the code carrying it was written for one plugin.
//
// Comments are stripped before the scan. A measurement has to be able to say a
// browser was created in the wrong window; that record is why the defect is
// known, and a gate that forbade writing it down would trade a coupling for a
// blindness.
//
// This list holds what has been measured, and it is not the rule — the rule is
// C6 and it is wider than any word list. A concept absent here is not thereby
// allowed; it is unmeasured.
var domainWord = map[string]string{
	"bookmark":   "a browser's saved page — the browser plugin's, stored under its own namespace in app.data",
	"favicon":    "a browser's page icon. The core has a general one: a view reports an icon and the manifest icon is the fallback",
	"incognito":  "a browser's private session",
	"omnibox":    "a browser's address bar",
	"urlbar":     "a browser's address bar",
	"tabstrip":   "a browser's tab row. The core draws view tabs, which are not that",
	"zsh":        "one shell. The core owns the PTY and no list of shells (ARCHITECTURE, C6 question three)",
	"/bin/bash":  "one shell, by path",
	"powershell": "one shell",
	"conpty":     "one platform's PTY implementation — the terminal plugin's concern on Windows",
	"osc7":       "a shell integration sequence; what a byte from a shell means belongs to the plugin reading it",
	"osc133":     "a shell integration sequence",
}

// domainAllowed is a place a domain word appears and is not the coupling, with
// the reason. Same discipline as couplingAllowed: no entry without one (C5).
//
// Empty, and the checks below stay: an exemption is a thing someone adds with a
// reason, not a list that starts full and is trusted afterwards.
var domainAllowed = map[string]string{}

// A comment is stripped, and a string a person reads is not: a sentence in a
// bundle is the core stating the concept to a user, which is the coupling in its
// most visible form.
func stripComments(body string) string {
	var out strings.Builder
	inBlock := false
	for _, line := range strings.Split(body, "\n") {
		for len(line) > 0 {
			if inBlock {
				end := strings.Index(line, "*/")
				if end < 0 {
					line = ""
					break
				}
				line = line[end+2:]
				inBlock = false
				continue
			}
			block := strings.Index(line, "/*")
			slash := strings.Index(line, "//")
			if slash >= 0 && (block < 0 || slash < block) {
				out.WriteString(line[:slash])
				line = ""
				break
			}
			if block >= 0 {
				out.WriteString(line[:block])
				line = line[block+2:]
				inBlock = true
				continue
			}
			out.WriteString(line)
			line = ""
		}
		out.WriteString("\n")
	}
	return out.String()
}

func TestTheCoreNamesNoDomainConcept(t *testing.T) {
	var found []string
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
			ext := filepath.Ext(path)
			if !scannedCode[ext] && ext != ".css" {
				return nil
			}
			clean := filepath.ToSlash(path)
			if strings.Contains(clean, ".test.") || strings.HasSuffix(clean, "_test.go") {
				return nil
			}
			if _, allowed := domainAllowed[clean]; allowed {
				return nil
			}
			body, readErr := os.ReadFile(path)
			if readErr != nil {
				return readErr
			}
			scanned++
			for index, line := range strings.Split(stripComments(string(body)), "\n") {
				lower := strings.ToLower(line)
				for word, owner := range domainWord {
					if strings.Contains(lower, word) {
						found = append(found, clean+":"+itoa(index+1)+" "+word+" — "+owner)
					}
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
	if len(found) > 0 {
		t.Errorf("the core holds a domain concept in %d places:\n%s\n"+
			"Move it to the plugin that owns the domain. The core keeps what every plugin "+
			"would otherwise reinvent, and a thing named after one kind of content is not that (C6).",
			len(found), strings.Join(found, "\n"))
	}
}

// An entry excusing nothing is an exemption nobody granted the next file under
// that path — the same defect couplingWiring is checked for.
func TestEveryDomainExemptionStillExcusesSomething(t *testing.T) {
	for path, reason := range domainAllowed {
		if strings.TrimSpace(reason) == "" {
			t.Errorf("%s is exempt for no stated reason", path)
		}
		body, err := os.ReadFile(filepath.FromSlash(path))
		if err != nil {
			t.Errorf("%s is exempt and does not exist: %v\nTake the entry out.", path, err)
			continue
		}
		hit := false
		lower := strings.ToLower(stripComments(string(body)))
		for word := range domainWord {
			if strings.Contains(lower, word) {
				hit = true
				break
			}
		}
		if !hit {
			t.Errorf("%s names no domain concept and is still exempt.\nTake the entry out.", path)
		}
	}
}
