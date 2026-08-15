package ai

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// gateFile names the forbidden calls, so scanning it would report itself.
const gateFile = "ambient_test.go"

// TestNothingHereReadsItsOwnEnvironment is what lets these commands answer
// identically in a window, in a headless server, and in a test.
//
// This package is about one user's home and one working directory, so both are
// exactly what it would be tempting to read. Reading either means two processes
// walk two trees, and the wrong one is not an error — it is "this project has
// no agent sessions" for a project full of them.
func TestNothingHereReadsItsOwnEnvironment(t *testing.T) {
	forbidden := []struct{ call, why string }{
		{"os.Getenv", "the caller passes what it read"},
		{"os.Getwd", "the caller passes what it read"},
		{"os.Executable", "the caller passes what it read"},
		{"os.UserHomeDir", "the caller passes what it read"},
		{"runtime.GOOS", "one rule for every platform, or the rule is two rules"},
		// The indirect route. It calls os.Getwd for anything relative, so a
		// scan naming only the direct calls reports a clean package while one
		// of them runs. Nothing here needs it: every path this package joins,
		// encodes, or reads is refused unless it arrived absolute.
		{"filepath.Abs", "it reads the working directory for a relative path"},
	}

	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("reading the package directory: %v", err)
	}

	scanned := 0
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || name == gateFile {
			continue
		}
		source, err := os.ReadFile(filepath.Join(".", name))
		if err != nil {
			t.Fatalf("reading %s: %v", name, err)
		}
		scanned++
		for _, banned := range forbidden {
			if strings.Contains(string(source), banned.call) {
				t.Errorf("%s calls %s; %s", name, banned.call, banned.why)
			}
		}
	}

	if scanned == 0 {
		// A scan that reads nothing reports nothing and enforces nothing.
		t.Fatal("no sources were scanned; the scan root is wrong")
	}
}
