package wails

import (
	"fmt"
	"path/filepath"
	"time"
	"unsafe"
)

// A burst of frames: the video source this host produces.
//
// The window a burst is of is the service's own, and the region is the caller's
// — so the whole window and one tab are the same command with a different rect,
// and both come out as numbered files a video encoder reads in order.
//
// Measured 2026-08-16: window.record answered INTERNAL because it invoked a
// command of the preceding implementation's plugin, which this host never
// served. Nothing here produced consecutive frames at all.

const (
	// recordMaxFrames and the two bounds below are ceilings, not clamps. A
	// number outside the range is a mistake, and moving it silently to the
	// nearest allowed one answers a recording nobody asked for.
	recordMaxFrames     = 600
	recordMaxIntervalMs = 60_000
	recordMaxBytes      = 1 << 30

	// recordDefaultFrameTimeoutMs is the per-frame grab deadline when the caller
	// names none.
	recordDefaultFrameTimeoutMs = 8_000
	recordMaxFrameTimeoutMs     = 60_000
)

// RecordRequest is one burst.
type RecordRequest struct {
	// Dir holds the frames. It is created if it is not there.
	Dir string
	// Frames is how many to take, 1 through recordMaxFrames.
	Frames int
	// IntervalMs is the wait between them, 0 through recordMaxIntervalMs. Zero
	// is as fast as the capture answers, which is a legitimate request.
	IntervalMs int
	// MaxBytes is a cumulative ceiling on encoded frame bytes, 0 for none. The
	// frame that would cross it is not written, and the ones before it stay.
	MaxBytes int64
	// Region is the part of the window each frame holds. The zero value is the
	// whole window.
	Region Rect
	// FrameTimeoutMs bounds one frame's grab, 1 through recordMaxFrameTimeoutMs.
	// Zero takes the default.
	//
	// A grab that never comes back would hold the whole burst, and a recording
	// that stops at frame 3 of 600 with no reason is indistinguishable from one
	// nobody started. After the deadline the receiver is detached, so a late
	// frame cannot write a file out of order.
	FrameTimeoutMs int
}

// RecordReport is what a burst left behind.
//
// Frames is what landed on disk, which is not always what was asked for, and
// Stopped is why when they differ. A count with no reason next to it makes a
// short recording and a complete one the same answer.
type RecordReport struct {
	Dir       string `json:"dir"`
	Requested int    `json:"requested"`
	Frames    int    `json:"frames"`
	Bytes     int64  `json:"bytes"`
	Stopped   string `json:"stopped,omitempty"`
	// Note is what the last frame drew, so a burst of empty panes states the
	// reason once rather than leaving it to be read out of the pixels.
	Note CaptureNote `json:"note"`
}

