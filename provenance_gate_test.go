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

// skipped are trees this repository does not author.
var skipped = map[string]bool{
	"node_modules": true, "dist": true, ".git": true,
	"frontend/dist": true,
}

func TestTheRecordKeepsReasonsAndDropsSources(t *testing.T) {
	root, err := os.Getwd()
	if err != nil {
		t.Fatalf("working directory: %v", err)
	}

	var found []string
	scannedFiles := 0
	walkErr := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			if skipped[info.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if !scanned[filepath.Ext(path)] {
			return nil
		}
		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			rel = path
		}
		// This file names every word it forbids.
		if rel == "provenance_gate_test.go" {
			return nil
		}
		body, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		scannedFiles++
		for index, line := range strings.Split(string(body), "\n") {
			for _, attribution := range attributions {
				if attribution.MatchString(line) {
					found = append(found, rel+":"+itoa(index+1)+" "+strings.TrimSpace(line))
				}
			}
		}
		return nil
	})
	if walkErr != nil {
		t.Fatalf("walking the repository: %v", walkErr)
	}

	// An anchor: a gate that scanned nothing reports the same zero as a clean
	// repository, and the two are different facts.
	if scannedFiles < 100 {
		t.Fatalf("only %d files were scanned; the walk is not reaching the repository", scannedFiles)
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
