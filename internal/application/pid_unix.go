//go:build !windows

package application

import (
	"os"
	"syscall"
)

// pidAlive answers whether a process is still running.
//
// Signal 0 is delivered to nothing: the kernel performs the permission and
// existence checks and returns, which is the only way to ask this question
// without also affecting the answer. A process owned by another user is alive
// and unsignallable, so EPERM is a yes.
func pidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = process.Signal(syscall.Signal(0))
	if err == nil {
		return true
	}
	return err == syscall.EPERM
}
