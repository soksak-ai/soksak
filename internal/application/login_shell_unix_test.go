//go:build !windows

package application

import "testing"

func TestUnixLoginShellUsesTheLauncherDeclaration(t *testing.T) {
	t.Setenv("SHELL", "/bin/example-shell")
	if got := loginShell(); got != "/bin/example-shell" {
		t.Fatalf("login shell = %q", got)
	}
}
