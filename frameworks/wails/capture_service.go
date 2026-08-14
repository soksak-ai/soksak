package wails

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"unsafe"
)

// CaptureService exposes window capture to anything driving this application.
//
// A capability with no command cannot be verified from outside, and "there was
// no command for it" is not a reason to leave something unobserved.
type CaptureService struct {
	window func() unsafe.Pointer
}

func NewCaptureService(window func() unsafe.Pointer) *CaptureService {
	return &CaptureService{window: window}
}

func (service *CaptureService) ServiceName() string { return "soksak-capture" }

func (service *CaptureService) target() (unsafe.Pointer, error) {
	if service.window == nil {
		return nil, fmt.Errorf("capture has no window source")
	}
	handle := service.window()
	if handle == nil {
		return nil, fmt.Errorf("capture ran before the window existed")
	}
	return handle, nil
}

// Snapshot writes a PNG of the whole window and answers with where it landed.
//
// The path is returned rather than assumed, so a caller verifies from the
// response instead of guessing where the file went.
func (service *CaptureService) Snapshot(path string) (string, error) {
	return service.SnapshotRegion(path, Whole)
}

// SnapshotRegion writes a PNG cropped to a window-relative rect in CSS points.
func (service *CaptureService) SnapshotRegion(path string, rect Rect) (string, error) {
	handle, err := service.target()
	if err != nil {
		return "", err
	}
	png, err := CaptureWindow(handle, rect)
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", fmt.Errorf("capture needs a path to write to")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", fmt.Errorf("capture could not create %s: %w", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, png, 0o644); err != nil {
		return "", fmt.Errorf("capture could not write %s: %w", path, err)
	}
	return path, nil
}

// Pixels answers with a base64 PNG instead of touching the disk, for callers
// that only want to look.
func (service *CaptureService) Pixels(rect Rect) (string, error) {
	handle, err := service.target()
	if err != nil {
		return "", err
	}
	png, err := CaptureWindow(handle, rect)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(png), nil
}
