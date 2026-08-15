package daemon

import (
	"fmt"
	"strings"
)

// daemonArgv assembles the command line one daemon runs as.
//
// The caller's text runs through a shell rather than being split into an argv
// here. A daemon declaration is a shell command — `npm run dev`,
// `docker compose up` — and release.publish sends a whole `set -eu` script with
// quoting, pipes and subshells in it. Splitting it here would mean
// reimplementing shell quoting, and the first thing it would break is the
// caller's own escaping.
//
// On unix `-l` is the load-bearing flag, for the reason core/files states about
// shell_which: the login shell re-reads rc/profile and builds PATH from
// scratch, so a process launched from the GUI with a narrow PATH starts the
// same node, npm and docker the user's terminal starts. Without it a daemon
// fails with "command not found" for a tool that is plainly installed.
//
// There is no Windows shape here. A daemon must be stoppable as a tree, and
// core/process states per build tag that this host has no signalable process
// group on Windows; Register declares the two commands that start a process
// unserved there rather than starting one that cannot be stopped.
func daemonArgv(shell string, cmd string) (string, []string, error) {
	if strings.TrimSpace(cmd) == "" {
		return "", nil, fmt.Errorf("argument %q is empty — a shell with nothing to run starts and exits at once, and the caller would read that as a daemon that crashed", "cmd")
	}
	if shell == "" {
		return "", nil, fmt.Errorf("this process was given no login shell to run a daemon through — set daemon.Deps.LoginShell; reading $SHELL here would tie the answer to whatever launched this process")
	}
	return shell, []string{"-lc", cmd}, nil
}
