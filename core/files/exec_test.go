package files

import (
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"
)

// TestTheHelperProcess is not a rule. It is the program the two tests below
// spawn: the test binary is the one executable guaranteed to exist on whatever
// host the gate runs on, so the runner is exercised without assuming /bin/sh or
// where.exe is there.
func TestTheHelperProcess(t *testing.T) {
	if len(flag.Args()) == 0 {
		t.Skip("not the spawned helper")
	}
	code, err := strconv.Atoi(flag.Args()[0])
	if err != nil {
		t.Fatalf("the helper was given %q", flag.Args()[0])
	}
	fmt.Print("printed by the helper")
	os.Exit(code)
}

func helperArgs(exitCode int) []string {
	return []string{"-test.run=^TestTheHelperProcess$", strconv.Itoa(exitCode)}
}

// A program that ran and failed is not a program that could not be run. The
// exit code has to travel as a value, or shell_which cannot tell "the binary is
// missing" from "the shell is missing".
func TestTheRunnerCarriesTheExitCodeRatherThanFailing(t *testing.T) {
	runner := SystemRunner{}

	zero, err := runner.Run(os.Args[0], helperArgs(0))
	if err != nil {
		t.Fatalf("a program that ran must not report an error: %v", err)
	}
	if zero.ExitCode != 0 {
		t.Errorf("exit code = %d, want 0", zero.ExitCode)
	}
	if !strings.Contains(zero.Stdout, "printed by the helper") {
		t.Errorf("stdout = %q", zero.Stdout)
	}

	nonZero, err := runner.Run(os.Args[0], helperArgs(3))
	if err != nil {
		t.Fatalf("a non-zero exit is an answer, not a failure: %v", err)
	}
	if nonZero.ExitCode != 3 {
		t.Errorf("exit code = %d, want 3", nonZero.ExitCode)
	}
}

func TestAProgramThatCannotStartIsAnError(t *testing.T) {
	runner := SystemRunner{}

	if _, err := runner.Run("/no/such/program", nil); err == nil {
		t.Fatal("a program that does not exist must fail rather than answer an exit code")
	}
}
