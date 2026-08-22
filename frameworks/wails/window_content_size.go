package wails

import "fmt"

func contentSizeFromClientRect(left, top, right, bottom int32, dpi uint32) (float64, float64, error) {
	width, height := right-left, bottom-top
	if width <= 0 || height <= 0 {
		return 0, 0, fmt.Errorf("window client rect has no area: %dx%d", width, height)
	}
	if dpi == 0 {
		return 0, 0, fmt.Errorf("window client rect has no DPI")
	}
	scale := 96 / float64(dpi)
	return float64(width) * scale, float64(height) * scale, nil
}