// Record captures Frames frames of this service's window into Dir.
//
// Each frame goes through the same path as a single capture, so a native
// surface is composited into every one of them. A recording of a browser pane
// that came back flat would be the defect the single capture already fixed,
// arriving 600 times.
func (service *CaptureService) Record(request RecordRequest) (RecordReport, error) {
	if request.Dir == "" {
		return RecordReport{}, fmt.Errorf("a recording needs a directory to write its frames into")
	}
	if request.Frames < 1 || request.Frames > recordMaxFrames {
		return RecordReport{}, fmt.Errorf(
			"a recording takes 1 through %d frames; %d is outside that and is not clamped to it",
			recordMaxFrames, request.Frames)
	}
	if request.IntervalMs < 0 || request.IntervalMs > recordMaxIntervalMs {
		return RecordReport{}, fmt.Errorf(
			"a recording interval is 0 through %dms; %dms is outside that and is not clamped to it",
			recordMaxIntervalMs, request.IntervalMs)
	}
	if request.MaxBytes < 0 || request.MaxBytes > recordMaxBytes {
		return RecordReport{}, fmt.Errorf(
			"a recording budget is 1 through %d bytes; %d is outside that",
			recordMaxBytes, request.MaxBytes)
	}

	if request.FrameTimeoutMs < 0 || request.FrameTimeoutMs > recordMaxFrameTimeoutMs {
		return RecordReport{}, fmt.Errorf(
			"a frame deadline is 1 through %dms; %dms is outside that",
			recordMaxFrameTimeoutMs, request.FrameTimeoutMs)
	}
	deadline := time.Duration(request.FrameTimeoutMs) * time.Millisecond
	if request.FrameTimeoutMs == 0 {
		deadline = recordDefaultFrameTimeoutMs * time.Millisecond
	}

	handle, err := service.target()
	if err != nil {
		return RecordReport{}, err
	}
	// Held once for the whole burst. Per frame, the resume wait is paid on every
	// one of them and the window is handed back to the throttle between each
	// pair — which is the gap a recording exists to look at.
	defer service.holdRendering(handle)()

	report := RecordReport{Dir: request.Dir, Requested: request.Frames}
	for frame := 0; frame < request.Frames; frame++ {
		if frame > 0 && request.IntervalMs > 0 {
			time.Sleep(time.Duration(request.IntervalMs) * time.Millisecond)
		}
		png, err := service.grab(handle, request.Region, deadline)
		if err != nil {
			// The frames already on disk are the recording. Losing them because
			// the next grab failed would throw away the evidence the burst was
			// taken for.
			report.Stopped = fmt.Sprintf("frame %d could not be captured: %v", frame, err)
			return report, nil
		}
		png, note := service.finish(handle, png, request.Region)
		report.Note = note

		// Checked before the file is written, so an over-budget frame leaves
		// nothing behind and the count matches what is on disk.
		if request.MaxBytes > 0 && report.Bytes+int64(len(png)) > request.MaxBytes {
			report.Stopped = fmt.Sprintf(
				"frame %d would put the recording over its %d byte budget", frame, request.MaxBytes)
			return report, nil
		}
		if err := writeCapture(frameFile(request.Dir, frame), png); err != nil {
			report.Stopped = err.Error()
			return report, nil
		}
		report.Bytes += int64(len(png))
		report.Frames++
		// After the write, never before. An index that arrives first has a consumer reading a
		// file that is half there, and the clock then leads the pixels it is meant to mark.
		if service.frames != nil {
			service.frames(frame)
		}
	}
	return report, nil
}

// frameFile is one frame's name.
//
// Zero-padded and fixed width so the directory sorts in capture order for a
// video encoder and for a person reading it. A bare number sorts f10 before f2.
func frameFile(dir string, frame int) string {
	return filepath.Join(dir, fmt.Sprintf("f%04d.png", frame))
}

// StreamSink delivers one frame to a receiver the caller passed.
//
// The shape core/control/stream.go owns, named here because the capture is not
// the terminal: two groups deliver frames and neither should reach into the
// other for the type. Nil is a build with no event bus, which sends nothing
// rather than dropping frames silently — the recording still lands on disk and
// the report still names how many.
type StreamSink func(stream string, frame any)

// grab takes one frame, or gives up at the deadline.
//
// The capture runs on its own goroutine with a buffered answer, so a grab that
// comes back late writes into a channel nobody reads rather than into the
// recording. A frame that arrived after its turn would be numbered as the one
// after it, and the recording would then hold two frames of one instant and
// none of another.
func (service *CaptureService) grab(handle unsafe.Pointer, region Rect, deadline time.Duration) ([]byte, error) {
	type frame struct {
		png []byte
		err error
	}
	answer := make(chan frame, 1)
	go func() {
		png, err := service.capture(handle, region)
		answer <- frame{png: png, err: err}
	}()
	select {
	case taken := <-answer:
		return taken.png, taken.err
	case <-time.After(deadline):
		return nil, fmt.Errorf("the frame did not arrive within %s", deadline)
	}
}
