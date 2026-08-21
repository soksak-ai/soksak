package control

import (
	"fmt"
	"net"
	"time"

	winio "github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

// Listen has no implementation on Windows yet.
//
// The address there is a named pipe, which is a different namespace with
// different access control — not a path, so nothing above translates. Answering
// with a working-looking listener that no client can find would be worse than
// this: a caller would investigate their client.
func Listen(path string) (net.Listener, error) {
	if err := validatePipeAddress(path); err != nil {
		return nil, err
	}
	sddl, err := currentUserPipeSDDL()
	if err != nil {
		return nil, fmt.Errorf("control pipe ACL: %w", err)
	}
	listener, err := winio.ListenPipe(path, &winio.PipeConfig{SecurityDescriptor: sddl})
	if err != nil {
		return nil, fmt.Errorf("binding control pipe %s: %w", path, err)
	}
	return listener, nil
}

func Dial(path string) (net.Conn, error) {
	if err := validatePipeAddress(path); err != nil {
		return nil, err
	}
	timeout := 5 * time.Second
	return winio.DialPipe(path, &timeout)
}

func validatePipeAddress(path string) error {
	if len(path) <= len(`\\.\pipe\`) || path[:len(`\\.\pipe\`)] != `\\.\pipe\` {
		return fmt.Errorf("Windows control address must use the named-pipe namespace: %s", path)
	}
	return nil
}

func currentUserPipeSDDL() (string, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", err
	}
	sid := user.User.Sid.String()
	if sid == "" {
		return "", fmt.Errorf("current process token has no SID")
	}
	return "D:P(A;;GA;;;" + sid + ")", nil
}
