package application

import (
	"testing"

	"github.com/soksak-ai/soksak-core/frameworks/wails"
)

func TestPresentationEnvironmentIsAnExplicitEnum(t *testing.T) {
	tests := []struct {
		value string
		want  wails.PresentationMode
		ok    bool
	}{
		{value: "", want: wails.PresentationInteractive, ok: true},
		{value: "interactive", want: wails.PresentationInteractive, ok: true},
		{value: "capture-only", want: wails.PresentationCaptureOnly, ok: true},
		{value: "0", ok: false},
		{value: "unattended", ok: false},
		{value: "hidden", ok: false},
	}
	for _, test := range tests {
		got, err := presentationFromEnvironment(test.value)
		if test.ok && (err != nil || got != test.want) {
			t.Errorf("presentation %q = %q, %v; want %q", test.value, got, err, test.want)
		}
		if !test.ok && err == nil {
			t.Errorf("presentation %q was accepted as %q", test.value, got)
		}
	}
}
