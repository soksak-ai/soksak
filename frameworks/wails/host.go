// Package wails is the only Go package that names this framework.
//
// Everything above it — the command registry, the workspace rules, the plugins —
// receives what it needs through injected interfaces and never names a vendor.
// Move a rule in here and it stops being true for any other host.
package wails

import (
	"embed"
	"encoding/json"
	"log"
	"net/http"
	"time"
	"unsafe"

	nativebrowser "github.com/soksak/soksak-plugin-browser-native"
	terminal "github.com/soksak/soksak-plugin-terminal-xterm"
	terminalplugin "github.com/soksak/soksak-plugin-terminal-xterm"
	compositor "github.com/soksak/wails-service-native-compositor"

	"github.com/soksak/soksak-core/core/control"
	"github.com/soksak/soksak-core/core/i18n"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// Options is everything the launcher has and this package cannot derive.
//
// Assets arrives as a value because embed paths cannot climb out of the
// directory that declares them; the frontend build is above this package.
type Options struct {
	Assets embed.FS
	// CaptureProbe, when set, captures the window to this path shortly after
	// startup and exits. It is how the capture path is observed without a
	// working frontend.
	CaptureProbe string
	// Terminal is the session owner the launcher built. It is registered as a
	// framework service for its shutdown hook: the children have to be reaped
	// when the application quits, and only the application has that moment.
	Terminal *terminal.Service
	// Bridge is the launcher's late-bound half of the host: the core was handed
	// its Emit and Live before this framework existed, and Run fills it in.
	Bridge *Bridge
	// Registry answers every command this process serves. The host registers
	// its window-owning commands onto it; everything else was registered by the
	// launcher, which is what keeps those answerable with no window at all.
	Registry *control.Registry
	// UnitRoot is the directory holding installed units. The asset server reads
	// unit files out of it and refuses every path outside it. Empty means this
	// build serves no unit files, and the route states that rather than
	// answering 404.
	UnitRoot string
}

const (
	appName        = "soksak-core"
	appDescription = "Plugin-driven recursive terminal and browser workspace"
	windowTitle    = appName
	// The orchestrator window's reserved name. Workspaces are w-<uuid>.
	controlPlaneWindow = "main"
	// The window opens at the golden ratio (1000 / 618 ≈ 1.618).
	windowWidth  = 1000
	windowHeight = 618
)

// Run builds the application, registers the plugin services, opens the first
// window, and blocks until the application exits.
func Run(options Options) error {
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

	// The compositor service, held so the surface commands can read what it
	// applied. The service list below registers the same value.
	nativeCompositor := compositor.NewService(nativeWindow, browserBackend)

	app := application.New(application.Options{
		Name:        appName,
		Description: appDescription,
		Services: []application.Service{
			application.NewService(options.Terminal),
			application.NewService(nativeCompositor),
			application.NewService(nativebrowser.NewService(browserBackend)),
			application.NewService(NewCaptureService(nativeWindow)),
			application.NewService(NewControlService(options.Registry)),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(options.Assets),
			// Unit files are not in the embedded FS: they are installed under
			// the home after this binary was built. The middleware answers that
			// one route and hands everything else to the embedded handler.
			Middleware: func(next http.Handler) http.Handler {
				return UnitFiles(options.UnitRoot, next)
			},
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})
	// One window definition for the whole application. The control plane takes
	// it under its reserved name; every workspace window is the same window
	// under a generated one. Two definitions would let the second window differ
	// from the first in ways nobody chose.
	windowTemplate := newWindowTemplate()

	// Built before the run loop, because it subscribes to the event marking that
	// the run loop started. Created afterwards it would never hear it, and every
	// window command would refuse forever.
	windowHost := NewWindowHost(app, windowTemplate)

	// Filled here, before Run, so that the commands the core registered against
	// it start answering the moment the application exists rather than at the
	// first window.
	if options.Bridge != nil {
		options.Bridge.app = app
		options.Bridge.host = windowHost
	}

	// Every command this framework owns, in one call. Registered before any
	// window exists, and the renderer half is hooked to window creation before
	// the first one is made: a window created ahead of the hook would never
	// report that it closed, and its names would stay on the table pointing at
	// a page that is gone.
	renderer := RegisterHost(options.Registry, HostDeps{
		Host:         windowHost,
		NewID:        newWindowID,
		Sessions:     terminalplugin.CommandSessions(options.Terminal),
		Composition:  NewCompositorSource(nativeCompositor),
		NativeParent: func() bool { return nativeWindow() != nil },
		Dispatch: func(target, event string, payload any) error {
			return dispatchToWindow(app, target, event, payload)
		},
	})
	app.Event.On(rendererDeclareEvent, func(event *application.CustomEvent) {
		// Sender is stamped by the framework, never by the page. A page that
		// named itself could name another page and take over its commands.
		if err := renderer.DeclareFrom(event.Sender, event.Data); err != nil {
			log.Printf("renderer commands: %v", err)
		}
	})
	app.Event.On(rendererWithdrawEvent, func(event *application.CustomEvent) {
		if err := renderer.Withdraw(event.Sender); err != nil {
			log.Printf("renderer commands: %v", err)
		}
	})
	app.Window.OnCreate(func(created application.Window) {
		created.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) {
			if err := renderer.Withdraw(created.Name()); err != nil {
				log.Printf("renderer commands: %v", err)
			}
			// The window that owned these shells is going away, and nothing else
			// will ask about them: a session keyed to a closed window is a
			// process with no caller and no way to be reached again.
			if _, err := options.Registry.Invoke("close_window_terminals", control.Args{
				"windowLabel": jsonString(created.Name()),
			}); err != nil {
				log.Printf("closing the window's terminals: %v", err)
			}
		})
	})

	controlPlane := windowTemplate
	// The control plane's window is named by the product, not numbered by the
	// framework: the application branches on this name, and a generated
	// "window-1" would make that branch depend on creation order.
	controlPlane.Name = controlPlaneWindow
	controlPlane.URL = "/"
	window = app.Window.NewWithOptions(controlPlane)
	// The transparent backdrop cleared this window's colour on the way in. The
	// same restore wailsHost.Open performs, for the one window it does not open.
	window.SetBackgroundColour(controlPlane.BackgroundColour)
	// The same correction wailsHost.Open performs, for the one window it does
	// not open: the framework's content view is a point smaller than the window,
	// so the document ends up a point larger than what is visible.
	//
	// On this window's own readiness, not the application's. Measured
	// 2026-08-15: at ApplicationStarted this window still had no native
	// lifetime, so the correction was applied to nothing and the orchestrator
	// stayed a point too large while every workspace window fitted.
	window.OnWindowEvent(events.Common.WindowRuntimeReady, func(*application.WindowEvent) {
		if err := windowHost.FitWebview(controlPlaneWindow); err != nil {
			log.Printf("the orchestrator's view could not be fitted to its window: %v", err)
		}
	})

	// Window-owning commands join the same registry the core filled. One table,
	// two owners: the split is declared, not enforced by having two tables.
	// They are registered after the window exists, because they hold it.
	registerWindowCommands(options.Registry, app, window)

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

// dispatchToWindow hands one payload to one window's page.
//
// This framework's event emit goes to every window, so it cannot carry a
// request meant for one of them: the same command would run everywhere and only
// the first answer would be read. Dispatching to the window is the one channel
// that is delivered to a single page.
//
// A window with no native lifetime is refused rather than dispatched to,
// because the dispatch itself returns silently for exactly that window — and a
// request that was never delivered would then wait out its whole deadline.
func dispatchToWindow(app *application.App, target, event string, payload any) error {
	window, held := app.Window.GetByName(target)
	if !held {
		return i18n.Errorf("wails.dispatch.noSuchWindow", map[string]string{"window": target})
	}
	if window.NativeWindow() == nil {
		return i18n.Errorf("wails.dispatch.noNativeLifetime", map[string]string{"window": target})
	}
	window.DispatchWailsEvent(&application.CustomEvent{Name: event, Data: payload})
	return nil
}

// newWindowTemplate is the one window definition this application has.
//
// The webview is transparent, and that is load-bearing rather than decorative.
// The stylesheet paints chrome and leaves everything else to the layer beneath,
// which is how a native child webview can occupy a region of the document at
// all — an opaque webview has no holes to composite into. With a solid webview
// the canvas is the engine's own white, and it shows wherever nothing painted:
// measured 2026-08-15, a dark theme with a white pane body in every workspace
// window, in all five themes.
//
// Transparent is not translucent. Translucent shows the desktop through the
// window; this shows the window's own colour, which the theme owns.
func newWindowTemplate() application.WebviewWindowOptions {
	return application.WebviewWindowOptions{
		Title:  windowTitle,
		Width:  windowWidth,
		Height: windowHeight,
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 50,
			// Transparent, not Translucent. Translucent blurs the desktop into
			// the window; this only stops the webview drawing its own
			// background, and the window's colour — which the theme owns —
			// shows instead.
			//
			// This is the only knob that applies to the webview on this platform:
			// BackgroundType is read on linux and windows and not here, and
			// MacBackdropNormal leaves the webview opaque. It also clears the
			// window's colour, so the host repaints it as soon as the window
			// exists (see wailsHost.Open).
			Backdrop: application.MacBackdropTransparent,
			TitleBar: application.MacTitleBarHiddenInset,
		},
		// Read on linux and windows; darwin uses Mac.Backdrop above.
		BackgroundType: application.BackgroundTypeTransparent,
		// The colour before the theme arrives — one frame's worth, not a second
		// authority. Each window replaces it with its own theme through
		// window_set_background.
		BackgroundColour: application.NewRGB(6, 7, 15),
	}
}

// jsonString encodes one string argument for a registry call.
//
// The registry takes arguments still encoded, so a caller inside this process
// encodes them the same way the wire does. Marshalling a string cannot fail.
func jsonString(value string) json.RawMessage {
	encoded, _ := json.Marshal(value)
	return encoded
}
