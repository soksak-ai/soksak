package process

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
// in its comments which globals it refuses to call, and a substring gate would
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

// Nothing here reads the process it happens to run in.
//
// The caller passes what it read, which is what lets one command answer
// identically in a window, in a headless server, and in a test. os.Environ is
// on the list beside the others because this package is about a child's
// environment, and it is the call that would be reached for first: reading it
// here would make the same spawn hand down a different environment depending on
// which process asked.
func TestThisPackageReadsNothingAmbient(t *testing.T) {
	forbidden := map[string][]string{
		"os":      {"Getenv", "Environ", "Getwd", "Executable", "UserHomeDir"},
		"runtime": {"GOOS", "GOARCH"},
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

// The owner arrives through an interface declared here. Naming a framework or a
// plugin would make this package answer only where that one is linked, and the
// command names would stop being one door.
func TestThisPackageNamesNoFrameworkOrPlugin(t *testing.T) {
	for name, file := range packageFiles(t) {
		for _, imported := range file.Imports {
			path, err := strconv.Unquote(imported.Path.Value)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			for _, forbidden := range []string{"wailsapp/wails", "soksak-plugin-", "creack/pty"} {
				if strings.Contains(path, forbidden) {
					t.Errorf("%s imports %s; the owner is injected, not imported", name, path)
				}
			}
		}
	}
}

// Platform difference is a build tag. A branch would make one binary carry two
// answers and pick between them at run time, and the answer a test observes
// would stop being the answer the application gives.
func TestPlatformDifferenceIsABuildTag(t *testing.T) {
	tagged := map[string]bool{}
	for name := range packageFiles(t) {
		if strings.HasSuffix(name, "_unix.go") || strings.HasSuffix(name, "_windows.go") {
			tagged[name] = true
		}
	}
	for _, name := range []string{"spawner_unix.go", "spawner_windows.go"} {
		if !tagged[name] {
			t.Errorf("%s is missing; the group rule differs per platform and has to be split by file", name)
		}
	}
}

// The group refusal is wired into Spawn, and wired to the build-tag constants.
//
// This host honours groups, so no test that runs here can reach the refusal
// through Spawn — deleting the guard leaves every behavioural test green while
// a Windows build silently spawns ungrouped, which is the exact failure the
// refusal exists to prevent (a grandchild left holding stdout after a kill).
// Reading the tree is what is left: it fires on the deletion, and it refuses a
// call that hard-codes the answer instead of taking the platform's.
func TestTheGroupRefusalIsWiredIntoSpawn(t *testing.T) {
	file, parsed := packageFiles(t)["manager.go"]
	if !parsed {
		t.Fatal("manager.go was not parsed; the scan root is wrong")
	}

	var arguments []string
	ast.Inspect(file, func(node ast.Node) bool {
		function, isFunction := node.(*ast.FuncDecl)
		if !isFunction || function.Name.Name != "Spawn" {
			return true
		}
		ast.Inspect(function.Body, func(inner ast.Node) bool {
			call, isCall := inner.(*ast.CallExpr)
			if !isCall {
				return true
			}
			name, isIdent := call.Fun.(*ast.Ident)
			if !isIdent || name.Name != "groupRefusal" {
				return true
			}
			for _, argument := range call.Args {
				if given, isIdent := argument.(*ast.Ident); isIdent {
					arguments = append(arguments, given.Name)
				}
			}
			return true
		})
		return false
	})

	want := []string{"groupHonoured", "groupNotHonouredBecause"}
	if strings.Join(arguments, ",") != strings.Join(want, ",") {
		t.Fatalf("Spawn calls groupRefusal%v; it has to ask this build's own constants %v", arguments, want)
	}
}
