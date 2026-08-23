package application

import "os"

// pidAlive answers whether a process is still running.
//
// Unlike unix, FindProcess here opens a handle, so its failure is the answer
// rather than a formality. No cgo: this is the standard library over the same
// Win32 call.
func pidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	_ = process.Release()
	return true
}
