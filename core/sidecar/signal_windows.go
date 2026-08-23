//go:build windows

package sidecar

import (
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
