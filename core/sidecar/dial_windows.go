//go:build windows

package sidecar

import (
	"fmt"
	"io"
)

// DialLocal has no implementation on this target yet, and fails by name.
//
// A unit's address here is a named pipe: a different namespace with different access control, so
// nothing above translates. Answering with a connection nothing is on would make a unit that never
// started read as one that started and went quiet, and the reason would be somewhere nobody looks.
//
// `core/control`'s listener is unwritten on this target for the same reason, and the two are the two
// halves of one gap.
func DialLocal(address string) (io.ReadWriteCloser, error) {
	return nil, fmt.Errorf(
		"this build cannot reach %s on this target: a unit's address here is a named pipe and no "+
			"dialer for one is written", address)
}
