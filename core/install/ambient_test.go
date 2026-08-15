package install

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strings"
	"testing"
)

// TestNothingHereReadsItsOwnEnvironment is what lets these commands answer
// identically in a window, in a headless server, and in a test.
//
// runtime.GOOS matters most in this package. Every answer here is about a host:
// which artifact triple names it, where its npm prefix is, whether its launcher
// resolves. A body that read the platform for itself would answer what this
// binary is rather than what the caller asked, and those are the same value on
// every machine except the one that cross-compiled — which is the machine that
// publishes.
//
// The scan parses each file rather than searching its text, because a text
// search cannot tell a call from the comment that explains why the call is
// forbidden. An earlier form of this gate could not, so the only way to keep it
// green was to stop naming the thing in prose — and a rule whose reason cannot
// be written down beside it is a rule the next reader deletes.
func TestNothingHereReadsItsOwnEnvironment(t *testing.T) {
	forbidden := map[string]string{
		"os.Getenv":           "the caller passes what it read",
		"os.Getwd":            "the caller passes what it read",
		"os.Executable":       "the caller passes what it read",
		"os.UserHomeDir":      "the caller passes what it read",
		"runtime.GOOS":        "the platform is an argument, or the answer is about this binary",
		"runtime.GOARCH":      "the platform is an argument, or the answer is about this binary",
		"filepath.Abs":        "it reads the working directory for a relative path",
		"exec.Command":        "starting a process belongs to the injected runner",
		"exec.CommandContext": "starting a process belongs to the injected runner",
	}

	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("reading the package directory: %v", err)
	}

	scanned := 0
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") {
			continue
		}
		// Comments are dropped on purpose: only what the compiler sees counts.
		parsed, err := parser.ParseFile(token.NewFileSet(), name, nil, 0)
		if err != nil {
			t.Fatalf("parsing %s: %v", name, err)
		}
		scanned++
		ast.Inspect(parsed, func(node ast.Node) bool {
			selector, ok := node.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			pkg, ok := selector.X.(*ast.Ident)
			if !ok {
				return true
			}
			// A local variable named `os` would shadow the package; Obj is nil
			// exactly when the identifier resolved to no declaration in this
			// file, which is what an imported package name does.
			if pkg.Obj != nil {
				return true
			}
			call := pkg.Name + "." + selector.Sel.Name
			if why, banned := forbidden[call]; banned {
				t.Errorf("%s calls %s; %s", name, call, why)
			}
			return true
		})
	}

	if scanned == 0 {
		// A scan that reads nothing reports nothing and enforces nothing.
		t.Fatal("no sources were scanned; the scan root is wrong")
	}
}
