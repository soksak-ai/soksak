package secret

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strconv"
	"strings"
	"testing"
)

// packageFiles parses every source in this package.
//
// The check reads the syntax tree rather than the text: this package explains
// in its comments which calls it refuses to make, and a substring gate would
// fire on the explanation while a renamed call slipped past it.
func packageFiles(t *testing.T) map[string]*ast.File {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("reading the package directory: %v", err)
	}
	fileSet := token.NewFileSet()
	parsed := map[string]*ast.File{}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fileSet, name, nil, 0)
		if err != nil {
			t.Fatalf("parsing %s: %v", name, err)
		}
		parsed[name] = file
	}
	if len(parsed) == 0 {
		// A gate that finds nothing to inspect enforces nothing.
		t.Fatal("no package sources were parsed; the scan root is wrong")
	}
	return parsed
}

// This package has no way to write anywhere but its answer.
//
// A vault that can reach a log, a file, or standard output has a second exit
// for a plaintext, and the one that gets used is the one added in a hurry while
// something is being debugged. Removing the imports removes the option: there
// is nothing to reach for at 3am.
func TestThisPackageCanWriteNowhereButItsAnswer(t *testing.T) {
	forbidden := map[string]string{
		"log":     "a vault that can log is a vault that can log a secret",
		"os":      "nothing here reads or writes the host; the store arrives as a value",
		"os/exec": "a vault starts nothing; the process group injects what it resolves",
	}
	for name, file := range packageFiles(t) {
		for _, imported := range file.Imports {
			path, err := strconv.Unquote(imported.Path.Value)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			if because, refused := forbidden[path]; refused {
				t.Errorf("%s imports %s: %s", name, path, because)
			}
		}
	}
}

// fmt is here for errors. Its printers write to a stream, which is the same
// second exit under another name.
func TestThisPackagePrintsNothing(t *testing.T) {
	printers := map[string]bool{
		"Print": true, "Printf": true, "Println": true,
		"Fprint": true, "Fprintf": true, "Fprintln": true,
	}
	for name, file := range packageFiles(t) {
		ast.Inspect(file, func(node ast.Node) bool {
			call, isCall := node.(*ast.CallExpr)
			if !isCall {
				return true
			}
			if builtin, isIdent := call.Fun.(*ast.Ident); isIdent {
				if builtin.Name == "print" || builtin.Name == "println" {
					t.Errorf("%s calls %s; a vault writes to no stream", name, builtin.Name)
				}
				return true
			}
			selector, isSelector := call.Fun.(*ast.SelectorExpr)
			if !isSelector {
				return true
			}
			pkg, isIdent := selector.X.(*ast.Ident)
			if !isIdent || pkg.Name != "fmt" {
				return true
			}
			if printers[selector.Sel.Name] {
				t.Errorf("%s calls fmt.%s; a vault writes to no stream", name, selector.Sel.Name)
			}
			return true
		})
	}
}

// Nothing here reads the process it happens to run in.
//
// The caller passes what it read, which is what lets one vault answer
// identically in a window, in a headless server, and in a test. runtime.GOOS is
// on the list because which key store exists is exactly the question this
// package would be tempted to answer for itself — and then the same home would
// be readable in the application and not in a test.
func TestThisPackageReadsNothingAmbient(t *testing.T) {
	forbidden := map[string][]string{
		"os":      {"Getenv", "Environ", "Getwd", "Executable", "UserHomeDir"},
		"runtime": {"GOOS", "GOARCH"},
		"time":    {"Now"},
	}
	for name, file := range packageFiles(t) {
		ast.Inspect(file, func(node ast.Node) bool {
			selector, isSelector := node.(*ast.SelectorExpr)
			if !isSelector {
				return true
			}
			pkg, isIdent := selector.X.(*ast.Ident)
			if !isIdent {
				return true
			}
			for _, member := range forbidden[pkg.Name] {
				if selector.Sel.Name == member {
					t.Errorf("%s reads %s.%s; the process supplies what it read", name, pkg.Name, member)
				}
			}
			return true
		})
	}
}

// The key store arrives through an interface declared here. Naming a framework,
// a plugin, or one operating system's key store would make this package answer
// only where that one is linked.
func TestThisPackageNamesNoHost(t *testing.T) {
	for name, file := range packageFiles(t) {
		for _, imported := range file.Imports {
			path, err := strconv.Unquote(imported.Path.Value)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			for _, forbidden := range []string{"wailsapp/wails", "soksak-plugin-", "keyring", "keychain", "dbus"} {
				if strings.Contains(path, forbidden) {
					t.Errorf("%s imports %s; the key store is injected, not imported", name, path)
				}
			}
		}
	}
}

// Storage is core/store's. A second one would put the same secret in two places
// and let a caller ask the one that has not been written to yet.
func TestThisPackageOpensNoStorageOfItsOwn(t *testing.T) {
	for name, file := range packageFiles(t) {
		for _, imported := range file.Imports {
			path, err := strconv.Unquote(imported.Path.Value)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			for _, forbidden := range []string{"database/sql", "sqlite", "bolt", "badger"} {
				if strings.Contains(path, forbidden) {
					t.Errorf("%s imports %s; core/store is the storage", name, path)
				}
			}
		}
	}
}
