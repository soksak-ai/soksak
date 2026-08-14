// Package wails is the only Go package that knows this framework exists.
//
// Everything above it — the command registry, the workspace rules, the plugins —
// receives what it needs through injected interfaces and never names a vendor.
// Move a rule in here and it stops being true for any other host.
package wails

import (
	"embed"
	"log"
	"time"
	"unsafe"

	nativebrowser "github.com/soksak/soksak-plugin-browser-native"
	terminal "github.com/soksak/soksak-plugin-terminal-xterm"
	compositor "github.com/soksak/wails-service-native-compositor"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// Options is everything the launcher knows and this package cannot derive.
//
// Assets arrives as a value because embed paths cannot climb out of the
// directory that declares them; the frontend build lives above this package.
type Options struct {
	Assets embed.FS
	// TraceTerminalInput mirrors raw terminal input to the log. The launcher
	// reads the environment; this package never does.
	TraceTerminalInput bool
	// CaptureProbe, when set, captures the window to this path shortly after
	// startup and exits. It is how the capture path is observed without a
	// working frontend.
	CaptureProbe string
}

const (
	appName        = "soksak-core"
	appDescription = "Plugin-driven recursive terminal and browser workspace"
	windowTitle    = appName
	// The window opens at the golden ratio (1000 / 618 ≈ 1.618).
	windowWidth  = 1000
	windowHeight = 618
)

// Run builds the application, registers the plugin services, opens the first
// window, and blocks until the application exits.
func Run(options Options) error {
	sink := &terminalEventSink{traceInput: options.TraceTerminalInput}

	// The window is captured by reference: the compositor needs a native handle,
	// and that handle does not exist until the window is created below.
	var window application.Window
	nativeWindow := func() unsafe.Pointer {
		if window == nil {
			return nil
		}
		return window.NativeWindow()
	}

	browserBackend := nativebrowser.NewBackend()

	app := application.New(application.Options{
		Name:        appName,
		Description: appDescription,
		Services: []application.Service{
			application.NewService(terminal.NewService(sink, terminal.DefaultOptions())),
			application.NewService(compositor.NewService(nativeWindow, browserBackend)),
			application.NewService(nativebrowser.NewService(browserBackend)),
			application.NewService(NewCaptureService(nativeWindow)),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(options.Assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})
	sink.app = app

	window = app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:  windowTitle,
		Width:  windowWidth,
		Height: windowHeight,
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 50,
			Backdrop:                application.MacBackdropTranslucent,
			TitleBar:                application.MacTitleBarHiddenInset,
		},
		BackgroundColour: application.NewRGB(6, 7, 15),
		URL:              "/",
	})

	// A capture probe runs after the window has had a chance to paint, then
	// exits. It does not depend on the frontend booting, so a capture defect and
	// a boot defect stay separable — otherwise a failed boot hides whether the
	// capture path works at all.
	if target := options.CaptureProbe; target != "" {
		capture := NewCaptureService(nativeWindow)
		go func() {
			time.Sleep(3 * time.Second)
			path, err := capture.Snapshot(target)
			if err != nil {
				log.Printf("capture-probe error %v", err)
			} else {
				log.Printf("capture-probe wrote %s", path)
			}
			app.Quit()
		}()
	}

	return app.Run()
}
