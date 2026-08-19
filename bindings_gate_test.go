package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// The generated bindings say the same thing as the Go they were generated from.
//
// They are generated, and generating them takes two minutes over 291 packages, so nothing does it
// on every change. Measured 2026-08-16, the terminal's Open was committed as (id, cols, rows)
// while the Go method took (id, stream, cols, rows): the declared shape was missing an argument,
// and a difference like that appears only when the call is made.
//
// Regenerating here would be a two-minute gate that nobody leaves on, and a gate nobody runs is a
// backlog. This compares the shapes instead: every bound method, and how many arguments it takes.
// That is the drift that was actually there, and it costs milliseconds.

// bindingsRoot is where the generator writes.
const bindingsRoot = "frontend/bindings/github.com/soksak"

// bindingsModule maps a directory under bindingsRoot to the Go package that produced it. Named,
// not derived: a sibling module is outside this repository and its path here comes from a replace
// directive, which a walk of this tree cannot find.
var bindingsModule = map[string]string{
	"soksak-core/frameworks/wails":    "frameworks/wails",
	"soksak-plugin-terminal-xterm":    "../soksak-plugins/soksak-plugin-terminal-xterm",
	"soksak-plugin-browser-native":    "../soksak-plugins/soksak-plugin-browser-native",
	"wails-service-native-compositor": "../wails-services/wails-service-native-compositor",
}

// bindingsLifecycle is what Wails calls rather than binds. A service declares these for the host
// and no page ever calls them, so their absence from the bindings is correct.
var bindingsLifecycle = map[string]bool{
	"ServiceName": true, "ServiceStartup": true, "ServiceShutdown": true,
}

var (
	tsExport = regexp.MustCompile(`(?m)^export function ([A-Za-z0-9_]+)\(([^)]*)\)`)
	tsIgnore = regexp.MustCompile(`^(models|index)\.ts$|\.d\.ts$`)
)

func TestTheBindingsSayWhatTheGoSays(t *testing.T) {
	var wrong []string

	for dir, pkg := range bindingsModule {
		entries, err := os.ReadDir(filepath.Join(bindingsRoot, dir))
		if err != nil {
			t.Fatalf("reading %s: %v", dir, err)
		}
		for _, entry := range entries {
			name := entry.Name()
			if entry.IsDir() || !strings.HasSuffix(name, ".ts") || tsIgnore.MatchString(name) {
				continue
			}
			file := filepath.Join(bindingsRoot, dir, name)
			source, err := os.ReadFile(file)
			if err != nil {
				t.Fatalf("reading %s: %v", file, err)
			}
			declared := map[string]int{}
			for _, match := range tsExport.FindAllStringSubmatch(string(source), -1) {
				declared[match[1]] = tsArity(match[2])
			}
			if len(declared) == 0 {
				continue
			}

			// The file is named after the Go type, lowercased by the generator.
			typeName := strings.TrimSuffix(name, ".ts")
			actual, found, err := goMethods(pkg, typeName)
			if err != nil {
				t.Fatalf("reading %s for %s: %v", pkg, typeName, err)
			}
			if !found {
				wrong = append(wrong, file+": no Go type in "+pkg+" is named "+typeName)
				continue
			}
			for method, want := range actual {
				got, present := declared[method]
				if !present {
					wrong = append(wrong, file+": the Go type has "+method+" and the bindings do not")
					continue
				}
				if got != want {
					wrong = append(wrong, file+": "+method+" takes "+itoa(want)+" arguments in Go and "+itoa(got)+" here")
				}
			}
			for method := range declared {
				if _, present := actual[method]; !present {
					wrong = append(wrong, file+": the bindings have "+method+" and the Go type does not")
				}
			}
		}
	}

	if len(wrong) > 0 {
		sort.Strings(wrong)
		t.Errorf("the bindings and the Go disagree in %d places:\n%s\n"+
			"Run wails3 generate bindings -d frontend/bindings -ts ./... and commit what it writes.",
			len(wrong), strings.Join(wrong, "\n"))
	}
}

// tsArity counts the parameters in a generated signature. The generator writes one `name: Type`
// per parameter and never a default or a rest, so commas at the top level are the count — and a
// generic like Promise<A, B> never appears in a parameter position here.
func tsArity(params string) int {
	trimmed := strings.TrimSpace(params)
	if trimmed == "" {
		return 0
	}
	depth := 0
	count := 1
	for _, r := range trimmed {
		switch r {
		case '<', '{', '(', '[':
			depth++
		case '>', '}', ')', ']':
			depth--
		case ',':
			if depth == 0 {
				count++
			}
		}
	}
	return count
}

// goMethods answers the bound methods of one type: exported, on that receiver, minus the lifecycle
// the host calls itself.
func goMethods(pkg, typeName string) (map[string]int, bool, error) {
	set := token.NewFileSet()
	packages, err := parser.ParseDir(set, pkg, func(info os.FileInfo) bool {
		return !strings.HasSuffix(info.Name(), "_test.go")
	}, 0)
	if err != nil {
		return nil, false, err
	}
	methods := map[string]int{}
	found := false
	for _, parsed := range packages {
		for _, file := range parsed.Files {
			for _, decl := range file.Decls {
				fn, isFunc := decl.(*ast.FuncDecl)
				if !isFunc || fn.Recv == nil || len(fn.Recv.List) != 1 {
					continue
				}
				if !strings.EqualFold(receiverName(fn.Recv.List[0].Type), typeName) {
					continue
				}
				found = true
				if !fn.Name.IsExported() || bindingsLifecycle[fn.Name.Name] {
					continue
				}
				count := 0
				for index, param := range fn.Type.Params.List {
					// The generator supplies a leading context itself and leaves it out of the
					// signature a page calls. Counting it would report every such method as one
					// argument short here and send the reader looking for a missing parameter.
					if index == 0 && isContext(param.Type) {
						continue
					}
					if len(param.Names) == 0 {
						count++
						continue
					}
					count += len(param.Names)
				}
				methods[fn.Name.Name] = count
			}
		}
	}
	return methods, found, nil
}

// isContext reports the one parameter type the generator supplies instead of requesting.
func isContext(expr ast.Expr) bool {
	selector, isSelector := expr.(*ast.SelectorExpr)
	if !isSelector || selector.Sel.Name != "Context" {
		return false
	}
	pkg, isIdent := selector.X.(*ast.Ident)
	return isIdent && pkg.Name == "context"
}

// receiverName is the type a method hangs on, through a pointer if there is one.
func receiverName(expr ast.Expr) string {
	switch typed := expr.(type) {
	case *ast.StarExpr:
		return receiverName(typed.X)
	case *ast.Ident:
		return typed.Name
	case *ast.IndexExpr:
		return receiverName(typed.X)
	}
	return ""
}
