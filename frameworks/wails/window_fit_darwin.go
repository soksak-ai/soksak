//go:build darwin

package wails

import (
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func repairDocumentView(window application.Window) {
	if window == nil || window.NativeWindow() == nil {
		return
	}
	application.InvokeSync(func() {
		if err := fitWebviewToWindow(window.NativeWindow()); err != nil {
			log.Printf("macOS document view repair failed: %v", err)
		}
	})
}
