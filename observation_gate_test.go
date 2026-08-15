package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The framework carries an MCP server behind the `mcp` build tag: sixteen tools
// for reading and driving the page — dom_query, js_eval, mouse_click,
// screenshot_dom. It is tempting, and it is not an observation channel here.
//
// It cannot exist without a window. The server starts inside App.Run, so a
// build that has it is the GUI application, and reaching for it means launching
// a second copy of this product. Measured 2026-08-15: doing exactly that put two
// identical windows on screen, and the second one was mistaken for a defect in
// the first — the observation changed what was being observed.
//
// This product has one observation surface: the control plane. `sok` reaches
// the same registry the frontend does, with no window of its own, and it is the
// surface every gate is written against. A second door that only exists in a
// debug build would drift from it, and the drift would be discovered by
// trusting the wrong one.
var enablesMCP = regexp.MustCompile(`(-tags[= ]|tags:\s*|BUILD_TAGS[=:]\s*)["']?[a-z,]*\bmcp\b`)

// Directories that are not this product's to legislate: the vendored framework
// is upstream's, and the rest are build outputs.
var notOurs = map[string]bool{
	".git": true, "node_modules": true, "dist": true, "bin": true,
	"framework": true, "evidence": true,
}

func TestNothingInThisRepositoryEnablesTheMCPServer(t *testing.T) {
	var found []string

	err := filepath.Walk(".", func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			if notOurs[info.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		switch filepath.Ext(path) {
		case ".go", ".yml", ".yaml", ".md", ".json", ".sh", ".toml":
		default:
			return nil
		}
		// This file names the tag in order to forbid it.
		if filepath.Base(path) == "observation_gate_test.go" {
			return nil
		}
		source, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, line := range strings.Split(string(source), "\n") {
			if enablesMCP.MatchString(line) {
				found = append(found, path+": "+strings.TrimSpace(line))
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("scanning the repository: %v", err)
	}

	if len(found) > 0 {
		t.Errorf("these enable the framework's MCP server:\n  %s\n\n"+
			"That server cannot run without a window, so switching it on means a second copy of\n"+
			"this application on screen. Observation goes through the control plane — `sok`, the\n"+
			"same registry, no window. If the control plane cannot answer something, that is the\n"+
			"thing to build.", strings.Join(found, "\n  "))
	}
}

// A gate that matches nothing enforces nothing. This holds the pattern against
// the spellings that would actually appear.
func TestTheMCPGateRecognisesHowTheTagIsSwitchedOn(t *testing.T) {
	for _, line := range []string{
		`go build -tags mcp -o bin/app .`,
		`go run -tags=mcp .`,
		`      - go build -tags "mcp,production" .`,
		`    tags: mcp`,
		`BUILD_TAGS=mcp`,
	} {
		if !enablesMCP.MatchString(line) {
			t.Errorf("the gate would not notice: %s", line)
		}
	}

	// And against what must not trip it, or the gate becomes noise someone
	// silences.
	for _, line := range []string{
		`// The framework's MCP server is experimental.`,
		`go build -tags production .`,
		`mcpServer := somethingElse()`,
		`- mcp_tools_enabled.go is upstream's`,
	} {
		if enablesMCP.MatchString(line) {
			t.Errorf("the gate objects to something harmless: %s", line)
		}
	}
}
