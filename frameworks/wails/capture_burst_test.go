package wails

import (
	"strings"
	"testing"
	"unsafe"
)

// A burst is judged with the stream faked: what the service adds to a platform stream is the
// request's bounds, the window's presentation for the span, and a report a reader can measure from.

func bursterOf(t *testing.T, stream burstSource) *CaptureService {
	t.Helper()
	handle := byte(1)
	service := NewCaptureService("win-a", func() unsafe.Pointer { return unsafe.Pointer(&handle) }, PresentationInteractive)
	service.burst = stream
	return service
}

func TestABurstReportCarriesEveryFrameTimeAndTheDirectoryItWasAskedFor(t *testing.T) {
	var seen BurstRequest
	service := bursterOf(t, func(_ unsafe.Pointer, request BurstRequest) (BurstReport, error) {
		seen = request
		return BurstReport{Frames: 3, Width: 20, Height: 10, TimesMs: []float64{0, 16.7, 33.4}}, nil
	})
	report, err := service.Burst(BurstRequest{Dir: "/tmp/burst", DurationMs: 500, Frames: 60, Region: Rect{X: 1, Y: 2, Width: 10, Height: 5}})
	if err != nil {
		t.Fatalf("burst: %v", err)
	}
	if report.Dir != "/tmp/burst" || report.Frames != 3 || len(report.TimesMs) != 3 || report.Width != 20 {
		t.Fatalf("report does not describe what the stream produced: %+v", report)
	}
	if seen.Region != (Rect{X: 1, Y: 2, Width: 10, Height: 5}) {
		t.Fatalf("the stream was not asked for the caller's region: %+v", seen.Region)
	}
	if seen.MaxBytes != burstDefaultBytes {
		t.Fatalf("a burst without a budget must carry the default, got %d", seen.MaxBytes)
	}
}

func TestABurstWithNoFrameAnswersAnEmptyListNotNull(t *testing.T) {
	service := bursterOf(t, func(unsafe.Pointer, BurstRequest) (BurstReport, error) {
		return BurstReport{}, nil
	})
	report, err := service.Burst(BurstRequest{Dir: "/tmp/burst", DurationMs: 100, Frames: 1})
	if err != nil {
		t.Fatalf("burst: %v", err)
	}
	if report.TimesMs == nil || len(report.TimesMs) != 0 {
		t.Fatalf("a burst of nothing still answers a list: %+v", report)
	}
}

func TestABurstOutsideItsBoundsIsRefusedNotClamped(t *testing.T) {
	called := false
	service := bursterOf(t, func(unsafe.Pointer, BurstRequest) (BurstReport, error) {
		called = true
		return BurstReport{}, nil
	})
	for name, request := range map[string]BurstRequest{
		"no dir":        {DurationMs: 100, Frames: 1},
		"zero duration": {Dir: "d", DurationMs: 0, Frames: 1},
		"long duration": {Dir: "d", DurationMs: burstMaxDurationMs + 1, Frames: 1},
		"zero frames":   {Dir: "d", DurationMs: 100, Frames: 0},
		"many frames":   {Dir: "d", DurationMs: 100, Frames: burstMaxFrames + 1},
		"interval":      {Dir: "d", DurationMs: 100, Frames: 1, IntervalMs: burstMaxIntervalMs + 1},
		"budget":        {Dir: "d", DurationMs: 100, Frames: 1, MaxBytes: burstMaxBytes + 1},
	} {
		if _, err := service.Burst(request); err == nil {
			t.Fatalf("%s: a request outside the bounds must be refused", name)
		}
	}
	if called {
		t.Fatal("a refused request must not reach the stream")
	}
}

func TestABurstWithoutAStreamBackendFailsByName(t *testing.T) {
	service := bursterOf(t, nil)
	_, err := service.Burst(BurstRequest{Dir: "d", DurationMs: 100, Frames: 1})
	if err == nil || !strings.Contains(err.Error(), ErrCaptureUnsupported.Error()) {
		t.Fatalf("a platform without a stream must say so: %v", err)
	}
}
