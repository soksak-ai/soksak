//go:build linux

package main

import (
	"os/exec"
	"strings"
	"testing"
)

func activeInputOwner(t *testing.T) string {
	t.Helper()
	out, err := exec.Command("xdotool", "getwindowfocus").CombinedOutput()
	if err != nil {
		t.Fatalf("reading the focused X11 window: %v: %s", err, out)
	}
	return strings.TrimSpace(string(out))
}
