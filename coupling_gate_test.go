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
// which is what a composition root is for, and frameworks/ is the host. Neither
// is scanned.
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

func TestTheCoreNamesNoPluginAndNoEngine(t *testing.T) {
	var plugins []string
	var engines []string
	scanned := 0

	for _, root := range []string{filepath.Join("frontend", "src"), "core"} {
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
			for index, line := range strings.Split(string(body), "\n") {
				for _, name := range pluginName.FindAllString(line, -1) {
					if _, allowed := couplingAllowed[name]; allowed {
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
