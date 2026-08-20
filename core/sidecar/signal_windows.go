//go:build windows

package sidecar

import "fmt"

// signalPID has no implementation on this target and fails by name.
//
// Ending a process tree here needs a job object, which is created where the process is started —
// and a unit this host adopted was started by a run that is gone, so there is no handle to it. An
// empty function would make "the unit was ended" and "this build cannot end one" the same answer.
func signalPID(pid int) error {
	return fmt.Errorf(
		"this build cannot end adopted unit process %d on this target: a process tree here needs a "+
			"job object, and the handle to one belongs to the run that started it", pid)
}
