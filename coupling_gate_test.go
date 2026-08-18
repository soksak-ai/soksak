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
// One entry, and it is the composition root. Two more were debts here, written
// down rather than left to be discovered, and both are paid: HostDeps carried
// a field typed as the terminal plugin's session interface, and the sink took
// two of that plugin's types for a body that only marshals them. A build's
// command groups arrive as their own registrations now, and a diagnostic record
// travels on the core's own contract (control.TraceSink).
var couplingWiring = map[string]string{
	"frameworks/wails/host.go": "the Wails host's composition root — it constructs the plugins this " +
		"binary ships with and hands each one what it needs. Every line here is a construction or a " +
		"hand-off; a rule about what a plugin's data means belongs to the plugin.",
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
	// A product, not a kind of content — the same coupling read from the other
	// side. `soksak-plugin-<x>` is caught by pluginName above; a vendor's name is
	// not, and it arrives as an environment variable, a spawn form or a directory. Measured 2026-08-16: `AISessionEnv` listed six CLAUDE_CODE_* and
	// one CODEX_* variable, driving a scrub nothing called, and a comment named
	// `.claude/skills` as where a skill installs.
	"claude_code": "one agent product's environment",
	"claudecode":  "one agent product's environment",
	"codex_":      "one agent product's environment",
	".claude/":    "one agent product's directory",
	"chatgpt":     "one product",
	"copilot":     "one product",
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

// The core answers no media type (C6, A9).
//
// What a file is comes from whoever renders it. A table here answers for the
// formats one consumer needed and application/octet-stream for the rest, so a
// plugin for anything outside it has to edit the core to be answered — the
// missing capability A9 names, not a default.
//
// Measured 2026-08-16: `core/files/binary.go` mapped 24 extensions and
// `read_file_base64` carried the answer to every caller. An HWP viewer, an
// editor for a language nobody listed, a CAD format — each would have arrived
// here as a one-line edit, and the list would have been the record of who asked
// loudest.
//
// What is refused is the pairing: an extension literal and a `type/subtype`
// literal on one line. A media type alone is legitimate — a capture writes
// image/png because it made a PNG, and a caller states the type it already has.
func TestTheCoreAnswersNoMediaType(t *testing.T) {
	extension := regexp.MustCompile(`"\.[a-z0-9]{1,8}"`)
	mediaType := regexp.MustCompile(`"(application|image|video|audio|text|font|model)/[a-z0-9.+-]+"`)
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
			if !scannedCode[filepath.Ext(path)] {
				return nil
			}
			clean := filepath.ToSlash(path)
			if strings.Contains(clean, ".test.") || strings.HasSuffix(clean, "_test.go") {
				return nil
			}
			body, readErr := os.ReadFile(path)
			if readErr != nil {
				return readErr
			}
			scanned++
			for index, line := range strings.Split(stripComments(string(body)), "\n") {
				if extension.MatchString(line) && mediaType.MatchString(line) {
					found = append(found, clean+":"+itoa(index+1)+" "+strings.TrimSpace(line))
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
		t.Errorf("the core maps an extension to a media type in %d places:\n%s\n"+
			"Take the table out. The caller states the type it knows: an editor its languages, an "+
			"image viewer its formats, an HWP plugin one (C6).",
			len(found), strings.Join(found, "\n"))
	}
}

// The core holds no second identity namespace (C3, C4).
//
// A plugin is identified by its plugin id. There was a parallel one until 2026-08-16 —
// `soksak-spec-<kind>-<domain>` contract ids that a provider declared and a consumer asked for, so
// either side could be swapped. Not one contract ever had both sides declared, the id was a second
// name for what the plugin id already names, and it leaked into the core as a constant for ⌘T.
//
// Four stamps remain, one per document the core reads and does not publish, plus one per unit kind.
// They were deleted the same day on the reasoning that a field's place already identifies its
// document. On the wire it does not: a release manifest arrives alone by URL and `spec` is the only
// thing in it that identifies the format. Measured against what is served — the index, a release
// manifest, both conformance reports and a packaged plugin manifest — the deletion made 54 published
// units unreadable at four layers.
//
// So the rule is not that the names are gone. It is that they are formats, declared in one file, and
// none of them names a plugin or a domain: `soksak-spec-plugin@` is the manifest format every plugin
// shares, and `soksak-spec-plugin-terminal@` would be a format for one of them (C1).
var specStampHome = filepath.Join("frontend", "src", "plugins", "spec", "unit.ts")

var declaredSpecStamps = map[string]bool{
	"soksak-spec-release":     true,
	"soksak-spec-registry":    true,
	"soksak-spec-conformance": true,
	"soksak-spec-kit":         true,
	"soksak-spec-plugin":      true,
	"soksak-spec-sidecar":     true,
}

func TestTheCoreHoldsNoSecondIdentityNamespace(t *testing.T) {
	spec := regexp.MustCompile(`soksak-spec-[a-z0-9-]+`)
	var scattered []string
	var invented []string
	declared := map[string]bool{}
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
			if strings.Contains(clean, ".test.") || strings.HasSuffix(clean, "_test.go") {
				return nil
			}
			body, readErr := os.ReadFile(path)
			if readErr != nil {
				return readErr
			}
			scanned++
			home := path == specStampHome
			for index, line := range strings.Split(stripComments(string(body)), "\n") {
				for _, name := range spec.FindAllString(line, -1) {
					where := clean + ":" + itoa(index+1) + " " + name
					if !home {
						scattered = append(scattered, where)
						continue
					}
					declared[name] = true
					if !declaredSpecStamps[name] {
						invented = append(invented, where)
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
	if len(scattered) > 0 {
		t.Errorf("a spec stamp stands outside %s in %d places:\n%s\n"+
			"Declare it there and import it. A stamp written twice is two answers about one document.",
			specStampHome, len(scattered), strings.Join(scattered, "\n"))
	}
	if len(invented) > 0 {
		t.Errorf("%d spec stamps are not formats the core reads:\n%s\n"+
			"A stamp is the format of a document, one per document kind. A plugin is named by its "+
			"plugin id, and a format for one plugin is a second name for it (C1).",
			len(invented), strings.Join(invented, "\n"))
	}
	for name := range declaredSpecStamps {
		if !declared[name] {
			t.Errorf("%s is declared here but no longer in %s.\n"+
				"It stamps a document that is published today — deleting it makes that document "+
				"unreadable. Measure what is served before removing it.", name, specStampHome)
		}
	}
}
