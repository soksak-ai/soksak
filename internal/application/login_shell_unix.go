//go:build !windows

package application

import "os"

func loginShell() string {
	return os.Getenv("SHELL")
}
