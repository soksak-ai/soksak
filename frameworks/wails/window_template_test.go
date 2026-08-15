package wails

import (
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// The stylesheet this application inherited paints its chrome and leaves the
// rest to the layer beneath. That only works over a transparent webview: an
// opaque one has no holes, so a native child webview cannot occupy a region of
// the document, and every unpainted region shows the engine's own white.
//
// Measured 2026-08-15: a dark theme with a white pane body in every workspace
// window, in all five themes, because the webview was solid.
func TestTheWebviewIsTransparentSoTheWindowsColourShows(t *testing.T) {
	template := newWindowTemplate()

	// darwin reads Mac.Backdrop and ignores BackgroundType entirely; linux and
	// windows read BackgroundType. Both have to say the same thing or the same
	// build is transparent on one platform and white on another.
	if template.Mac.Backdrop != application.MacBackdropTransparent {
		t.Errorf("the macOS backdrop is %v; MacBackdropNormal leaves the webview drawing its own white",
			template.Mac.Backdrop)
	}
	if template.BackgroundType != application.BackgroundTypeTransparent {
		t.Errorf("the webview is %v on the platforms that read this field",
			template.BackgroundType)
	}
}

// Transparent is not translucent. Translucent shows the desktop through the
// window, and the desktop is not part of any theme.
func TestTheDesktopIsNotVisibleThroughTheWindow(t *testing.T) {
	template := newWindowTemplate()

	if template.BackgroundType == application.BackgroundTypeTranslucent {
		t.Error("the window is translucent, so the desktop shows through every unpainted region")
	}
	if template.Mac.Backdrop == application.MacBackdropTranslucent {
		t.Error("the backdrop is translucent, so the desktop shows behind the whole window")
	}
}

// A window with no colour at all is the engine's default until the theme
// arrives, and that default is not this application's.
func TestTheWindowHasAColourBeforeTheThemeArrives(t *testing.T) {
	template := newWindowTemplate()

	if template.BackgroundColour == (application.RGBA{}) {
		t.Error("the window opens with no colour, so the first frames are the engine's choice")
	}
}
