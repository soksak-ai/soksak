//go:build !windows

package sidecar

import (
	"io"
	"net"
)

// DialLocal opens a connection to an address a unit announced.
//
// A unit's address is a filesystem path here. On another target the namespace is different — a named
// pipe rather than a path — which is why this is a build-tagged function and not a branch on the
// platform: the rule above it holds no opinion about which namespace it is in.
func DialLocal(address string) (io.ReadWriteCloser, error) {
	return net.Dial("unix", address)
}
