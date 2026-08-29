package wails

import (
	"github.com/soksak-ai/soksak-core/core/control"
	"github.com/soksak-ai/soksak-core/core/i18n"
)

// ClipboardHost is the desktop clipboard door supplied by the active framework.
// Core and plugins exchange only the public commands registered against it.
type ClipboardHost interface {
	SetText(text string) bool
	Text() (string, bool)
}

// RegisterClipboard owns the framework side of the public clipboard commands.
func RegisterClipboard(registry *control.Registry, host ClipboardHost) {
	if host == nil {
		panic("wails: clipboard commands need a ClipboardHost")
	}
	registry.MustRegister(control.Command{
		Name:  "clipboard_read",
		Owner: control.OwnerFramework,
		Handler: func(control.Args) (any, error) {
			text, ok := host.Text()
			if !ok {
				return nil, i18n.Errorf("wails.clipboard.readRefused", nil)
			}
			return text, nil
		},
	})
	registry.MustRegister(control.Command{
		Name:  "clipboard_write",
		Owner: control.OwnerFramework,
		Handler: func(args control.Args) (any, error) {
			text, err := control.Arg[string](args, "text")
			if err != nil {
				return nil, err
			}
			if !host.SetText(text) {
				return nil, i18n.Errorf("wails.clipboard.writeRefused", nil)
			}
			return nil, nil
		},
	})
	for name, because := range map[string]string{
		"clipboard_watch_start": "this framework exposes no clipboard change subscription",
		"clipboard_watch_stop":  "this framework exposes no clipboard change subscription to stop",
	} {
		if err := registry.DeclareUnserved(name, because); err != nil {
			panic(err)
		}
	}
}
