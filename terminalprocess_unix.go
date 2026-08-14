//go:build darwin || linux || freebsd || openbsd || netbsd || dragonfly

package main

import "syscall"

// creack/pty starts the command as a new session leader. Killing that process
// group closes the terminal and every process the shell started inside it.
func terminateTerminalProcessGroup(pid int) {
	if pid > 0 {
		_ = syscall.Kill(-pid, syscall.SIGKILL)
	}
}
