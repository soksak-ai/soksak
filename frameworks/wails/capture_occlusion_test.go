package wails

import (
	"errors"
	"path/filepath"
	"testing"
	"unsafe"
)

// A capture keeps the window rendering for as long as it takes it.
//
// macOS throttles a fully covered window's web content, so the pixels a capture
// reads are then the last frame drawn before it was covered. Nothing in the
// image marks that: a terminal that stopped updating an hour ago is the same
// picture as one with nothing new to show.
//
// Detection is turned off for the length of the capture and turned back on
// after. Left off, the window renders forever at a battery cost nobody asked
// for; left on, a capture of a covered window holds whatever the throttle left
// behind.
//
// Measured 2026-08-16: this host had no way to turn it off at all —
// window.occlusion invoked plugin:webview-capture|set_occlusion, a command of
// the preceding implementation's plugin that this host never served.

// occlusionLog records what a capture asked of the window.
type occlusionLog struct {
	asked   []bool
	applied int
}

func (log *occlusionLog) set(enabled bool) int {
	log.asked = append(log.asked, enabled)
	return log.applied
}

func capturingWith(t *testing.T, log *occlusionLog, grab func() ([]byte, error)) *CaptureService {
	t.Helper()
	handle := byte(1)
	service := NewCaptureService("win-a", func() unsafe.Pointer { return unsafe.Pointer(&handle) })
	service.size = func(unsafe.Pointer) (float64, float64, error) { return 100, 100, nil }
	service.capture = func(unsafe.Pointer, Rect) ([]byte, error) { return grab() }
	service.occlusion = func(_ unsafe.Pointer, enabled bool) int { return log.set(enabled) }
	return service
}

func TestACaptureTurnsDetectionOffAndBackOn(t *testing.T) {
	png := solidPNG(t, 4, 4, background)
	log := &occlusionLog{applied: 2}

	if _, err := capturingWith(t, log, func() ([]byte, error) { return png, nil }).
		Pixels(Whole); err != nil {
		t.Fatalf("capturing: %v", err)
	}
	if len(log.asked) != 2 || log.asked[0] != false || log.asked[1] != true {
		t.Errorf("a capture must turn detection off and put it back: %v", log.asked)
	}
}

func TestDetectionGoesBackOnEvenWhenTheCaptureFails(t *testing.T) {
	// Left off, the window renders forever. A capture that failed is the case
	// where nobody is watching for it.
	log := &occlusionLog{applied: 1}
	_, err := capturingWith(t, log, func() ([]byte, error) { return nil, errors.New("no pixels") }).
		Pixels(Whole)
	if err == nil {
		t.Fatal("the capture was supposed to fail")
	}
	if len(log.asked) != 2 || log.asked[1] != true {
		t.Errorf("detection was left off after a failed capture: %v", log.asked)
	}
}

func TestABurstHoldsDetectionOffOnceRatherThanPerFrame(t *testing.T) {
	// Per frame, the resume wait is paid 600 times and the window is handed
	// back to the throttle between every pair of frames — which is exactly the
	// gap the recording exists to look at.
	dir := filepath.Join(t.TempDir(), "rec")
	png := solidPNG(t, 4, 4, background)
	log := &occlusionLog{applied: 1}
	service := capturingWith(t, log, func() ([]byte, error) { return png, nil })

	if _, err := service.Record(RecordRequest{Dir: dir, Frames: 5, IntervalMs: 0}); err != nil {
		t.Fatalf("recording: %v", err)
	}
	if len(log.asked) != 2 {
		t.Errorf("a burst of 5 frames asked %d times, not twice: %v", len(log.asked), log.asked)
	}
}
