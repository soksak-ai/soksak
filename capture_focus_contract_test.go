package main

import (
	"os"
	"strings"
	"testing"
)

func TestDarwinFocusObservationUsesTheNativeWorkspace(t *testing.T) {
	source, err := os.ReadFile("capture_focus_darwin_test.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	for _, forbidden := range []string{"osascript", "System Events"} {
		if strings.Contains(text, forbidden) {
			t.Errorf("darwin focus observation depends on %s", forbidden)
		}
	}
	if !strings.Contains(text, "wails.ForegroundProcessID") {
		t.Fatal("darwin focus observation does not use the native Wails seam")
	}
}
