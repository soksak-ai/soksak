//go:build !windows

package sidecar

import (
	"errors"
	"syscall"
)

// signalPID ends a unit this host adopted, by the pid a previous run recorded.
//
// The negative pid is the group, because a unit is started as one: ending only the leader leaves
// whatever it started with no parent watching and no way for anyone to find it again.
//
// Nothing waits afterwards. The process was started by another run of this application, so its wait
// status is that run's and no longer collectable here — what this does is end it, and what proves it
// ended is that nothing answers at its address.
func signalPID(pid int) error { return syscall.Kill(-pid, syscall.SIGTERM) }

// processGone answers whether the process a record names has ended. Signal 0 delivers nothing: the
// call reports only whether that pid can be signalled at all. No such process is a process that has
// ended. A process this user may not signal is a process that is there.
func processGone(pid int) bool {
	if pid < 1 {
		return true
	}
	return errors.Is(syscall.Kill(pid, 0), syscall.ESRCH)
}
