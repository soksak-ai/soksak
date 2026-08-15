package install

import (
	"errors"
	"strings"
	"testing"

	"github.com/soksak/soksak-core/core/files"
)

// scriptedRunner answers what it was told to answer, and records what it was
// asked. Nothing here spawns a process: the rule under test is what counts as
// working, and that rule has to hold on a machine with none of these binaries.
type scriptedRunner struct {
	program string
	args    []string
	outcome files.Outcome
	err     error
}

func (runner *scriptedRunner) Run(program string, args []string) (files.Outcome, error) {
	runner.program = program
	runner.args = args
	return runner.outcome, runner.err
}

// TestPresenceAndWorkingAreTwoAnswers is why this command runs the binary
// instead of looking for it. A half-installed package leaves a file that exists
// and exits non-zero, and counting existence as working lets a broken install
// pass as a satisfied dependency.
func TestPresenceAndWorkingAreTwoAnswers(t *testing.T) {
	working := &scriptedRunner{outcome: files.Outcome{ExitCode: 0, Stdout: "v20.11.0\n"}}
	probe, err := probeBinary("/opt/bin/node", []string{"--version"}, working)
	if err != nil {
		t.Fatalf("probing: %v", err)
	}
	if !probe.OK || probe.Stdout != "v20.11.0\n" {
		t.Fatalf("probe = %+v, want ok with the version text", probe)
	}

	failing := &scriptedRunner{outcome: files.Outcome{ExitCode: 1, Stdout: "dyld: library not loaded\n"}}
	probe, err = probeBinary("/opt/bin/node", []string{"--version"}, failing)
	if err != nil {
		t.Fatalf("probing: %v", err)
	}
	if probe.OK {
		t.Fatal("a binary that exists and exits non-zero was reported as working")
	}
}

// TestABinaryThatCannotStartIsNotAFailureOfTheCommand keeps "this dependency
// does not work" an answer rather than an error. The caller has one question,
// and absent and ran-and-failed are the same answer to it.
func TestABinaryThatCannotStartIsNotAFailureOfTheCommand(t *testing.T) {
	probe, err := probeBinary("/opt/bin/absent", nil, &scriptedRunner{err: errors.New("no such file or directory")})
	if err != nil {
		t.Fatalf("a binary that could not start made the observation fail: %v", err)
	}
	if probe.OK || probe.Stdout != "" {
		t.Fatalf("probe = %+v, want the empty not-working answer", probe)
	}
}

// TestNoRunnerFailsByName is the one thing that must not fold into ok=false.
// A build that cannot run anything would otherwise report every dependency on
// the machine as broken, and the user would go looking at their machine.
func TestNoRunnerFailsByName(t *testing.T) {
	_, err := probeBinary("/opt/bin/node", nil, nil)
	if err == nil {
		t.Fatal("a build with no runner answered as if the binary were broken")
	}
	if !strings.Contains(err.Error(), "install.Deps.Run") {
		t.Errorf("the refusal does not name what is missing: %v", err)
	}
}

// TestTheArgvIsPassedThroughUntouched holds the injection boundary. The
// arguments reach the runner as values, so there is no shell line and nowhere
// for a metacharacter to become syntax.
func TestTheArgvIsPassedThroughUntouched(t *testing.T) {
	runner := &scriptedRunner{}
	if _, err := probeBinary("/opt/bin/tool", []string{"--check", "a; rm -rf /"}, runner); err != nil {
		t.Fatalf("probing: %v", err)
	}
	if runner.program != "/opt/bin/tool" {
		t.Errorf("program = %q, want the bin it was given", runner.program)
	}
	if len(runner.args) != 2 || runner.args[1] != "a; rm -rf /" {
		t.Errorf("args = %q, want them passed through as values", runner.args)
	}
}

// TestAnEmptyNameIsRefused stops a blank composed path from being handed to the
// operating system, where it would fail with a message about the caller's argv
// rather than about the dependency.
func TestAnEmptyNameIsRefused(t *testing.T) {
	if _, err := probeBinary("", nil, &scriptedRunner{}); err == nil {
		t.Fatal("an empty bin was accepted")
	}
}
