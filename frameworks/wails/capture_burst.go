package wails

import (
	"strconv"
	"unsafe"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

// A burst: every frame the compositor produced for the window over a span, at the display's rate.
//
// A recording is a series of single captures, and one costs about 120ms; a change that is over in
// one display frame is between two of them. Measured 2026-09-05: a pane blank between a surface
// and its picture was in none of a burst's snapshots and in every eye that looked. The stream
// backend hands over each frame the compositor produced with the time it was produced, so a
// one-frame event is on disk with its duration.

const (
	burstMaxDurationMs = 10_000
	burstMaxFrames     = 600
	burstMaxIntervalMs = 1_000
	burstMaxBytes      = 2 << 30
	// burstDefaultBytes bounds the raw pixels waiting to be encoded when the caller names no budget:
	// a whole window at 2x is about 12MB a frame, so this is a little under a second of frames the
	// encoders have not caught up with.
	burstDefaultBytes = 512 << 20
)

// BurstRequest is one burst.
type BurstRequest struct {
	// Dir holds the frames, created if it is not there.
	Dir string
	// DurationMs is how long the stream runs, 1 through burstMaxDurationMs.
	DurationMs int
	// Frames ends the burst early once this many landed, 1 through burstMaxFrames.
	Frames int
	// IntervalMs is the least time between two frames, 0 through burstMaxIntervalMs. Zero takes
	// every frame the display produces.
	IntervalMs int
	// MaxBytes bounds the raw pixel bytes waiting for an encoder, 0 for the default.
	MaxBytes int64
	// Region is the part of the window each frame holds. The zero value is the whole window.
	Region Rect
}

// BurstReport is what a burst left behind.
//
// TimesMs is one entry per frame on disk, milliseconds from the start of the stream, so a reader
// measures how long a state was on screen from the frames that bracket it. Stopped names why the
// burst ended before its duration.
type BurstReport struct {
	Dir     string    `json:"dir"`
	Frames  int       `json:"frames"`
	Width   int       `json:"w"`
	Height  int       `json:"h"`
	TimesMs []float64 `json:"timesMs"`
	Stopped string    `json:"stopped,omitempty"`
}

// Burst streams this service's window into request.Dir.
//
// Whether the window is ordered front for the span is the caller's, as it is for a single capture
// (window_capture_present): an occluded document stops animating, and a burst of a window that is
// not moving is a burst of nothing.
func (service *CaptureService) Burst(request BurstRequest) (BurstReport, error) {
	if request.Dir == "" {
		return BurstReport{}, i18n.Errorf("wails.burst.noDir", nil)
	}
	if request.DurationMs < 1 || request.DurationMs > burstMaxDurationMs {
		return BurstReport{}, i18n.Errorf("wails.burst.durationOutOfRange", map[string]string{
			"max": strconv.Itoa(burstMaxDurationMs), "given": strconv.Itoa(request.DurationMs)})
	}
	if request.Frames < 1 || request.Frames > burstMaxFrames {
		return BurstReport{}, i18n.Errorf("wails.burst.framesOutOfRange", map[string]string{
			"max": strconv.Itoa(burstMaxFrames), "given": strconv.Itoa(request.Frames)})
	}
	if request.IntervalMs < 0 || request.IntervalMs > burstMaxIntervalMs {
		return BurstReport{}, i18n.Errorf("wails.burst.intervalOutOfRange", map[string]string{
			"max": strconv.Itoa(burstMaxIntervalMs), "given": strconv.Itoa(request.IntervalMs)})
	}
	if request.MaxBytes < 0 || request.MaxBytes > burstMaxBytes {
		return BurstReport{}, i18n.Errorf("wails.burst.budgetOutOfRange", map[string]string{
			"max": strconv.FormatInt(burstMaxBytes, 10), "given": strconv.FormatInt(request.MaxBytes, 10)})
	}
	if request.MaxBytes == 0 {
		request.MaxBytes = burstDefaultBytes
	}
	if service.burst == nil {
		return BurstReport{}, ErrCaptureUnsupported
	}
	handle, err := service.target()
	if err != nil {
		return BurstReport{}, err
	}
	report, err := service.burst(handle, request)
	if err != nil {
		return BurstReport{}, err
	}
	report.Dir = request.Dir
	if report.TimesMs == nil {
		report.TimesMs = []float64{}
	}
	return report, nil
}

// burstSource is the platform stream, nil where there is none.
type burstSource func(window unsafe.Pointer, request BurstRequest) (BurstReport, error)
