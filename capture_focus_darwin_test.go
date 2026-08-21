//go:build darwin

package main

import (
	"strconv"
	"testing"

	"github.com/soksak-ai/soksak-core/frameworks/wails"
)

func activeInputOwner(t *testing.T) string {
	t.Helper()
	processID := wails.ForegroundProcessID()
	if processID < 1 {
		t.Fatal("macOS reported no foreground process")
	}
	return strconv.Itoa(processID)
}
