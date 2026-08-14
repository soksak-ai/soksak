package main

import (
	"embed"
	"log"
	"unsafe"

	nativebrowser "github.com/soksak/soksak-plugin-browser-native"
	terminal "github.com/soksak/soksak-plugin-terminal-xterm"
	compositor "github.com/soksak/wails-service-native-compositor"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// Wails uses Go's `embed` package to embed the frontend files into the binary.
// Any files in the frontend/dist folder will be embedded into the binary and
// made available to the frontend.
// See https://pkg.go.dev/embed for more information.

//go:embed all:frontend/dist
var assets embed.FS

func init() {
	application.RegisterEvent[terminal.Output]("terminal:output")
}

type terminalEventSink struct{ app *application.App }

func (sink *terminalEventSink) EmitTerminalOutput(output terminal.Output) {
	if sink.app != nil {
		sink.app.Event.Emit("terminal:output", output)
	}
}

// main function serves as the application's entry point. It initializes the application, creates a window,
// and starts a goroutine that emits a time-based event every second. It subsequently runs the application and
// logs any error that might occur.
func main() {

	// Create a new Wails application by providing the necessary options.
	// Variables 'Name' and 'Description' are for application metadata.
	// 'Assets' configures the asset server with the 'FS' variable pointing to the frontend files.
	// 'Bind' is a list of Go struct instances. The frontend has access to the methods of these instances.
	// 'Mac' options tailor the application when running an macOS.
	sink := &terminalEventSink{}
	terminalService := terminal.NewService(sink)
	var window application.Window
	browserBackend := nativebrowser.NewBackend()
	compositorService := compositor.NewService(func() unsafe.Pointer {
		if window == nil {
			return nil
		}
		return window.NativeWindow()
	}, browserBackend)
	browserService := nativebrowser.NewService(browserBackend)
	app := application.New(application.Options{
		Name:        "soksak-core",
		Description: "Plugin-driven recursive terminal and browser workspace",
		Services: []application.Service{
			application.NewService(terminalService),
			application.NewService(compositorService),
			application.NewService(browserService),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})
	sink.app = app

	// Create a new window with the necessary options.
	// 'Title' is the title of the window.
	// 'Mac' options tailor the window when running on macOS.
	// 'BackgroundColour' is the background colour of the window.
	// 'URL' is the URL that will be loaded into the webview.
	window = app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title: "soksak-core",
		// Window sized to the golden ratio (1000 / 618 ≈ 1.618).
		Width:  1000,
		Height: 618,
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 50,
			Backdrop:                application.MacBackdropTranslucent,
			TitleBar:                application.MacTitleBarHiddenInset,
		},
		BackgroundColour: application.NewRGB(6, 7, 15),
		URL:              "/",
	})

	// Run the application. This blocks until the application has been exited.
	err := app.Run()

	// If an error occurred while running the application, log it and exit.
	if err != nil {
		log.Fatal(err)
	}
}
