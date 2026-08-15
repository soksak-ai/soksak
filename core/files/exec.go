package files

import (
	"errors"
	"os/exec"
)

// SystemRunner is the one place in this package that starts a process.
//
// It stays in core because it reads nothing ambient: the program and every
// argument arrive as values, so the same call answers the same way in a window,
// in a headless server, and in a test. What it does not decide is *what* to
// run — that is whichArgv's, and this type never looks at the argv it is
// handed.
//
// The child inherits this process's environment, which is deliberate and is why
// the unix argv includes `-l`: the login shell discards that inherited PATH
// and rebuilds it from rc/profile, so a GUI-launched process answers what the
// user's terminal answers.
type SystemRunner struct{}

// Run executes the program and waits.
//
// An error means the program could not be started at all. A program that ran
// and failed answers through Outcome.ExitCode, because "the binary is missing"
// and "the shell is missing" are different facts and one of them is a
// misconfiguration the user must see.
func (SystemRunner) Run(program string, args []string) (Outcome, error) {
	stdout, err := exec.Command(program, args...).Output()
	if err != nil {
		var exited *exec.ExitError
		if errors.As(err, &exited) {
			return Outcome{ExitCode: exited.ExitCode(), Stdout: string(stdout)}, nil
		}
		return Outcome{}, err
	}
	return Outcome{ExitCode: 0, Stdout: string(stdout)}, nil
}
