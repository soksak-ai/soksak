//go:build !windows

package process

import (
	"os/exec"
	"syscall"
)

// This host puts a child in its own process group, so a kill covers the tree.
const (
	groupHonoured           = true
	groupNotHonouredBecause = ""
)

// Setpgid with no Pgid makes the group id the child's own pid, which is what
// lets a later kill name the whole tree with one number.
func applyGroup(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// signalGroup is best effort: the tree may already be gone, and the direct
// child is signalled straight after either way.
func signalGroup(pid int) {
	if pid > 0 {
		_ = syscall.Kill(-pid, syscall.SIGKILL)
	}
}
