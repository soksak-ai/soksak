package repositorygate

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The framework includes an MCP server behind the `mcp` build tag: sixteen tools
// for reading and driving the page — dom_query, js_eval, mouse_click,
// screenshot_dom. It is tempting, and it is not an observation channel here.
//
// It cannot exist without a window. The server starts inside App.Run, so a
// build that has it is the GUI application, and reaching for it means launching
// a second copy of this product. Measured 2026-08-15: doing exactly that put two
// identical windows on screen, and the second one was mistaken for a defect in
// the first — the observation changed what was being observed.
//
// This product has one observation surface: the control plane. `sok` addresses
// the same registry the frontend does, with no window of its own, and it is the
// surface every gate is written against. A second door that only exists in a
// debug build would drift from it, and the drift would be discovered by
// trusting the wrong one.
var enablesMCP = regexp.MustCompile(`(-tags[= ]|tags:\s*|BUILD_TAGS[=:]\s*)["']?[a-z,]*\bmcp\b`)

// Directories that are not this product's to legislate: the framework directory
// and generated output directories are excluded from this source scan.
//
// bin is excluded from the source scan and checked separately below. Measured
// 2026-08-15: this gate passed while bin/app-mcp sat in the tree, built with
// -tags=production,mcp — a gate that reads only the recipe and never the meal
// clears the exact violation it exists to stop.
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
		// Markdown is left out on purpose: prose describes this rule, and a gate
		// that cannot tell an explanation from an instruction is one someone
		// eventually silences.
		case ".go", ".yml", ".yaml", ".json", ".sh", ".toml":
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
			if isComment(line) || !enablesMCP.MatchString(line) {
				continue
			}
			found = append(found, path+": "+strings.TrimSpace(line))
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
		`- mcp_tools_enabled.go is outside this product's source scan`,
	} {
		if enablesMCP.MatchString(line) {
			t.Errorf("the gate objects to something harmless: %s", line)
		}
	}
}

// A build is not a recipe. The scan above reads what this repository states to
// do; this reads what it actually produced.
//
// Go stamps its build settings into the binary, so a tagged build cannot hide:
// `go version -m` reports `-tags=production,mcp` for exactly the artefact that
// puts a second window on screen.
func TestNoBuiltArtefactCarriesTheMCPServer(t *testing.T) {
	entries, err := os.ReadDir("bin")
	if os.IsNotExist(err) {
		// Nothing built yet is not a violation.
		return
	}
	if err != nil {
		t.Fatalf("reading bin: %v", err)
	}

	var tagged []string
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		path := filepath.Join("bin", entry.Name())
		info, err := entry.Info()
		if err != nil || info.Mode()&0o111 == 0 {
			continue
		}
		settings, err := exec.Command("go", "version", "-m", path).Output()
		if err != nil {
			// Not a Go binary, or unreadable. Neither is this gate's business.
			continue
		}
		for _, line := range strings.Split(string(settings), "\n") {
			if !strings.Contains(line, "-tags=") {
				continue
			}
			for _, tag := range strings.Split(strings.TrimSpace(strings.SplitN(line, "-tags=", 2)[1]), ",") {
				if tag == "mcp" {
					tagged = append(tagged, path+" ("+strings.TrimSpace(line)+")")
				}
			}
		}
	}

	if len(tagged) > 0 {
		t.Errorf("these built artefacts carry the framework's MCP server:\n  %s\n\n"+
			"Delete them. Each one opens a second copy of this application, and a second copy on\n"+
			"screen is mistaken for the first — measured 2026-08-15, twice.", strings.Join(tagged, "\n  "))
	}
}

// isComment reports that this line cannot run. A rule that stops the explanation of
// itself is one somebody eventually deletes rather than obeys.
func isComment(line string) bool {
	trimmed := strings.TrimSpace(line)
	return strings.HasPrefix(trimmed, "#") ||
		strings.HasPrefix(trimmed, "//") ||
		strings.HasPrefix(trimmed, "*")
}

// This repository produces two binaries and both live in bin/. One built at the
// repository root is a stray: it is not what any task produces, it is not what
// `clean` removes, and it launches — which makes it another window on screen
// that nobody meant to start.
//
// Measured 2026-08-15: a build at the root sat untracked beside four differently
// named copies in bin/, and one of those was mistaken for the running
// application.
func TestNoApplicationBinaryLivesAtTheRepositoryRoot(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("reading the repository root: %v", err)
	}

	var stray []string
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil || info.Mode()&0o111 == 0 {
			continue
		}
		if _, err := exec.Command("go", "version", "-m", entry.Name()).Output(); err != nil {
			// Not a Go binary. A shell script at the root is somebody else's rule.
			continue
		}
		stray = append(stray, entry.Name())
	}

	if len(stray) > 0 {
		t.Errorf("these Go binaries are built at the repository root: %s\n\n"+
			"Everything this repository builds goes to bin/, where `clean` can find it. A copy "+
			"here is one nothing produces and nothing removes.", strings.Join(stray, ", "))
	}
}
