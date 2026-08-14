//go:build windows

package main

import "os"

func terminateTerminalProcessGroup(pid int) {
	if pid <= 0 {
		return
	}
	if process, err := os.FindProcess(pid); err == nil {
		_ = process.Kill()
	}
}
