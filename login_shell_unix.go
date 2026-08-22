//go:build !windows

package main

import "os"

func loginShell() string {
	return os.Getenv("SHELL")
}
