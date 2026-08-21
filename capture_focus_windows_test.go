//go:build windows

package main

import (
	"strconv"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32Capture            = windows.NewLazySystemDLL("user32.dll")
	getForegroundWindow      = user32Capture.NewProc("GetForegroundWindow")
	getWindowThreadProcessID = user32Capture.NewProc("GetWindowThreadProcessId")
)

func activeInputOwner(t *testing.T) string {
	t.Helper()
	window, _, _ := getForegroundWindow.Call()
	if window == 0 {
		t.Fatal("Windows reported no foreground window")
	}
	var processID uint32
	thread, _, callErr := getWindowThreadProcessID.Call(window, uintptr(unsafe.Pointer(&processID)))
	if thread == 0 || processID == 0 {
		t.Fatalf("reading the foreground process: %v", callErr)
	}
	return strconv.FormatUint(uint64(processID), 10)
}
