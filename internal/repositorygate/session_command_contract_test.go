package repositorygate

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	controlwire "github.com/soksak-ai/soksak-contract-control"
)

// The catalog registers exactly the commands the contract declares, with exactly their parameters.
//
// Measured 2026-09-04: a view called `session_attach` with `viewId` while the command it could run
// was `session.attach` with `view`. Either mismatch alone left the core's index empty, and neither
// raised: the runner answers `{ok:false}`, so a name nothing serves reads as a success to a caller
// that only catches. The contract names them once and each side grades itself against that file;
// this repository does not read the other side's source.
func TestTheSessionCatalogMatchesTheContract(t *testing.T) {
	declared, err := controlwire.SessionCommands()
	if err != nil {
		t.Fatalf("reading the declared session commands: %v", err)
	}
	if len(declared) == 0 {
		t.Fatal("the contract declares no session command")
	}

	source, err := os.ReadFile(filepath.Join("frontend", "src", "commands", "catalogSession.ts"))
	if err != nil {
		t.Fatalf("reading the session catalog: %v", err)
	}
	registered := registeredSessionCommands(t, string(source))

	for _, one := range declared {
		params, found := registered[one.Command]
		if !found {
			t.Errorf("the contract declares %s and the catalog registers no such command", one.Command)
			continue
		}
		want := append([]string{}, one.Params...)
		sort.Strings(want)
		got := append([]string{}, params...)
		sort.Strings(got)
		if strings.Join(want, ",") != strings.Join(got, ",") {
			t.Errorf("%s takes %v in the contract and %v in the catalog", one.Command, want, got)
		}
	}
	for name := range registered {
		if !strings.HasPrefix(name, "session.") {
			continue
		}
		if !slicesContainCommand(declared, name) {
			t.Errorf("the catalog registers %s and the contract declares no such command", name)
		}
	}
}

func slicesContainCommand(declared []controlwire.SessionCommand, name string) bool {
	for _, one := range declared {
		if one.Command == name {
			return true
		}
	}
	return false
}

var sessionRegisterPattern = regexp.MustCompile(`register\("(session\.[a-zA-Z.]+)", \{`)

// registeredSessionCommands reads each session.* registration and the parameter names it declares.
// The catalog is the only source read here, and this repository owns it.
func registeredSessionCommands(t *testing.T, source string) map[string][]string {
	t.Helper()
	registered := map[string][]string{}
	for _, match := range sessionRegisterPattern.FindAllStringSubmatchIndex(source, -1) {
		name := source[match[2]:match[3]]
		body := source[match[1]:]
		if next := sessionRegisterPattern.FindStringIndex(body); next != nil {
			body = body[:next[0]]
		}
		registered[name] = declaredParams(t, name, body)
	}
	return registered
}

var paramNamePattern = regexp.MustCompile(`(?m)^\s{6}([a-zA-Z]+): \{ type:`)

func declaredParams(t *testing.T, name string, body string) []string {
	t.Helper()
	start := strings.Index(body, "\n    params: {")
	if start < 0 {
		t.Fatalf("%s declares no params block", name)
	}
	rest := body[start:]
	end := strings.Index(rest, "\n    },")
	if end < 0 {
		// A one-line empty block: `params: {},`
		if strings.HasPrefix(rest, "\n    params: {},") {
			return nil
		}
		t.Fatalf("%s has no closing params block", name)
	}
	params := []string{}
	for _, found := range paramNamePattern.FindAllStringSubmatch(rest[:end], -1) {
		params = append(params, found[1])
	}
	return params
}
