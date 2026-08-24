package application

import (
	"github.com/soksak-ai/soksak-core/core/i18n"
	"github.com/soksak-ai/soksak-core/frameworks/wails"
)

func presentationFromEnvironment(value string) (wails.PresentationMode, error) {
	switch value {
	case "", string(wails.PresentationInteractive):
		return wails.PresentationInteractive, nil
	case string(wails.PresentationCaptureOnly):
		return wails.PresentationCaptureOnly, nil
	default:
		return "", i18n.Errorf("application.presentation.invalid", map[string]string{"mode": value})
	}
}

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"application.presentation.invalid": {
			EN: "SOKSAK_PRESENTATION must be interactive or capture-only: {mode}",
		},
	})
}
