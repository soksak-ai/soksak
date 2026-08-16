package wails

import (
	"fmt"
	"image"
	"image/png"
	"math"
	"os"
	"regexp"
	"sort"
	"strconv"

	"github.com/soksak/soksak-core/core/control"
)

// Numbers read back off a recording.
//
// docs/manual/EVIDENCE.md E1: a number settles a visual claim and a picture does
// not. E2: where no command produces the number, the number is written — a
// visual axis with no numeric judge is unfinished work.
//
// This host could write a burst of frames and measure one region at one moment,
// and nothing read numbers back off the burst. So every claim about motion,
// about a transition, or about anything changing over time was settled by
// looking at the images (measured 2026-08-16: no command in this build named
// luminance or change over a sequence).
//
// Two numbers per region per frame answer that. Mean luminance is what the
// region shows; the fraction of pixels changed since the previous frame is what
// moved. Neither is derivable from the other — a fade and a cut can pass
// through the same mean, and a region can change everywhere while its mean
// stands still.

// AnalyzeDefaultThreshold is the luminance difference below which two frames
// are the same.
//
// One percent of the full range. The 8-bit quantisation step is 1/255, about
// 0.4%, so a difference of a single level is the encoding's own floor rather
// than something on screen; one percent clears it with room and still catches
// every difference a person would call a change.
const AnalyzeDefaultThreshold = 0.01

// AnalyzeMaxSamplesPerRegion caps the reading of one region in one frame.
//
// Reading every pixel of 600 frames is merely slow, and the mean stops moving
// long before that. The grid is even and fixed, never random: the same
// recording has to answer twice with the same numbers.
const AnalyzeMaxSamplesPerRegion = 10_000

