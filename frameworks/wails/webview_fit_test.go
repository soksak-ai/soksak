package wails

import "testing"

// The document is as big as the view it renders into, and that view is the
// framework's to place. Measured 2026-08-15: a window whose content rect was
// 999x617 held a web view of 1000x618, so the document's last column and row
// were outside the window and nothing drawn there could be seen.
//
// The symptom is indistinguishable from a style that draws no border, which is
// how it survived an afternoon of looking at screenshots.
func TestTheWebviewIsNoBiggerThanItsWindow(t *testing.T) {
	host := startedHost(liveWindow(controlPlaneWindow))

	contentW, contentH, err := host.ContentSize(controlPlaneWindow)
	if err != nil {
		t.Fatalf("content size: %v", err)
	}
	x, y, viewW, viewH, err := host.WebviewRect(controlPlaneWindow)
	if err != nil {
		t.Fatalf("web view rect: %v", err)
	}

	if x != 0 || y != 0 {
		t.Errorf("the view sits at %g,%g; a document offset inside its window is cropped on two sides", x, y)
	}
	if viewW > contentW || viewH > contentH {
		t.Errorf("the view is %gx%g inside a content area of %gx%g — the overflow is invisible, not absent",
			viewW, viewH, contentW, contentH)
	}
}
