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

	compositor "github.com/min-median-max/wails-service-native-compositor"
	terminalsurface "github.com/min-median-max/wails-service-terminal-surface"
	webviewsurface "github.com/min-median-max/wails-service-webview-surface"

	"github.com/soksak-ai/soksak-core/core/control"
	"github.com/soksak-ai/soksak-core/core/i18n"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// Options is everything the launcher has and this package cannot derive.
//
// Assets arrives as a value because embed paths cannot climb out of the
// directory that declares them; the frontend build is above this package.
type Options struct {
	Assets embed.FS
	// Identity scopes synchronous document caches before the command bridge is available.
	Identity string
	// CaptureProbe, when set, captures the window to this path shortly after
	// startup and exits. It is how the capture path is observed without a
	// working frontend.
	CaptureProbe string
	// Reapers are what this host has to end when the application quits. A unit holding children
	// outlives a window on purpose, and the moment the application goes is the only one that can
	// say so — it is the host's moment and nothing else has it.
	//
	// They arrive as an anonymous list. A field typed by a unit's package would put that unit's name
	// in this host's shape, which is the coupling C1a refuses and which this field held until
	// 2026-08-20.
	Reapers []UnitReaper
	// Bridge is the launcher's late-bound half of the host: the core was handed
	// its Emit and Live before this framework existed, and Run fills it in.
	Bridge *Bridge
	// Registry answers every command this process serves. The host registers
	// its window-owning commands onto it; everything else was registered by the
	// launcher, which is what keeps those answerable with no window at all.
	Registry *control.Registry
	// HostReady runs after every host-owned command is registered and before
	// the first renderer is created. Nil publishes no process event.
	HostReady func()
	// Release gives up the process claim before a framework quit path can bypass Run's return.
	Release func() error
	// Presentation declares whether this process is shown on the user's desktop.
	//
	// An unattended one is a measurement run: it opens windows, drives them and quits, and nobody is
	// looking at any of it. Coming to the front there interrupts whoever is actually at the machine.
	//
	// The application cannot work this out — a window is a window, and an identifier is a name. It is
	// a fact about the launch, so the launch declares it, the same way it declares the home.
	Presentation     PresentationMode
	PluginAssetRoots func() ([]string, error)
}

// macActivation is how this launch presents itself to the desktop.
//
// Regular is an application a person opened: it activates, takes the front and holds a dock icon.
// Accessory keeps the capture-only process out of the Dock and activation order. Its window
// template also stays hidden; activation policy and presentation are separate platform facts.
//
// Nothing else on this axis fits: Prohibited refuses to show a window at all, and the gates measure
// windows.
func macActivation(presentation PresentationMode) application.ActivationPolicy {
	if presentation == PresentationInteractive {
		return application.ActivationPolicyRegular
	}
	return application.ActivationPolicyAccessory
}

// hostServices is every value this host registers with the framework, in one place a reader and a
// test can both get at.
//
// The list was written inline in the options literal, where nothing outside the call could read it.
// A service reports its own name and the framework registers whatever it reports, so what ends up
// on the host's service list is only visible from the list itself — and a name that arrives there
// from a unit's source is invisible to a scan of this repository (measured 2026-08-20: a service
// named after a plugin id sat here while the scan for that string stayed green).
//
// The capture service is included for a reason of its own: it finishes an image with content that
// draws outside this process, and without it a pane holding a page is a flat rectangle in every
// screenshot while the page behind it loads correctly. It is bound to the control plane's window by
// name because a bound service has no caller to ask; every other capture arrives through the command
// path, which names the window it is a capture of.
func hostServices(
	reapers *reaperService,
	nativeCompositor *compositor.Service,
	webviewSurface *webviewsurface.Service,
	capture *CaptureService,
	control *ControlService,
) []application.Service {
	return []application.Service{
		application.NewService(reapers),
		application.NewService(nativeCompositor),
		application.NewService(webviewSurface),
		application.NewService(capture),
		application.NewService(control),
	}
}

// UnitReaper is something this host ends when the application quits. The name is all the host needs:
// what it holds and why is the unit's own business.
type UnitReaper interface {
	ServiceShutdown() error
}

type reaperService struct {
	name    string
	reapers []UnitReaper
}

// The name is this host's, not the owner's.
//
// It read `service.owner.ServiceName()` until 2026-08-20, which let a unit decide what appears on
// the host's service list. This service exists for one thing the host has and the owner does not —
// the moment the application quits — so the name is that, and a nil owner is a wiring fault rather than
// a name nobody can read.
func (service *reaperService) ServiceName() string { return service.name }

// ServiceShutdown ends every one, and answers with the first refusal rather than the last.
//
// Every one, not up to the first failure: a reaper that refused would otherwise leave the ones after
// it holding children nobody ends, and the process exits with them still running.
func (service *reaperService) ServiceShutdown() error {
	var first error
	for _, reaper := range service.reapers {
		if err := reaper.ServiceShutdown(); err != nil && first == nil {
			first = err
		}
	}
	return first
}

