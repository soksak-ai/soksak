package wails

import (
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Colours whose luminance is a literal, so an assertion states a number rather
// than repeating the formula under test.
var (
	frameBlack = color.NRGBA{R: 0, G: 0, B: 0, A: 255}
	frameRed   = color.NRGBA{R: 255, G: 0, B: 0, A: 255}
	frameGreen = color.NRGBA{R: 0, G: 255, B: 0, A: 255}
	frameBlue  = color.NRGBA{R: 0, G: 0, B: 255, A: 255}
	frameWhite = color.NRGBA{R: 255, G: 255, B: 255, A: 255}
)

const (
	luminanceRed   = 0.2126
	luminanceGreen = 0.7152
	luminanceBlue  = 0.0722
	luminanceWhite = luminanceRed + luminanceGreen + luminanceBlue
)

// bands is a frame of two vertical bands, split at splitX pixels.
func bands(width, height, splitX int, left, right color.NRGBA) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			paint := left
			if x >= splitX {
				paint = right
			}
			img.SetNRGBA(x, y, paint)
		}
	}
	return img
}

// grey is a solid frame of one level on all three channels.
func grey(width, height, level int) *image.NRGBA {
	value := uint8(level)
	return bands(width, height, width, color.NRGBA{R: value, G: value, B: value, A: 255}, frameBlack)
}

