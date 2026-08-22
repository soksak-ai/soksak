//go:build windows

package main

import (
	"os"
	"path/filepath"
)

func loginShell() string {
	if shell := os.Getenv("ComSpec"); filepath.IsAbs(shell) {
		if info, err := os.Stat(shell); err == nil && info.Mode().IsRegular() {
			return shell
		}
	}
	root := os.Getenv("SystemRoot")
	if !filepath.IsAbs(root) {
		return ""
	}
	shell := filepath.Join(root, "System32", "cmd.exe")
	if info, err := os.Stat(shell); err == nil && info.Mode().IsRegular() {
		return shell
	}
	return ""
}
