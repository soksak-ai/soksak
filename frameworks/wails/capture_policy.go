package wails

type capturePixelSource string

const (
	capturePixelSourceWindow   capturePixelSource = "native-window"
	capturePixelSourceDocument capturePixelSource = "webview-document"
)

// capturePixelSourceFor selects the pixel owner from native presentation facts. A materialized
// zero-alpha window intentionally contributes no final native pixels; its WebView document is the
// capture-owned source. Every ordinary window is read as the final native layer.
func capturePixelSourceFor(presence WindowPresence) capturePixelSource {
	if presence.Known && presence.Visible && presence.Alpha == 0 {
		return capturePixelSourceDocument
	}
	return capturePixelSourceWindow
}
