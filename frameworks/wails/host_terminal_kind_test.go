package wails

import (
	"testing"

	compositor "github.com/min-median-max/wails-service-native-compositor"
	terminalsurface "github.com/min-median-max/wails-service-terminal-surface"
	webviewsurface "github.com/min-median-max/wails-service-webview-surface"
)

// One backend per surface kind, and this map is the only place a kind is wired. A kind missing
// here is a declaration the compositor silently drops; nothing else in the host would notice.
func TestHostWiresTerminalKind(t *testing.T) {
	backends := surfaceBackends(webviewsurface.NewBackend(), terminalsurface.NewBackend())
	for _, kind := range []compositor.SurfaceKind{webviewsurface.SurfaceKind, terminalsurface.SurfaceKind} {
		if backends[kind] == nil {
			t.Errorf("the host wires no backend for surface kind %q", kind)
		}
	}
}
