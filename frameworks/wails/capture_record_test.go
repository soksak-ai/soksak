package wails

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unsafe"
)

func TestAFrameDeadlineNeverLeavesCaptureUsingTheWindowAfterRecordReturns(t *testing.T) {
	service := recorderOf(t, t.TempDir(), func(int) []byte { return nil })
	started := make(chan struct{})
	release := make(chan struct{})
	service.capture = func(unsafe.Pointer, Rect) ([]byte, error) {
		close(started)
		<-release
		return solidPNG(t, 2, 2, background), nil
	}
	done := make(chan RecordReport, 1)
	go func() {
		report, _ := service.Record(RecordRequest{Dir: t.TempDir(), Frames: 1, FrameTimeoutMs: 1})
		done <- report
	}()
	<-started
	select {
	case <-done:
		t.Fatal("record returned while a detached capture still owned the native window")
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	report := <-done
	if !strings.Contains(report.Stopped, "did not arrive") {
		t.Fatalf("the completed late capture must still be reported late: %+v", report)
	}
}

// A burst of frames is captured by this host.
//
// Measured 2026-08-16 on the running application: window.record answered
// INTERNAL. It invoked plugin:webview-capture|record, a command of the
// preceding implementation's plugin that this host never served, so the one
// path that produces a video source did not exist here at all.
//
// The frames are numbered files in one directory, because that is what a video
// source reads and because a frame that landed is then a fact on disk rather
// than a count somebody has to trust.

// recorderOf is a capture whose window read and frame grab are both faked, so a
// burst can be judged with no window and no display.
func recorderOf(t *testing.T, dir string, frame func(int) []byte) *CaptureService {
	t.Helper()
	handle := byte(1)
	service := NewCaptureService("win-a", func() unsafe.Pointer { return unsafe.Pointer(&handle) })
	service.size = func(unsafe.Pointer) (float64, float64, error) { return 100, 100, nil }
	// No window means no throttle to lift. The real switch is a cgo call, and a
	// fixture handle is a Go pointer it refuses.
	service.occlusion = func(unsafe.Pointer, bool) int { return 0 }
	taken := 0
	service.capture = func(unsafe.Pointer, Rect) ([]byte, error) {
		png := frame(taken)
		taken++
		return png, nil
	}
	return service
}

func TestABurstLeavesOneNumberedFilePerFrame(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "rec")
	png := solidPNG(t, 4, 4, background)
	report, err := recorderOf(t, dir, func(int) []byte { return png }).
		Record(RecordRequest{Dir: dir, Frames: 3, IntervalMs: 0})
	if err != nil {
		t.Fatalf("recording: %v", err)
	}
	if report.Frames != 3 {
		t.Errorf("3 frames were asked for and %d landed", report.Frames)
	}
	for _, name := range []string{"f0000.png", "f0001.png", "f0002.png"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Errorf("%s is not on disk: %v", name, err)
		}
	}
}

func TestABurstIsBoundedRatherThanClamped(t *testing.T) {
	// A number outside the range is a mistake, and silently moving it to the
	// nearest allowed one answers a recording nobody asked for.
	dir := t.TempDir()
	png := solidPNG(t, 4, 4, background)
	for _, probe := range []struct {
		what    string
		request RecordRequest
		mustSay string
	}{
		{"no frames", RecordRequest{Dir: dir, Frames: 0}, "frames"},
		{"too many frames", RecordRequest{Dir: dir, Frames: recordMaxFrames + 1}, "frames"},
		{"an interval past the ceiling", RecordRequest{Dir: dir, Frames: 1, IntervalMs: recordMaxIntervalMs + 1}, "interval"},
		{"nowhere to write", RecordRequest{Frames: 1}, "directory"},
	} {
		if _, err := recorderOf(t, dir, func(int) []byte { return png }).Record(probe.request); err == nil {
			t.Errorf("%s was accepted", probe.what)
		} else if !strings.Contains(err.Error(), probe.mustSay) {
			t.Errorf("%s must be refused by name (%q): %v", probe.what, probe.mustSay, err)
		}
	}
}

func TestABurstStopsAtItsByteBudgetWithTheFramesBeforeItIntact(t *testing.T) {
	// The budget is on encoded bytes, checked before a frame is written. An
	// over-budget frame leaves no file, and the frames already committed stay —
	// a recording that deleted its own past on the last frame would lose the
	// evidence it was taken for.
	dir := filepath.Join(t.TempDir(), "rec")
	png := solidPNG(t, 8, 8, background)
	budget := int64(len(png))*2 + int64(len(png))/2

	report, err := recorderOf(t, dir, func(int) []byte { return png }).
		Record(RecordRequest{Dir: dir, Frames: 5, IntervalMs: 0, MaxBytes: budget})
	if err != nil {
		t.Fatalf("recording: %v", err)
	}
	if report.Frames != 2 {
		t.Errorf("the budget holds 2 frames and %d landed", report.Frames)
	}
	if !strings.Contains(report.Stopped, "budget") {
		t.Errorf("a recording cut short must say why: %q", report.Stopped)
	}
	if _, err := os.Stat(filepath.Join(dir, "f0001.png")); err != nil {
		t.Errorf("the frames before the budget ran out must stay: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "f0002.png")); err == nil {
		t.Error("the over-budget frame was written")
	}
}

// Each frame announces itself after its file is complete.
//
// The event is the clock automation reads: a caller that guessed a delay, or
// polled the directory, would be timing something other than the pixels it is
// about to compare. An index that arrives before the write leaves a consumer
// reading a file that is half there.
func TestEachFrameIsAnnouncedOnceItIsOnDisk(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "rec")
	png := solidPNG(t, 4, 4, background)
	var announced []int
	service := recorderOf(t, dir, func(int) []byte { return png })
	service.frames = func(index int) {
		if _, err := os.Stat(frameFile(dir, index)); err != nil {
			t.Errorf("frame %d was announced before its file existed: %v", index, err)
		}
		announced = append(announced, index)
	}

	if _, err := service.Record(RecordRequest{Dir: dir, Frames: 3, IntervalMs: 0}); err != nil {
		t.Fatalf("recording: %v", err)
	}
	if len(announced) != 3 || announced[0] != 0 || announced[2] != 2 {
		t.Errorf("three frames landed and the announcements were %v", announced)
	}
}
