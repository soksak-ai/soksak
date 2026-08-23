//go:build windows

package application

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWindowsLoginShellUsesComSpec(t *testing.T) {
	system, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	shell := filepath.Join(t.TempDir(), "Command Shell.exe")
	if err := os.WriteFile(shell, []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ComSpec", shell)
	t.Setenv("SystemRoot", system)
	if got := loginShell(); got != shell {
		t.Fatalf("login shell = %q", got)
	}
}
