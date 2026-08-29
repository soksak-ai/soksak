package wails

import "github.com/soksak-ai/soksak-core/core/control"

// ClipboardHost is the desktop clipboard door supplied by the active framework.
// Core and plugins exchange only the public commands registered against it.
type ClipboardHost interface {
	SetText(text string) bool
	Text() (string, bool)
}

// RegisterClipboard owns the framework side of the public clipboard commands.
func RegisterClipboard(_ *control.Registry, host ClipboardHost) {
	if host == nil {
		panic("wails: clipboard commands need a ClipboardHost")
	}
}
