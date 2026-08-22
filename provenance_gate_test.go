package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestFrontendUsesThePinnedWailsRuntime(t *testing.T) {
	body, err := os.ReadFile("frontend/package.json")
	if err != nil {
		t.Fatal(err)
	}
	want := `"@wailsio/runtime": "file:../../frameworks/wails3/v3/internal/runtime/desktop/@wailsio/runtime"`
	if !strings.Contains(string(body), want) {
		t.Fatalf("frontend runtime is not pinned to the framework checkout; want %s", want)
	}
}

// The record keeps reasons and drops sources.
//
// A comment states why a rule exists, with the measurement that produced it. It
// does not say which codebase the measurement came from. Those two are easy to
// write in one sentence — "an earlier build folded every failure into absence" —
// and the second half is what this gate removes: the repository is the product,
// not a history of what it replaced.
//
// The words below are the ones that carried the attribution. They stay listed
// because a scan for one of them is a scan for a habit, and the habit returns
// whenever someone ports another rule.
var attributions = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\bearlier builds?\b`),
	regexp.MustCompile(`전임`),
	regexp.MustCompile(`구 저장소`),
	// The language and toolchain of a build this one does not contain. Naming
	// them dates the file to a port rather than to a rule.
	regexp.MustCompile(`\bRust\b`),
	regexp.MustCompile(`\bCargo\b`),
	regexp.MustCompile(`\bcrates/`),
	// A path into a checkout that is not this one. It cannot be followed, and
	// it names where the code came from.
	regexp.MustCompile(`frameworks?/tauri/`),
}

// scanned is every extension holding prose a reader will believe.
var scanned = map[string]bool{
	".go": true, ".ts": true, ".tsx": true, ".md": true, ".css": true,
}

func TestTheRecordKeepsReasonsAndDropsSources(t *testing.T) {
	root, err := os.Getwd()
	if err != nil {
		t.Fatalf("working directory: %v", err)
	}

	var found []string
	files, err := trackedRecordFiles(root, scanned, []string{"frontend/bindings/", "frontend/dist/"})
	if err != nil {
		t.Fatal(err)
	}
	for _, rel := range files {
		// This file names every word it forbids.
		if rel == "provenance_gate_test.go" {
			continue
		}
		body, readErr := os.ReadFile(filepath.Join(root, rel))
		if readErr != nil {
			t.Fatal(readErr)
		}
		for index, line := range strings.Split(string(body), "\n") {
			for _, attribution := range attributions {
				if attribution.MatchString(line) {
					found = append(found, rel+":"+itoa(index+1)+" "+strings.TrimSpace(line))
				}
			}
		}
	}

	// An anchor: a gate that scanned nothing reports the same zero as a clean
	// repository, and the two are different facts.
	if len(files) < 100 {
		t.Fatalf("only %d files were scanned; the index is not reaching the repository", len(files))
	}
	if len(found) > 0 {
		t.Errorf("the record names where a rule came from in %d places:\n%s\nKeep the reason and the measurement; drop the attribution.",
			len(found), strings.Join(found, "\n"))
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	digits := ""
	for n > 0 {
		digits = string(rune('0'+n%10)) + digits
		n /= 10
	}
	return digits
}
