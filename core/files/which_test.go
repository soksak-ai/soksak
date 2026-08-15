package files

import (
	"errors"
	"strings"
	"testing"
)

// fakeRunner records what it was asked to run and answers what the test set.
// Nothing here spawns: assembling the argv is the rule, and spawning is
// whoever owns processes — which is what lets every rule below be checked with
// no shell on the machine at all.
type fakeRunner struct {
	program string
	args    []string
	calls   int
	outcome Outcome
	err     error
}

func (runner *fakeRunner) Run(program string, args []string) (Outcome, error) {
	runner.calls++
	runner.program = program
	runner.args = args
	return runner.outcome, runner.err
}

// The shell is an argument. If the body read $SHELL instead, this assertion
// could not pass.
func TestTheShellItIsGivenIsTheShellItUses(t *testing.T) {
	runner := &fakeRunner{}

	if _, err := shellWhich("node", "/opt/fixture/myshell", false, runner); err != nil {
		t.Fatalf("asking: %v", err)
	}
	if runner.program != "/opt/fixture/myshell" {
		t.Errorf("program = %q, want the injected shell", runner.program)
	}
	if len(runner.args) != 2 || runner.args[1] != "command -v node" {
		t.Errorf("args = %v", runner.args)
	}
}

// Without -l the login shell never re-reads rc/profile, so a process launched
// from the GUI keeps its narrow PATH — and the difference does not arrive as an
// error but as "not installed" for a binary the user's terminal finds.
func TestTheLoginFlagIsPresent(t *testing.T) {
	_, args, err := whichArgv("/bin/sh", "node", false)
	if err != nil {
		t.Fatalf("assembling: %v", err)
	}
	if !strings.Contains(args[0], "l") {
		t.Errorf("the login flag is missing: %v", args)
	}
	if args[0] != "-lc" {
		t.Errorf("args[0] = %q, want -lc", args[0])
	}
}

// One build answers two shapes. If the body branched on runtime.GOOS this test
// could only pass on one host.
func TestThePlatformIsAnArgumentNotASelfDescription(t *testing.T) {
	unixProgram, unixArgs, err := whichArgv("/opt/fixture/myshell", "node", false)
	if err != nil {
		t.Fatalf("assembling for unix: %v", err)
	}
	if unixProgram != "/opt/fixture/myshell" || unixArgs[0] != "-lc" {
		t.Errorf("unix shape = %q %v", unixProgram, unixArgs)
	}

	windowsProgram, windowsArgs, err := whichArgv("", "node", true)
	if err != nil {
		t.Fatalf("assembling for windows: %v", err)
	}
	// Windows has no login shell whose rc rebuilds PATH, so there is no shell
	// line to build and the name travels as an argv element instead.
	if windowsProgram != "where.exe" {
		t.Errorf("windows program = %q", windowsProgram)
	}
	if len(windowsArgs) != 1 || windowsArgs[0] != "node" {
		t.Errorf("windows args = %v, want the bare name", windowsArgs)
	}
	if unixProgram == windowsProgram {
		t.Error("one build gave one shape — the platform is not an argument")
	}
}

// The name is interpolated into a shell line. Without this check `;`, `$(`, and
// backticks become shell syntax, and that shows up not as a refusal but as the
// execution of a different command.
func TestAnUnsafeNameIsRefusedBeforeTheRunnerIsTouched(t *testing.T) {
	for _, bad := range []string{"a;rm -rf /", "$(whoami)", "`id`", "a b", "a|b", "a&b", "a>b", "", "../../bin/sh", "a\nb"} {
		runner := &fakeRunner{}
		got, err := shellWhich(bad, "/bin/sh", false, runner)
		if err == nil {
			// Answering false here conflates two facts, as a measured build did
			// and admitted in its own comment: "could not ask" and "not there"
			// became one value. Both live callers wrap this in catch(() => false),
			// so nothing regresses by separating them.
			t.Errorf("%q was accepted, answering %v", bad, got)
		}
		if runner.calls != 0 {
			t.Errorf("%q reached the runner", bad)
		}
	}
}

func TestAPlainNameIsAllowed(t *testing.T) {
	for _, good := range []string{"node", "npm", "python3", "my-tool", "my_tool", "a.out"} {
		if _, _, err := whichArgv("/bin/sh", good, false); err != nil {
			t.Errorf("%q was refused: %v", good, err)
		}
	}
}

func TestAZeroExitIsInstalledAndANonZeroExitIsNot(t *testing.T) {
	present, err := shellWhich("node", "/bin/sh", false, &fakeRunner{outcome: Outcome{ExitCode: 0, Stdout: "/usr/bin/node\n"}})
	if err != nil {
		t.Fatalf("asking: %v", err)
	}
	if !present {
		t.Error("a zero exit means the binary is there")
	}

	absent, err := shellWhich("nope", "/bin/sh", false, &fakeRunner{outcome: Outcome{ExitCode: 1}})
	if err != nil {
		t.Fatalf("a plain absence is not a failure: %v", err)
	}
	if absent {
		t.Error("a non-zero exit means the binary is not there")
	}
}

// Collapsing the error into false means one wrong injected shell path
// reports every binary as missing — and that reads as "nothing is installed"
// rather than as a misconfiguration.
func TestAShellThatCannotStartIsAnErrorNotAnAbsence(t *testing.T) {
	_, err := shellWhich("node", "/no/such/shell", false, &fakeRunner{err: errors.New("no such file or directory")})
	if err == nil {
		t.Fatal("a shell that cannot be started must not read as a missing binary")
	}
}

func TestNoInjectedShellRefusesByName(t *testing.T) {
	runner := &fakeRunner{}
	_, err := shellWhich("node", "", false, runner)
	if err == nil {
		t.Fatal("with no login shell there is nothing to ask")
	}
	if !strings.Contains(err.Error(), "LoginShell") {
		t.Errorf("the refusal does not name what to supply: %v", err)
	}
	if runner.calls != 0 {
		t.Error("the runner was called with no shell to run")
	}
}

// "not implemented here" and "there was nothing" must stay different answers.
func TestNoRunnerRefusesByNameRatherThanAnsweringFalse(t *testing.T) {
	_, err := shellWhich("node", "/bin/sh", false, nil)
	if err == nil {
		t.Fatal("with no runner this build cannot answer, and must say so")
	}
	if !strings.Contains(err.Error(), "Run") {
		t.Errorf("the refusal does not name what to supply: %v", err)
	}
}
