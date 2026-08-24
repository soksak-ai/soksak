package wails

import "testing"

func TestZeroAlphaMaterializedWindowUsesItsDocumentPixelSource(t *testing.T) {
	presence := WindowPresence{Known: true, Visible: true, Alpha: 0}
	if source := capturePixelSourceFor(presence); source != capturePixelSourceDocument {
		t.Fatalf("zero-alpha materialized window selected %s", source)
	}
}

func TestOrdinaryWindowUsesItsFinalNativeLayer(t *testing.T) {
	presence := WindowPresence{Known: true, Visible: true, Alpha: 1}
	if source := capturePixelSourceFor(presence); source != capturePixelSourceWindow {
		t.Fatalf("ordinary window selected %s", source)
	}
}
