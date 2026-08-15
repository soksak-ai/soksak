//go:build windows

package process

import "os/exec"

// This host has no process group to signal. Job objects would give the same
// ownership properly, and they are not built here — so the option is refused
// by name rather than accepted and quietly dropped.
const (
	groupHonoured           = false
	groupNotHonouredBecause = "windows has no signalable process group; a job object would be needed"
)

// applyGroup is never reached: groupRefusal stops a grouped spawn first.
func applyGroup(*exec.Cmd) {}

func signalGroup(int) {}