// writeFrame puts one frame in the directory under the name the recorder uses.
func writeFrame(t *testing.T, dir string, frame int, img image.Image) {
	t.Helper()
	file, err := os.Create(frameFile(dir, frame))
	if err != nil {
		t.Fatalf("creating frame %d: %v", frame, err)
	}
	if err := png.Encode(file, img); err != nil {
		t.Fatalf("encoding frame %d: %v", frame, err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("closing frame %d: %v", frame, err)
	}
}

func closeTo(t *testing.T, label string, got, want, tolerance float64) {
	t.Helper()
	if math.Abs(got-want) > tolerance {
		t.Errorf("%s = %.17g, want %.17g (tolerance %g)", label, got, want, tolerance)
	}
}

func series(t *testing.T, report AnalyzeReport, name string) RegionSeries {
	t.Helper()
	for _, found := range report.Regions {
		if found.Name == name {
			return found
		}
	}
	t.Fatalf("the report holds no region named %q", name)
	return RegionSeries{}
}

// changedAt returns one frame's change fraction, and fails when there is none.
func changedAt(t *testing.T, one RegionSeries, frame int) float64 {
	t.Helper()
	if one.Frames[frame].Changed == nil {
		t.Fatalf("region %q frame %d has no change fraction", one.Name, frame)
	}
	return *one.Frames[frame].Changed
}

func wholeRegion(name string) AnalyzeRegion {
	return AnalyzeRegion{Name: name, X: 0, Y: 0, Width: 1, Height: 1}
}

func leftHalf(name string) AnalyzeRegion {
	return AnalyzeRegion{Name: name, X: 0, Y: 0, Width: 0.5, Height: 1}
}

func rightHalf(name string) AnalyzeRegion {
	return AnalyzeRegion{Name: name, X: 0.5, Y: 0, Width: 0.5, Height: 1}
}

// TestAnalyzeFramesReportsLuminancePerRegionPerFrame pins the number a region
// answers with against fixtures whose luminance is arithmetic, not a reading.
func TestAnalyzeFramesReportsLuminancePerRegionPerFrame(t *testing.T) {
	dir := t.TempDir()
	writeFrame(t, dir, 0, bands(8, 8, 4, frameRed, frameGreen))
	writeFrame(t, dir, 1, bands(8, 8, 4, frameBlue, frameWhite))

	report, err := AnalyzeFrames(AnalyzeRequest{
		Dir:     dir,
		Regions: []AnalyzeRegion{leftHalf("left"), rightHalf("right")},
	})
	if err != nil {
		t.Fatalf("analyzing two frames: %v", err)
	}

	if report.Frames != 2 {
		t.Errorf("report.Frames = %d, want 2", report.Frames)
	}
	if report.Width != 8 || report.Height != 8 {
		t.Errorf("report frame size = %dx%d, want 8x8", report.Width, report.Height)
	}

	left := series(t, report, "left")
	right := series(t, report, "right")
	if left.Samples != 32 || right.Samples != 32 {
		t.Errorf("samples = %d and %d, want 32 each", left.Samples, right.Samples)
	}
	if left.Pixels != (RegionPixels{X: 0, Y: 0, Width: 4, Height: 8}) {
		t.Errorf("left pixels = %+v, want x0 y0 4x8", left.Pixels)
	}
	if right.Pixels != (RegionPixels{X: 4, Y: 0, Width: 4, Height: 8}) {
		t.Errorf("right pixels = %+v, want x4 y0 4x8", right.Pixels)
	}
	if len(left.Frames) != 2 || len(right.Frames) != 2 {
		t.Fatalf("frames per region = %d and %d, want 2 each", len(left.Frames), len(right.Frames))
	}
	if left.Frames[0].Frame != 0 || left.Frames[1].Frame != 1 {
		t.Errorf("frame numbers = %d, %d, want 0, 1", left.Frames[0].Frame, left.Frames[1].Frame)
	}

	closeTo(t, "left frame 0", left.Frames[0].Luminance, luminanceRed, 1e-12)
	closeTo(t, "left frame 1", left.Frames[1].Luminance, luminanceBlue, 1e-12)
	closeTo(t, "right frame 0", right.Frames[0].Luminance, luminanceGreen, 1e-12)
	closeTo(t, "right frame 1", right.Frames[1].Luminance, luminanceWhite, 1e-12)
}

// TestAnalyzeFramesFrameDiffSeparatesNoChangeFromNoPredecessor holds the two
// facts apart: frame zero answers with no fraction at all, and a still region
// answers with zero.
func TestAnalyzeFramesFrameDiffSeparatesNoChangeFromNoPredecessor(t *testing.T) {
	dir := t.TempDir()
	writeFrame(t, dir, 0, bands(8, 8, 8, frameBlack, frameBlack))
	writeFrame(t, dir, 1, bands(8, 8, 4, frameBlack, frameWhite))
	writeFrame(t, dir, 2, bands(8, 8, 4, frameBlack, frameWhite))

	report, err := AnalyzeFrames(AnalyzeRequest{
		Dir:     dir,
		Regions: []AnalyzeRegion{wholeRegion("whole"), leftHalf("left"), rightHalf("right")},
	})
	if err != nil {
		t.Fatalf("analyzing three frames: %v", err)
	}

	whole := series(t, report, "whole")
	left := series(t, report, "left")
	right := series(t, report, "right")

	for _, one := range []RegionSeries{whole, left, right} {
		if one.Frames[0].Changed != nil {
			t.Errorf("region %q frame 0 answered %g; frame zero has no predecessor",
				one.Name, *one.Frames[0].Changed)
		}
	}

	if whole.Samples != 64 {
		t.Errorf("whole samples = %d, want 64", whole.Samples)
	}
	closeTo(t, "whole frame 1 change", changedAt(t, whole, 1), 0.5, 1e-12)
	closeTo(t, "whole frame 2 change", changedAt(t, whole, 2), 0, 1e-12)
	closeTo(t, "left frame 1 change", changedAt(t, left, 1), 0, 1e-12)
	closeTo(t, "right frame 1 change", changedAt(t, right, 1), 1, 1e-12)
	closeTo(t, "right frame 2 change", changedAt(t, right, 2), 0, 1e-12)

	closeTo(t, "whole frame 1 luminance", whole.Frames[1].Luminance, luminanceWhite/2, 1e-12)
}

// TestAnalyzeFramesThresholdIsAnArgumentWithADefault covers all three cases: no
// threshold named, one named above the difference, and an explicit zero.
func TestAnalyzeFramesThresholdIsAnArgumentWithADefault(t *testing.T) {
	dir := t.TempDir()
	writeFrame(t, dir, 0, grey(8, 8, 100))
	writeFrame(t, dir, 1, grey(8, 8, 110))

	// 10 levels of 255 is 0.0392156862745098 of luminance.
	const step = 10.0 / 255.0

	byDefault, err := AnalyzeFrames(AnalyzeRequest{Dir: dir, Regions: []AnalyzeRegion{wholeRegion("whole")}})
	if err != nil {
		t.Fatalf("analyzing with the default threshold: %v", err)
	}
	if byDefault.Threshold != AnalyzeDefaultThreshold {
		t.Errorf("report.Threshold = %g, want the stated default %g",
			byDefault.Threshold, AnalyzeDefaultThreshold)
	}
	if AnalyzeDefaultThreshold >= step {
		t.Fatalf("the fixture no longer straddles the default threshold %g", AnalyzeDefaultThreshold)
	}
	closeTo(t, "default threshold change", changedAt(t, series(t, byDefault, "whole"), 1), 1, 1e-12)

	coarse := 0.05
	above, err := AnalyzeFrames(AnalyzeRequest{
		Dir:       dir,
		Regions:   []AnalyzeRegion{wholeRegion("whole")},
		Threshold: &coarse,
	})
	if err != nil {
		t.Fatalf("analyzing with a coarse threshold: %v", err)
	}
	if above.Threshold != coarse {
		t.Errorf("report.Threshold = %g, want %g", above.Threshold, coarse)
	}
	closeTo(t, "coarse threshold change", changedAt(t, series(t, above, "whole"), 1), 0, 1e-12)

	// An explicit zero is a request, not an unset field: one level of 255 is
	// under the default and over zero.
	fine := t.TempDir()
	writeFrame(t, fine, 0, grey(8, 8, 100))
	writeFrame(t, fine, 1, grey(8, 8, 101))

	any := 0.0
	exact, err := AnalyzeFrames(AnalyzeRequest{
		Dir:       fine,
		Regions:   []AnalyzeRegion{wholeRegion("whole")},
		Threshold: &any,
	})
	if err != nil {
		t.Fatalf("analyzing with a zero threshold: %v", err)
	}
	if exact.Threshold != 0 {
		t.Errorf("report.Threshold = %g, want the requested 0", exact.Threshold)
	}
	closeTo(t, "zero threshold change", changedAt(t, series(t, exact, "whole"), 1), 1, 1e-12)

	quiet, err := AnalyzeFrames(AnalyzeRequest{Dir: fine, Regions: []AnalyzeRegion{wholeRegion("whole")}})
	if err != nil {
		t.Fatalf("analyzing one level with the default threshold: %v", err)
	}
	closeTo(t, "one level under the default", changedAt(t, series(t, quiet, "whole"), 1), 0, 1e-12)
}

// TestAnalyzeFramesSamplesAnEvenGrid pins the sample count and proves the grid
// does not skew the mean: two bands of equal area answer with their average.
func TestAnalyzeFramesSamplesAnEvenGrid(t *testing.T) {
	dir := t.TempDir()
	writeFrame(t, dir, 0, bands(400, 400, 200, frameRed, frameGreen))

	report, err := AnalyzeFrames(AnalyzeRequest{Dir: dir, Regions: []AnalyzeRegion{wholeRegion("whole")}})
	if err != nil {
		t.Fatalf("analyzing a 400x400 frame: %v", err)
	}
	whole := series(t, report, "whole")

	// 160,000 pixels over a ceiling of 10,000 is a step of 4: 100 columns of
	// 100 rows, half of the columns in each band.
	if whole.Samples != AnalyzeMaxSamplesPerRegion {
		t.Errorf("samples = %d, want %d", whole.Samples, AnalyzeMaxSamplesPerRegion)
	}
	closeTo(t, "even bands", whole.Frames[0].Luminance, (luminanceRed+luminanceGreen)/2, 1e-9)
}

// TestAnalyzeFramesIsRepeatable holds the grid to no randomness: the same
// recording answers twice with the same numbers.
func TestAnalyzeFramesIsRepeatable(t *testing.T) {
	dir := t.TempDir()
	writeFrame(t, dir, 0, bands(37, 23, 11, frameRed, frameBlue))
	writeFrame(t, dir, 1, bands(37, 23, 19, frameGreen, frameWhite))

	request := AnalyzeRequest{
		Dir:     dir,
		Regions: []AnalyzeRegion{wholeRegion("whole"), rightHalf("right")},
	}
	first, err := AnalyzeFrames(request)
	if err != nil {
		t.Fatalf("first reading: %v", err)
	}
	second, err := AnalyzeFrames(request)
	if err != nil {
		t.Fatalf("second reading: %v", err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Errorf("two readings of one recording differ:\n%+v\n%+v", first, second)
	}
}

// TestAnalyzeFramesRefusesRatherThanGuesses covers every input that has no
// number, and each refusal names what was wrong.
func TestAnalyzeFramesRefusesRatherThanGuesses(t *testing.T) {
	sized := t.TempDir()
	writeFrame(t, sized, 0, bands(8, 8, 4, frameRed, frameGreen))
	writeFrame(t, sized, 1, bands(4, 4, 2, frameRed, frameGreen))

	broken := t.TempDir()
	writeFrame(t, broken, 0, bands(8, 8, 4, frameRed, frameGreen))
	if err := os.WriteFile(frameFile(broken, 1), []byte("this is not a PNG"), 0o644); err != nil {
		t.Fatalf("writing a corrupt frame: %v", err)
	}

	gapped := t.TempDir()
	writeFrame(t, gapped, 0, bands(8, 8, 4, frameRed, frameGreen))
	writeFrame(t, gapped, 2, bands(8, 8, 4, frameRed, frameGreen))

	good := t.TempDir()
	writeFrame(t, good, 0, bands(8, 8, 4, frameRed, frameGreen))

	tiny := t.TempDir()
	writeFrame(t, tiny, 0, bands(4, 4, 2, frameRed, frameGreen))

	high := 1.5
	low := -0.1

	cases := []struct {
		name    string
		request AnalyzeRequest
		names   []string
	}{
		{
			name:    "no directory",
			request: AnalyzeRequest{Regions: []AnalyzeRegion{wholeRegion("whole")}},
			names:   []string{"directory"},
		},
		{
			name:    "empty directory",
			request: AnalyzeRequest{Dir: t.TempDir(), Regions: []AnalyzeRegion{wholeRegion("whole")}},
			names:   []string{"f0000.png"},
		},
		{
			name: "directory that is not there",
			request: AnalyzeRequest{
				Dir:     filepath.Join(t.TempDir(), "never-recorded"),
				Regions: []AnalyzeRegion{wholeRegion("whole")},
			},
			names: []string{"never-recorded"},
		},
		{
			name:    "no region",
			request: AnalyzeRequest{Dir: good},
			names:   []string{"region"},
		},
		{
			name: "unnamed region",
			request: AnalyzeRequest{
				Dir:     good,
				Regions: []AnalyzeRegion{{X: 0, Y: 0, Width: 1, Height: 1}},
			},
			names: []string{"name"},
		},
		{
			name: "two regions of one name",
			request: AnalyzeRequest{
				Dir:     good,
				Regions: []AnalyzeRegion{wholeRegion("whole"), leftHalf("whole")},
			},
			names: []string{"whole"},
		},
		{
			name: "region past the right edge",
			request: AnalyzeRequest{
				Dir:     good,
				Regions: []AnalyzeRegion{{Name: "wide", X: 0.6, Y: 0, Width: 0.5, Height: 1}},
			},
			names: []string{"wide", "0..1"},
		},
		{
			name: "region with a negative origin",
			request: AnalyzeRequest{
				Dir:     good,
				Regions: []AnalyzeRegion{{Name: "before", X: -0.1, Y: 0, Width: 0.5, Height: 1}},
			},
			names: []string{"before", "0..1"},
		},
		{
			name: "region of no width",
			request: AnalyzeRequest{
				Dir:     good,
				Regions: []AnalyzeRegion{{Name: "flat", X: 0.2, Y: 0, Width: 0, Height: 1}},
			},
			names: []string{"flat", "0..1"},
		},
		{
			name: "region under one pixel",
			request: AnalyzeRequest{
				Dir:     tiny,
				Regions: []AnalyzeRegion{{Name: "hairline", X: 0.5, Y: 0.5, Width: 0.01, Height: 0.01}},
			},
			names: []string{"hairline", "4x4"},
		},
		{
			name:    "frames of two sizes",
			request: AnalyzeRequest{Dir: sized, Regions: []AnalyzeRegion{wholeRegion("whole")}},
			names:   []string{"frame 1", "4x4", "8x8"},
		},
		{
			name:    "a frame that is not a PNG",
			request: AnalyzeRequest{Dir: broken, Regions: []AnalyzeRegion{wholeRegion("whole")}},
			names:   []string{"f0001.png"},
		},
		{
			name:    "a missing frame",
			request: AnalyzeRequest{Dir: gapped, Regions: []AnalyzeRegion{wholeRegion("whole")}},
			names:   []string{"f0001.png"},
		},
		{
			name: "a threshold over one",
			request: AnalyzeRequest{
				Dir:       good,
				Regions:   []AnalyzeRegion{wholeRegion("whole")},
				Threshold: &high,
			},
			names: []string{"1.5", "0 through 1"},
		},
		{
			name: "a threshold under zero",
			request: AnalyzeRequest{
				Dir:       good,
				Regions:   []AnalyzeRegion{wholeRegion("whole")},
				Threshold: &low,
			},
			names: []string{"-0.1", "0 through 1"},
		},
	}

	for _, one := range cases {
		t.Run(one.name, func(t *testing.T) {
			_, err := AnalyzeFrames(one.request)
			if err == nil {
				t.Fatalf("%s was accepted; it has no number to answer with", one.name)
			}
			for _, word := range one.names {
				if !strings.Contains(err.Error(), word) {
					t.Errorf("the refusal %q does not name %q", err.Error(), word)
				}
			}
		})
	}
}
