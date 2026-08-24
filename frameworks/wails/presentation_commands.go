package wails

import "github.com/soksak-ai/soksak-core/core/control"

func RegisterPresentation(registry *control.Registry, presentation PresentationMode) {
	if presentation != PresentationInteractive && presentation != PresentationCaptureOnly {
		panic("wails: presentation command requires a valid mode")
	}
	registry.MustRegister(control.Command{
		Name:  "app_presentation",
		Owner: control.OwnerFramework,
		Handler: func(control.Args) (any, error) {
			return map[string]any{
				"mode":           string(presentation),
				"desktopVisible": presentation == PresentationInteractive,
			}, nil
		},
	})
}
