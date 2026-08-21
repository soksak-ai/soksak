package daemon

import (
	"strings"

	"github.com/soksak-ai/soksak-core/core/i18n"
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
		return "", nil, i18n.Errorf("daemon.shell.emptyCommand", map[string]string{"name": "cmd"})
	}
	if shell == "" {
		return "", nil, i18n.Errorf("daemon.shell.noLoginShell", nil)
	}
	return shell, []string{"-lc", cmd}, nil
}
