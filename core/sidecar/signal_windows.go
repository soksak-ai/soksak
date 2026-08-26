//go:build windows

package sidecar

import (
	"errors"
	"strconv"

	"github.com/soksak-ai/soksak-core/core/i18n"
	"golang.org/x/sys/windows"
)

func signalPID(pid int) error {
	if pid <= 0 {
		return i18n.Errorf("sidecar.invalidAdoptedPID", map[string]string{"pid": strconv.Itoa(pid)})
	}
	handle, err := windows.OpenProcess(windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	if err := windows.TerminateProcess(handle, 1); err != nil {
		return err
	}
	status, err := windows.WaitForSingleObject(handle, 10_000)
	if err != nil {
		return err
	}
	if status != windows.WAIT_OBJECT_0 {
		return i18n.Errorf("sidecar.adoptedStopTimeout", map[string]string{"pid": strconv.Itoa(pid), "seconds": "10"})
	}
	return nil
}

// processGone answers whether the process a record names has ended. A handle that cannot be opened
// because the pid names nothing is a process that has ended; a handle that cannot be opened for any
// other reason is a process that is there. An open handle that is already signalled has exited.
func processGone(pid int) bool {
	if pid < 1 {
		return true
	}
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return errors.Is(err, windows.ERROR_INVALID_PARAMETER)
	}
	defer windows.CloseHandle(handle)
	status, err := windows.WaitForSingleObject(handle, 0)
	return err == nil && status == windows.WAIT_OBJECT_0
}
