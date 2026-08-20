//go:build !windows

package sidecar

import "syscall"

// signalPID ends a unit this host adopted, by the pid a previous run recorded.
//
// The negative pid is the group, because a unit is started as one: ending only the leader leaves
// whatever it started with no parent watching and no way for anyone to find it again.
//
// Nothing waits afterwards. The process was started by another run of this application, so its wait
// status is that run's and no longer collectable here — what this does is end it, and what proves it
// ended is that nothing answers at its address.
func signalPID(pid int) error { return syscall.Kill(-pid, syscall.SIGTERM) }
