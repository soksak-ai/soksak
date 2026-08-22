package wails

import (
	"strconv"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

func contentSizeFromClientRect(left, top, right, bottom int32, dpi uint32) (float64, float64, error) {
	width, height := right-left, bottom-top
	if width <= 0 || height <= 0 {
		return 0, 0, i18n.Errorf("wails.window.invalidClientRect", map[string]string{"width": strconv.FormatInt(int64(width), 10), "height": strconv.FormatInt(int64(height), 10)})
	}
	if dpi == 0 {
		return 0, 0, i18n.Errorf("wails.window.noClientDPI", nil)
	}
	scale := 96 / float64(dpi)
	return float64(width) * scale, float64(height) * scale, nil
}
