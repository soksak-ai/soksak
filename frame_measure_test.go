package main

import (
	"image"
	"image/png"
	"os"
	"path/filepath"
	"sort"
)

// What a recorded frame holds, as a number.
//
// A recording is how a person judges whether a window looks right, and it can never be the pass
// mark — nobody can diff a video in a gate. What it can do is give a second measurement of the same
// claim, taken from pixels rather than from the document: the plane reports the panes 165 points to
// the right of where the region ends, and a frame either shows an empty band that wide or it does
// not.
//
// This reads the frames a gate recorded and answers the widest band of untouched window background
// at the left of the content area. Committed rather than written each time it is wanted, because the
// next reading of the next recording has to be the same reading.

// frameBand is the empty band found in one recorded frame.
type frameBand struct {
	file  string
	width int
	// The window's own width in pixels, so a band can be read as a share of the window rather than
	// as a number whose scale depends on the display.
	frameWidth int
}

// emptyBandsIn measures every frame in a directory, in file order — which is capture order.
//
// The band is measured across the middle of the frame, below the title bar and above the bottom:
// a row through the panes. A column counts as empty while it holds nothing but the flattest colour
// in that row, which is the window's ground; the band ends at the first column that holds anything
// else.
func emptyBandsIn(dir string) ([]frameBand, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) == ".png" {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)

	bands := make([]frameBand, 0, len(names))
	for _, name := range names {
		band, width, err := emptyBandOf(filepath.Join(dir, name))
		if err != nil {
			return nil, err
		}
		bands = append(bands, frameBand{file: name, width: band, frameWidth: width})
	}
	return bands, nil
}

// emptyBandOf is the width of the untouched band at the left of one frame, with the frame's width.
func emptyBandOf(path string) (int, int, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, 0, err
	}
	defer file.Close()
	frame, err := png.Decode(file)
	if err != nil {
		return 0, 0, err
	}
	bounds := frame.Bounds()
	// A row through the panes: below the title bar and the tab strip, above the bottom edge.
	row := bounds.Min.Y + bounds.Dy()/2
	ground := groundOf(frame, row)
	// The longest unbroken run of ground in the left half, wherever it starts. Measuring from the
	// window's own left edge answers zero on every frame: the first pixel is the window border, and
	// the band being looked for begins just inside it.
	widest, run := 0, 0
	for x := bounds.Min.X; x < bounds.Min.X+bounds.Dx()/2; x++ {
		if sameColour(frame, x, row, ground) {
			run++
			if run > widest {
				widest = run
			}
			continue
		}
		run = 0
	}
	return widest, bounds.Dx(), nil
}

// groundOf is the colour the row holds most of — the window's ground. Read from the frame rather
// than named here: a theme changes it, and a constant would answer for one theme forever.
func groundOf(frame image.Image, row int) [3]uint32 {
	bounds := frame.Bounds()
	counts := map[[3]uint32]int{}
	for x := bounds.Min.X; x < bounds.Max.X; x++ {
		counts[colourAt(frame, x, row)]++
	}
	var ground [3]uint32
	most := -1
	for colour, count := range counts {
		if count > most {
			ground, most = colour, count
		}
	}
	return ground
}

func colourAt(frame image.Image, x int, y int) [3]uint32 {
	r, g, b, _ := frame.At(x, y).RGBA()
	// Eight bits is what a screen recording holds; the low bits are encoder noise.
	return [3]uint32{r >> 8, g >> 8, b >> 8}
}

func sameColour(frame image.Image, x int, y int, ground [3]uint32) bool {
	return colourAt(frame, x, y) == ground
}

// widestBand is the widest empty band over a run of frames, and which frame held it.
func widestBand(bands []frameBand) frameBand {
	widest := frameBand{}
	for _, band := range bands {
		if band.width > widest.width {
			widest = band
		}
	}
	return widest
}

// pageTrail is the gap a recorded frame holds between a pane's left edge and the page drawn in it.
//
// Two clocks cannot be compared by asking each of them; one frame of the screen holds both at the
// same instant by construction. Inside a pane that holds a page, the pane's own ground runs from its
// left edge to where the page begins. At rest that run is the inset — a few points. While the page
// trails its pane, it is the trail, and it is what a person sees as the page coming away from its
// edge.
type pageTrail struct {
	file string
	// Width in device pixels of the pane ground immediately before the page.
	gap int
	// Where the page begins, so a frame with no page in that row is not read as a gap.
	pageAt int
}

// pageTrailsIn measures every frame in a directory along one row, given as a share of the height.
func pageTrailsIn(dir string, rowShare float64) ([]pageTrail, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) == ".png" {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)

	trails := make([]pageTrail, 0, len(names))
	for _, name := range names {
		gap, pageAt, err := pageTrailOf(filepath.Join(dir, name), rowShare)
		if err != nil {
			return nil, err
		}
		trails = append(trails, pageTrail{file: name, gap: gap, pageAt: pageAt})
	}
	return trails, nil
}

// pageTrailOf reads one frame: where the page begins along the row, and how much pane ground runs
// immediately before it.
func pageTrailOf(path string, rowShare float64) (int, int, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, 0, err
	}
	defer file.Close()
	frame, err := png.Decode(file)
	if err != nil {
		return 0, 0, err
	}
	bounds := frame.Bounds()
	row := bounds.Min.Y + int(float64(bounds.Dy())*rowShare)
	// The page is the light block in this row. Light and dark are read from the frame's own extremes
	// rather than named here, so a theme change does not silently make every frame answer zero.
	pageAt := -1
	run := 0
	for x := bounds.Min.X; x < bounds.Max.X; x++ {
		if luminance(frame, x, row) > 140 {
			run++
			if run >= 40 {
				pageAt = x - 39
				break
			}
			continue
		}
		run = 0
	}
	if pageAt < 0 {
		return 0, -1, nil
	}
	// The run of pane ground immediately before it.
	gap := 0
	for x := pageAt - 1; x >= bounds.Min.X; x-- {
		if luminance(frame, x, row) > 90 {
			break
		}
		gap++
	}
	return gap, pageAt, nil
}

func luminance(frame image.Image, x int, y int) int {
	colour := colourAt(frame, x, y)
	return int((colour[0]*30 + colour[1]*59 + colour[2]*11) / 100)
}

// widestTrail is the widest gap over a run of frames, and which frame held it.
func widestTrail(trails []pageTrail) pageTrail {
	widest := pageTrail{}
	for _, trail := range trails {
		if trail.pageAt >= 0 && trail.gap > widest.gap {
			widest = trail
		}
	}
	return widest
}
