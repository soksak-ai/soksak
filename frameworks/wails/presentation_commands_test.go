package wails

import (
	"testing"

	"github.com/soksak-ai/soksak-core/core/control"
)

func TestPresentationStatusNamesTheDesktopPolicy(t *testing.T) {
	registry := control.NewRegistry()
	RegisterPresentation(registry, PresentationCaptureOnly)
	answer, err := registry.Invoke("app_presentation", nil)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"mode": "capture-only", "desktopVisible": false}
	got, ok := answer.(map[string]any)
	if !ok || got["mode"] != want["mode"] || got["desktopVisible"] != want["desktopVisible"] {
		t.Fatalf("presentation status = %#v, want %#v", answer, want)
	}
}