const (
	appName        = "soksak-core"
	appDescription = "Plugin-driven recursive terminal and browser workspace"
	windowTitle    = appName
	// The orchestrator window's reserved name. Workspaces are w-<uuid>.
	controlPlaneWindow = control.ControlPlaneWindow
	// The window opens at the golden ratio (1000 / 618 ≈ 1.618).
	windowWidth  = 1000
	windowHeight = 618
)

// Run builds the application, registers the plugin services, opens the first
// window, and blocks until the application exits.
func Run(options Options) error {
	if options.Presentation != PresentationInteractive && options.Presentation != PresentationCaptureOnly {
		return i18n.Errorf("wails.presentation.invalid", map[string]string{
			"mode": string(options.Presentation),
		})
	}
	if options.Identity == "" {
		return i18n.Errorf("wails.identity.missing", nil)
	}
	// The window host is captured by reference: the compositor resolves a window
	// by name, and no window — not even the host that holds them — exists until
	// the application is built below.
	//
	// By name, never by "the window this host happens to hold". Measured
	// 2026-08-16: one captured handle answered every commit, so a workspace
	// window's browser was created inside the orchestrator — a 1128×718 surface
	// inside a 999×617 window — and the pane the person was looking at stayed
	// empty while every reading reported the surface applied with zero drift.
	var window application.Window
	var windowHost *wailsHost
	nativeWindow := func(name string) unsafe.Pointer {
		if windowHost == nil {
			return nil
		}
		return windowHost.NativeHandle(name)
	}

	webviewBackend := webviewsurface.NewBackend()
	// What a surface's page does becomes the events the page already listens for. Without this the
	// address a person sees never moves off the one the pane was declared with, and the back button
	// is enabled by nothing.
	webviewsurface.PublishPagesTo(options.Bridge.Emit)

	// The compositor service, held so the surface commands can read what it
	// applied. The service list below registers the same value.
	nativeCompositor := compositor.NewService(nativeWindow, surfaceBackends(webviewBackend))
	// One reader of the last commit, shared by the surface commands and the capture. Two would
	// answer from two moments, and the capture would draw a page at a rectangle the numbers say it
	// is not at.
	// Which surface a point landed on. The plugin sees the click and holds the window handles; the
	// compositor holds every applied rectangle in the contract they are declared in. Neither answers
	// alone, and a plugin deciding it would re-derive the rectangles in its own coordinate space.
	webviewsurface.ReadSurfacesWith(nativeCompositor.SurfaceAt)

	surfaceComposition := NewCompositorSource(nativeCompositor)

	app := application.New(application.Options{
		Name:        appName,
		Description: appDescription,
		Services: hostServices(
			&reaperService{name: "session-reaper", reapers: options.Reapers},
			nativeCompositor,
			webviewsurface.NewService(webviewBackend),
			NewCaptureService(controlPlaneWindow, func() unsafe.Pointer {
				return nativeWindow(controlPlaneWindow)
			}, options.Presentation),
			NewControlService(options.Registry),
		),
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(options.Assets),
			// Unit files are not in the embedded FS: they are installed under
			// the home after this binary was built. The middleware answers that
			// one route and hands everything else to the embedded handler.
			Middleware: func(next http.Handler) http.Handler {
				return PluginFiles(options.PluginAssetRoots, next)
			},
		},
		Mac: application.MacOptions{
			ActivationPolicy: macActivation(options.Presentation),
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})
	// One window definition for the whole application. The control plane takes
	// it under its reserved name; every workspace window is the same window
	// under a generated one. Two definitions would let the second window differ
	// from the first in ways nobody chose.
	windowTemplate := newWindowTemplate(options.Presentation)

	// Built before the run loop, because it subscribes to the event marking that
	// the run loop started. Created afterwards it would never hear it, and every
	// window command would refuse forever.
	windowHost = NewWindowHost(app, windowTemplate, options.Presentation, options.Identity)

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
		Presentation: options.Presentation,
		NewID:        newWindowID,
		Composition:  surfaceComposition,
		Frames: func(stream string, frame any) {
			options.Bridge.Emit(control.StreamEvent, control.StreamFrame{Stream: stream, Frame: frame})
		},
		NativeParent: func(name string) bool { return nativeWindow(name) != nil },
		// Quitting is two calls: reap and answer, then quit once the answer has
		// been delivered. Both halves were declared unserved with the reason
		// "this build quits without a prepare phase", which was false — the two
		// services below have drained and reaped on shutdown all along. The phase
		// existed and had no command, so the only way to quit was to kill the
		// process, and killing it skips the drain the phase exists for.
		Reaper: hostReaper{
			// Shells are a unit's now, and a unit is ended by the reaper service rather than counted
			// here. The two numbers this answered were how many were reaped in this process and how
			// many were handed to a daemon, and neither is this process's to know any more: the
			// shells were never in it, and what a unit holds is the unit's business.
			shells:        func() (int, int) { return 0, 0 },
			surfaces:      nativeCompositor.Drain,
			inputMonitors: windowHost.DrainInputMonitor,
		},
		Release: options.Release,
		Quit:    app.Quit,
		Dispatch: func(target, event string, payload any) error {
			return dispatchToWindow(app, target, event, payload)
		},
	})
	if options.HostReady != nil {
		options.HostReady()
	}
	bootstrap := newControlPlaneBootstrap()
	closeBootstrap := func() {
		application.InvokeAsync(func() {
			if controlPlane, held := app.Window.GetByName(controlPlaneWindow); held {
				controlPlane.Close()
			}
		})
	}
	options.Registry.MustRegister(control.Command{
		Name:  "control_plane_bootstrap_complete",
		Owner: control.OwnerFramework,
		Handler: func(control.Args) (any, error) {
			closing := bootstrap.restoreCompleted()
			if closing {
				closeBootstrap()
			}
			return map[string]any{"closing": closing, "status": bootstrap.status()}, nil
		},
	})
	options.Registry.MustRegister(control.Command{
		Name:    "control_plane_bootstrap_status",
		Owner:   control.OwnerFramework,
		Handler: func(control.Args) (any, error) { return bootstrap.status(), nil },
	})

	app.Event.On(rendererDeclareEvent, func(event *application.CustomEvent) {
		// Sender is stamped by the framework, never by the page. A page that
		// named itself could name another page and take over its commands.
		if err := renderer.DeclareFrom(event.Sender, event.Data); err != nil {
			log.Printf("renderer commands: %v", err)
			return
		}
		if event.Sender != controlPlaneWindow && bootstrap.workspaceDeclared() {
			closeBootstrap()
		}
	})
	app.Event.On(rendererWithdrawEvent, func(event *application.CustomEvent) {
		if err := renderer.Withdraw(event.Sender); err != nil {
			log.Printf("renderer commands: %v", err)
		}
	})
	app.Window.OnCreate(func(created application.Window) {
		created.RegisterHook(events.Common.WindowClosing, func(*application.WindowEvent) {
			windowHost.inputMonitor.nativeCloseWindowGone(created.Name())
		})
		created.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) {
			if err := renderer.Withdraw(created.Name()); err != nil {
				log.Printf("renderer commands: %v", err)
			}
			// The one fact this host has: which window is going.
			//
			// It invoked `close_window_terminals` until 2026-08-20 — a host that knew what a
			// terminal is, which is what C1 refuses, and which broke the day that command left with
			// the plugin that registered it: an invoke of an absent name is answered with "not
			// registered" and logged, so every window close printed a line nobody was reading for.
			//
			// A fact rather than an instruction. What to do about it is for whoever kept something
			// under this window, and this host reads nothing into the label it publishes.
			app.Event.Emit(WindowGoneEvent, WindowGone{WindowLabel: created.Name()})
		})
	})

	controlPlane := windowTemplate
	// The control plane's window is named by the product, not numbered by the
	// framework: the application branches on this name, and a generated
	// "window-1" would make that branch depend on creation order.
	controlPlane.Name = controlPlaneWindow
	controlPlane.URL = windowIdentityURL("/", options.Identity)
	window = app.Window.NewWithOptions(controlPlane)
	// The transparent backdrop cleared this window's colour on the way in. The
	// same restore wailsHost.Open performs, for the one window it does not open.
	window.SetBackgroundColour(controlPlane.BackgroundColour)
	window.OnWindowEvent(events.Common.WindowRuntimeReady, func(*application.WindowEvent) {
		repairDocumentView(window)
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
		capture := NewCaptureService(controlPlaneWindow, func() unsafe.Pointer {
			return nativeWindow(controlPlaneWindow)
		}, options.Presentation)
		go func() {
			time.Sleep(3 * time.Second)
			note, err := capture.Snapshot(target)
			if err != nil {
				log.Printf("capture-probe error %v", err)
			} else {
				log.Printf("capture-probe wrote %s", note.Path)
			}
			app.Quit()
		}()
	}

	// An unattended launch is one run's application. Started here rather than earlier because the
	// quit it calls is the framework's, and it does not exist until the application does.
	watchSpawner(options.Presentation, app.Quit)

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
func newWindowTemplate(presentation PresentationMode) application.WebviewWindowOptions {
	return application.WebviewWindowOptions{
		Title:  windowTitle,
		Width:  windowWidth,
		Height: windowHeight,
		Hidden: presentation == PresentationCaptureOnly,
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

// One backend per surface kind. The kind on a declaration picks it, so the next kind is another
// entry here and no edit inside the compositor.
func surfaceBackends(webviewBackend *webviewsurface.Backend) map[compositor.SurfaceKind]compositor.Backend {
	return map[compositor.SurfaceKind]compositor.Backend{
		webviewsurface.SurfaceKind:  webviewBackend,
		terminalsurface.SurfaceKind: terminalsurface.NewBackend(),
	}
}
