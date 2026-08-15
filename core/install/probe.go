package install

import (
	"errors"

	"github.com/soksak/soksak-core/core/files"
)

// Probe is what running a binary answered.
type Probe struct {
	// OK is the probe argv exiting zero — the binary actually works.
	OK bool `json:"ok"`
	// Stdout is carried raw. Reading a version out of it is the caller's, with
	// the caller's expression: interpreting the text here would put one
	// dependency's output format in the core.
	Stdout string `json:"stdout"`
}

// probeBinary runs the binary and reports whether it worked.
//
// Presence is not working. A half-installed package, a dangling launcher, and
// an unresolved shared library all leave a file that exists and cannot run, so
// this observation asks by running rather than by looking.
//
// A binary that could not be started at all answers ok=false rather than
// failing. The caller asks one question — does this dependency work — and
// "absent" and "ran and failed" are the same answer to it.
//
// What is deliberately not folded into ok=false is a build with no runner. That
// is a fact about this process, not about the binary, and answering false would
// report every dependency on the machine as broken.
func probeBinary(bin string, args []string, runner files.Runner) (Probe, error) {
	if bin == "" {
		return Probe{}, errors.New("probe_binary needs bin; an empty name has nothing to run")
	}
	if runner == nil {
		return Probe{}, errors.New("probe_binary cannot run anything in this build — set install.Deps.Run")
	}

	// The argv reaches the runner as values, so there is no shell line and
	// nowhere for shell syntax to be interpreted. A bare name is still resolved
	// against this process's PATH by the operating system — the caller sends an
	// absolute path whenever it has one, which is the only form whose answer
	// does not depend on who is asking.
	outcome, err := runner.Run(bin, args)
	if err != nil {
		return Probe{}, nil
	}
	return Probe{OK: outcome.ExitCode == 0, Stdout: outcome.Stdout}, nil
}
