package wails

import (
	"os"
	"strings"
	"testing"
)

func TestLinuxCaptureUsesGTKRenderNodesOnTheMainThread(t *testing.T) {
	bridge, err := os.ReadFile("capture_linux.go")
	if err != nil {
		t.Fatal(err)
	}
	native, err := os.ReadFile("capture_linux.c")
	if err != nil {
		t.Fatal(err)
	}
	goSource := string(bridge)
	cSource := string(native)
	for _, required := range []string{
		"application.InvokeSyncWithResultAndError",
		"soksakCaptureLinuxWindow",
	} {
		if !strings.Contains(goSource, required) {
			t.Errorf("capture_linux.go is missing %s", required)
		}
	}
	for _, required := range []string{
		"gtk_widget_snapshot_child",
		"gsk_renderer_render_texture",
		"gsk_renderer_unrealize",
		"gdk_texture_save_to_png_bytes",
	} {
		if !strings.Contains(cSource, required) {
			t.Errorf("capture_linux.c is missing %s", required)
		}
	}
}

func TestUnsupportedCaptureExcludesTheLinuxGTKBuild(t *testing.T) {
	source, err := os.ReadFile("capture_unsupported.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(source), "!darwin && (!linux || !cgo") {
		t.Fatal("capture_unsupported.go still owns the Linux GTK build")
	}
}
