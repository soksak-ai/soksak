//go:build !darwin

package wails

import "github.com/wailsapp/wails/v3/pkg/application"

// Wails owns and sizes the document view on Windows and Linux.
func repairDocumentView(application.Window) {}