// AnalyzeRegion is a part of the frame, in fractions of it.
//
// Fractional rather than in pixels, so a region survives a different window
// size: "the right half" is the right half whether the frame is 800 or 1600
// wide. A region in pixels would have to be restated for every recording, and a
// restatement that was forgotten reads as a measurement of somewhere else.
type AnalyzeRegion struct {
	Name   string  `json:"name"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// RegionPixels is where a region landed in the frame, in pixels.
//
// Answered rather than left to the caller to recompute: a reader that derived
// it from the fractions and a rounding rule of its own would be describing a
// different rectangle from the one the numbers came from.
type RegionPixels struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

// FrameReading is one region in one frame.
type FrameReading struct {
	// Frame is the number the recorder wrote the file under, and the number the
	// caller's frame receiver already has (EVIDENCE E5). One clock.
	Frame int `json:"frame"`
	// Luminance is the mean over the sampled pixels, on displayed values with
	// no gamma decode.
	Luminance float64 `json:"luminance"`
	// Changed is the fraction of sampled pixels that differ from the previous
	// frame by more than the threshold.
	//
	// Absent on frame zero, and absent is not zero: "nothing changed" and
	// "there was nothing to compare against" are different facts, and a zero in
	// both places makes the first frame of every recording read as still.
	Changed *float64 `json:"changed,omitempty"`
}

// RegionSeries is one region across the whole recording.
type RegionSeries struct {
	Name string `json:"name"`
	// Pixels is the rectangle these numbers were read from.
	Pixels RegionPixels `json:"pixels"`
	// Samples is how many pixels each reading rests on. Stated, because a mean
	// over nine pixels and a mean over ten thousand are not equally worth
	// acting on and nothing else in the answer separates them.
	Samples int            `json:"samples"`
	Frames  []FrameReading `json:"frames"`
}

// AnalyzeRequest is one reading of one recording.
type AnalyzeRequest struct {
	// Dir holds the frames, named as the recorder wrote them.
	Dir string
	// Regions are the parts of the frame to read. Each has its own name, so the
	// answer is read by name rather than by position in a list.
	Regions []AnalyzeRegion
	// Threshold overrides AnalyzeDefaultThreshold. A pointer, because zero is a
	// request — every difference counts — and not an unset field.
	Threshold *float64
}

// AnalyzeReport is what a recording answers.
type AnalyzeReport struct {
	Dir    string `json:"dir"`
	Frames int    `json:"frames"`
	// Width and Height are the frame size every reading was taken at. A
	// recording whose frames are not one size is refused rather than reported,
	// so this is one number and not a range.
	Width  int `json:"width"`
	Height int `json:"height"`
	// Threshold is the value actually used, whether the caller named it or not.
	// Without it a reader cannot tell a still recording from a coarse reading.
	Threshold float64        `json:"threshold"`
	Regions   []RegionSeries `json:"regions"`
}

// frameFileName matches exactly what the recorder writes, so a stray file in
// the directory is not read as a frame.
var frameFileName = regexp.MustCompile(`^f(\d{4})\.png$`)

// AnalyzeFrames reads luminance and change out of a recorded burst.
//
// It refuses rather than guesses. Every input below has no number to answer
// with, and a number returned anyway would be acted on: a region outside the
// frame, a region that rounds to nothing, frames of two sizes, a gap in the
// sequence, a file that is not an image.
func AnalyzeFrames(request AnalyzeRequest) (AnalyzeReport, error) {
	threshold, err := analyzeThreshold(request.Threshold)
	if err != nil {
		return AnalyzeReport{}, err
	}
	if err := checkRegions(request.Regions); err != nil {
		return AnalyzeReport{}, err
	}
	frames, err := frameSequence(request.Dir)
	if err != nil {
		return AnalyzeReport{}, err
	}

	first, err := readFrame(request.Dir, frames[0])
	if err != nil {
		return AnalyzeReport{}, err
	}
	width, height := first.Bounds().Dx(), first.Bounds().Dy()

	series := make([]RegionSeries, 0, len(request.Regions))
	for _, region := range request.Regions {
		pixels, err := regionPixels(region, width, height)
		if err != nil {
			return AnalyzeReport{}, err
		}
		series = append(series, RegionSeries{
			Name:    region.Name,
			Pixels:  pixels,
			Samples: sampleCount(pixels),
			Frames:  make([]FrameReading, 0, len(frames)),
		})
	}

	// One frame's samples per region, kept to compare the next frame against.
	// Read from the images rather than from the means: a region can change
	// everywhere and hold its mean exactly, and a comparison of means would
	// report that as still.
	previous := make([][]float64, len(series))

	for index, number := range frames {
		frame := first
		if index > 0 {
			frame, err = readFrame(request.Dir, number)
			if err != nil {
				return AnalyzeReport{}, err
			}
			if frame.Bounds().Dx() != width || frame.Bounds().Dy() != height {
				return AnalyzeReport{}, fmt.Errorf(
					"frame %d is %dx%d and frame %d is %dx%d; one recording is one size, and a region is a different rectangle in each",
					number, frame.Bounds().Dx(), frame.Bounds().Dy(), frames[0], width, height)
			}
		}

		for at := range series {
			samples := sampleLuminance(frame, series[at].Pixels)
			reading := FrameReading{Frame: number, Luminance: mean(samples)}
			if previous[at] != nil {
				changed := changedFraction(previous[at], samples, threshold)
				reading.Changed = &changed
			}
			previous[at] = samples
			series[at].Frames = append(series[at].Frames, reading)
		}
	}

	return AnalyzeReport{
		Dir:       request.Dir,
		Frames:    len(frames),
		Width:     width,
		Height:    height,
		Threshold: threshold,
		Regions:   series,
	}, nil
}

// analyzeThreshold answers the value to use, or names why the given one is not
// a fraction of the range.
func analyzeThreshold(given *float64) (float64, error) {
	if given == nil {
		return AnalyzeDefaultThreshold, nil
	}
	if *given < 0 || *given > 1 || math.IsNaN(*given) {
		return 0, fmt.Errorf(
			"a change threshold is a luminance difference from 0 through 1; %g is outside that",
			*given)
	}
	return *given, nil
}

// checkRegions refuses a set of regions no reading can be taken from.
//
// The fractional bounds are checked here, before any frame is opened, because
// they are wrong at any frame size. Whether a region rounds to at least one
// pixel is a question about a particular frame and is asked once the size is
// known.
func checkRegions(regions []AnalyzeRegion) error {
	if len(regions) == 0 {
		return fmt.Errorf("a reading needs at least one region to read")
	}
	seen := make(map[string]struct{}, len(regions))
	for _, region := range regions {
		if region.Name == "" {
			return fmt.Errorf("a region has no name; the answer is read by name, not by position")
		}
		if _, duplicate := seen[region.Name]; duplicate {
			return fmt.Errorf("two regions are named %q; one name answers with one series", region.Name)
		}
		seen[region.Name] = struct{}{}

		if region.Width <= 0 || region.Height <= 0 ||
			region.X < 0 || region.Y < 0 ||
			region.X+region.Width > 1 || region.Y+region.Height > 1 {
			return fmt.Errorf(
				"region %q is x%g y%g %gx%g; a region is a fraction of the frame inside 0..1",
				region.Name, region.X, region.Y, region.Width, region.Height)
		}
	}
	return nil
}

// frameSequence answers the frame numbers in the directory, in order.
//
// A gap is refused. The frames are a sequence in time, and reading past a
// missing one would put two moments next to each other that were not adjacent —
// so every change fraction after the gap would be measured across it.
func frameSequence(dir string) ([]int, error) {
	if dir == "" {
		return nil, fmt.Errorf("a reading needs the directory the frames were recorded into")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		// An unreadable directory and an empty one are the same absence of
		// frames to a caller, and both are named the same way: what was looked
		// for, and where.
		return nil, fmt.Errorf("no recording in %s: %s could not be read (%v)", dir, frameFile(dir, 0), err)
	}

	held := map[int]struct{}{}
	highest := -1
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		match := frameFileName.FindStringSubmatch(entry.Name())
		if match == nil {
			continue
		}
		number, err := strconv.Atoi(match[1])
		if err != nil {
			continue
		}
		held[number] = struct{}{}
		if number > highest {
			highest = number
		}
	}
	if highest < 0 {
		return nil, fmt.Errorf("no recording in %s: %s is not there", dir, frameFile(dir, 0))
	}

	frames := make([]int, 0, highest+1)
	for number := 0; number <= highest; number++ {
		if _, present := held[number]; !present {
			return nil, fmt.Errorf(
				"%s is missing and %s is not; a gap makes two frames adjacent that were not",
				frameFile(dir, number), frameFile(dir, highest))
		}
		frames = append(frames, number)
	}
	sort.Ints(frames)
	return frames, nil
}

// readFrame decodes one frame, or names the file that could not be read.
func readFrame(dir string, number int) (image.Image, error) {
	path := frameFile(dir, number)
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("frame %s could not be opened: %w", path, err)
	}
	defer file.Close()
	decoded, err := png.Decode(file)
	if err != nil {
		return nil, fmt.Errorf("frame %s is not a readable PNG: %w", path, err)
	}
	return decoded, nil
}

// regionPixels turns a fraction of the frame into the rectangle read from it.
//
// A region that rounds to nothing is refused rather than widened to one pixel:
// a caller who asked for a hairline and received a pixel would be told a number
// about somewhere slightly else, and would have no way to know.
func regionPixels(region AnalyzeRegion, width, height int) (RegionPixels, error) {
	left := int(math.Round(region.X * float64(width)))
	top := int(math.Round(region.Y * float64(height)))
	right := int(math.Round((region.X + region.Width) * float64(width)))
	bottom := int(math.Round((region.Y + region.Height) * float64(height)))

	pixels := RegionPixels{X: left, Y: top, Width: right - left, Height: bottom - top}
	if pixels.Width < 1 || pixels.Height < 1 {
		return RegionPixels{}, fmt.Errorf(
			"region %q is %dx%d pixels in a %dx%d frame; there is nothing there to read",
			region.Name, pixels.Width, pixels.Height, width, height)
	}
	return pixels, nil
}

// sampleStep is the distance between read pixels, on both axes.
//
// One step for both, so the grid is square and neither axis is favoured. Even
// and fixed, never random — the same recording answers twice with the same
// numbers, which is what makes two readings comparable at all.
func sampleStep(pixels RegionPixels) int {
	area := float64(pixels.Width) * float64(pixels.Height)
	step := int(math.Ceil(math.Sqrt(area / float64(AnalyzeMaxSamplesPerRegion))))
	if step < 1 {
		return 1
	}
	return step
}

func sampleCount(pixels RegionPixels) int {
	step := sampleStep(pixels)
	columns := (pixels.Width + step - 1) / step
	rows := (pixels.Height + step - 1) / step
	return columns * rows
}

// sampleLuminance reads one region of one frame on the even grid.
//
// Luminance is on displayed values with no gamma decode: the question is how
// bright this looks, and a veil of alpha a multiplies the displayed value by
// (1 - a), which reads exactly on this axis. The renderer's pixelStats
// (frontend/src/commands/catalogCapture.ts) uses these same coefficients — two
// spellings of one formula would let the same screen answer two numbers.
func sampleLuminance(frame image.Image, pixels RegionPixels) []float64 {
	step := sampleStep(pixels)
	origin := frame.Bounds().Min
	samples := make([]float64, 0, sampleCount(pixels))
	for y := 0; y < pixels.Height; y += step {
		for x := 0; x < pixels.Width; x += step {
			r, g, b, _ := frame.At(origin.X+pixels.X+x, origin.Y+pixels.Y+y).RGBA()
			// RGBA answers 16-bit alpha-premultiplied values; the top byte of
			// each is the displayed 8-bit channel.
			red := float64(r >> 8)
			green := float64(g >> 8)
			blue := float64(b >> 8)
			samples = append(samples, (0.2126*red+0.7152*green+0.0722*blue)/255)
		}
	}
	return samples
}

func mean(samples []float64) float64 {
	if len(samples) == 0 {
		return 0
	}
	total := 0.0
	for _, one := range samples {
		total += one
	}
	return total / float64(len(samples))
}

// changedFraction is how much of the region is not what it was.
//
// Per sampled pixel rather than on the means, and strictly greater than the
// threshold so that a threshold of zero means "any difference at all" rather
// than "every pixel".
func changedFraction(before, after []float64, threshold float64) float64 {
	if len(before) == 0 || len(before) != len(after) {
		return 0
	}
	changed := 0
	for index := range after {
		if math.Abs(after[index]-before[index]) > threshold {
			changed++
		}
	}
	return float64(changed) / float64(len(after))
}

// RegisterAnalyze puts the recording readings on the registry.
//
// Owned by the core rather than the framework: reading numbers out of PNG files
// in a directory needs no window and no platform, and a command that refused
// with "there is no window" for a recording already on disk would be refusing
// the one reading that outlives the session it was taken in.
func RegisterAnalyze(registry *control.Registry) {
	registry.MustRegister(control.Command{
		Name:  "capture_analyze",
		Owner: control.OwnerCore,
		Handler: func(args control.Args) (any, error) {
			dir, err := control.Arg[string](args, "dir")
			if err != nil {
				return nil, err
			}
			regions, err := control.Arg[[]AnalyzeRegion](args, "regions")
			if err != nil {
				return nil, err
			}
			request := AnalyzeRequest{Dir: dir, Regions: regions}
			// Absent and zero are different requests: zero counts every
			// difference, and defaulting it would answer a reading nobody asked
			// for. The argument is read only when the caller sent one.
			if _, sent := args["threshold"]; sent {
				threshold, err := control.Arg[float64](args, "threshold")
				if err != nil {
					return nil, err
				}
				request.Threshold = &threshold
			}
			return AnalyzeFrames(request)
		},
	})
}
