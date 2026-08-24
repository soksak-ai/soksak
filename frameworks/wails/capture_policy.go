package wails

type capturePixelSource string

const (
	capturePixelSourceWindow   capturePixelSource = "native-window"
	capturePixelSourceDocument capturePixelSource = "webview-document"
)

// capturePixelSourceFor selects the pixel owner from native presentation facts. The initial rule
// deliberately preserves the current behavior so the zero-alpha acceptance test begins RED.
func capturePixelSourceFor(WindowPresence) capturePixelSource {
	return capturePixelSourceWindow
}
