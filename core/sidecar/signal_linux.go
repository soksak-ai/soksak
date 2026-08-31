//go:build linux

package sidecar

import (
	"errors"
	"strconv"
	"syscall"
	"time"

	"github.com/soksak-ai/soksak-core/core/i18n"
	"golang.org/x/sys/unix"
)

func signalPID(pid int) error { return syscall.Kill(-pid, syscall.SIGTERM) }

func stopPID(pid int, within time.Duration) error {
	if pid <= 0 {
		return i18n.Errorf("sidecar.invalidAdoptedPID", map[string]string{"pid": strconv.Itoa(pid)})
	}
	pidfd, err := unix.PidfdOpen(pid, 0)
	if err != nil {
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		return err
	}
	defer unix.Close(pidfd)
	if err := signalPID(pid); err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
	}
	timeoutMillis := int((within + time.Millisecond - 1) / time.Millisecond)
	fds := []unix.PollFd{{Fd: int32(pidfd), Events: unix.POLLIN}}
	count, err := unix.Poll(fds, timeoutMillis)
	if err != nil {
		return err
	}
	if count != 1 || fds[0].Revents&unix.POLLIN == 0 {
		return i18n.Errorf("sidecar.adoptedStopTimeout", map[string]string{
			"pid": strconv.Itoa(pid), "seconds": stopTimeoutSeconds(within),
		})
	}
	return nil
}

func processGone(pid int) bool {
	if pid < 1 {
		return true
	}
	return errors.Is(syscall.Kill(pid, 0), syscall.ESRCH)
}
