package control

import (
	"fmt"
	"net"
)

// Listen has no implementation on Windows yet.
//
// The address there is a named pipe, which is a different namespace with
// different access control — not a path, so nothing above translates. Answering
// with a working-looking listener that no client can find would be worse than
// this: a caller would investigate their client.
func Listen(path string) (net.Listener, error) {
	return nil, fmt.Errorf(
		"the control plane has no Windows transport yet; it needs a named pipe rather than the path %s", path)
}
