//go:build !windows

package control

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
)

// socketPathLimit is what a unix socket address holds.
//
// The kernel copies the path into a fixed array — 104 bytes on darwin, 108 on
// linux — and overrunning it fails with "invalid argument", which states nothing
// about paths. The lower of the two is used so a home that works here works
// everywhere this builds.
const socketPathLimit = 104

// Listen binds the control plane's socket.
//
// Mode 0600: the socket answers every command this build has, so anyone who can
// connect can do anything the application can. A group-readable one would hand
// that to every process the user runs.
//
// A socket left by a process that died is removed first. Refusing instead would
// make every crash need a manual cleanup before the application could start,
// and the file is not what holds the lock — a live owner still has the address
// bound, so the bind below fails and names it.
func Listen(path string) (net.Listener, error) {
	if len(path) >= socketPathLimit {
		return nil, fmt.Errorf(
			"the control socket path is %d bytes and this platform holds %d: %s",
			len(path), socketPathLimit, path)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("the control socket's directory: %w", err)
	}
	if err := removeDeadSocket(path); err != nil {
		return nil, err
	}

	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, fmt.Errorf("binding the control socket at %s: %w", path, err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = listener.Close()
		return nil, fmt.Errorf("restricting the control socket at %s: %w", path, err)
	}
	return listener, nil
}

// removeDeadSocket clears a socket file whose owner is gone.
//
// Liveness is asked by connecting, not by looking: the file exists for as long
// as the filesystem holds it, which outlives the process that bound it by any
// amount of time.
func removeDeadSocket(path string) error {
	info, err := os.Stat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("looking at %s: %w", path, err)
	}
	if info.Mode()&os.ModeSocket == 0 {
		// Something that is not a socket is in the way. Removing it would
		// destroy a file this build cannot identify.
		return fmt.Errorf("%s exists and is not a socket", path)
	}

	connection, err := net.Dial("unix", path)
	if err == nil {
		_ = connection.Close()
		return fmt.Errorf("another backend is already answering at %s", path)
	}
	return os.Remove(path)
}
