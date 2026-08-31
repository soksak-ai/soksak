//go:build darwin

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
	kqueue, err := unix.Kqueue()
	if err != nil {
		return err
	}
	defer unix.Close(kqueue)
	change := unix.Kevent_t{
		Ident: uint64(pid), Filter: unix.EVFILT_PROC,
		Flags: unix.EV_ADD | unix.EV_ONESHOT, Fflags: unix.NOTE_EXIT,
	}
	if _, err := unix.Kevent(kqueue, []unix.Kevent_t{change}, nil, nil); err != nil {
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		return err
	}
	if err := signalPID(pid); err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
	}
	timeout := unix.NsecToTimespec(within.Nanoseconds())
	events := make([]unix.Kevent_t, 1)
	count, err := unix.Kevent(kqueue, nil, events, &timeout)
	if err != nil {
		return err
	}
	if count != 1 {
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
