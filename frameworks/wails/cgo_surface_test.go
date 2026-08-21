package wails

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// cgoFiles is the fixed set of files in this package that import "C".
//
// N1 keeps the platform layer to one thin layer: everything that can be pure Go
// is pure Go, and cgo does only "apply this batch on the main thread and
// report the frames that resulted". A new entry here needs a stated reason.
var cgoFiles = map[string]string{
	"capture_darwin.go": "the ScreenCaptureKit bridge; the capture itself lives in capture_darwin.m",
	"capture_linux.go":  "the GTK render-node capture bridge; the capture itself lives in capture_linux.c",
	// The rendering throttle is a private AppKit selector on WKWebView, looked
	// up by name because it is private. There is no Go equivalent and no public
	// one either. The walk of the window's web views is in
	// capture_occlusion_darwin.m.
	"capture_occlusion_darwin.go": "the occlusion-detection switch a capture holds off; it lives in capture_occlusion_darwin.m",
	// The framework reveals a window only by making it the key window, and
	// activates the application only through a call current macOS ignores. Both
	// are two AppKit lines with no Go equivalent, and both live in
	// window_native_darwin.m.
	"window_native_darwin.go": "the two window operations this framework has no API for; they live in window_native_darwin.m",
	"window_native_linux.go":  "the GTK4 visibility operation that reveals a window without requesting focus; it lives in window_native_linux.c",
}

func TestCgoSurfaceIsFixed(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("reading the package: %v", err)
	}

	found := map[string]bool{}
	for _, entry := range entries {
		// Test files are excluded: this one names what it forbids, and a gate
		// that cannot describe its own rule cannot state it.
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		source, err := os.ReadFile(entry.Name())
		if err != nil {
			t.Fatalf("reading %s: %v", entry.Name(), err)
		}
		if !strings.Contains(string(source), `import "C"`) {
			continue
		}
		found[entry.Name()] = true
		if _, declared := cgoFiles[entry.Name()]; !declared {
			t.Errorf("%s imports \"C\" without a declared reason; add it to cgoFiles or keep it pure Go", entry.Name())
		}
	}

	for name := range cgoFiles {
		if !found[name] {
			t.Errorf("%s is declared as a cgo file but no longer imports \"C\"; drop the entry", name)
		}
	}
}

func TestNativeSourceLivesOutsideTheCgoComment(t *testing.T) {
	// N2. Inside a comment there is no syntax highlighting, no separate
	// compilation unit, and no way to test the native code on its own terms.
	// The preamble holds directives and an include of our own header.
	for name := range cgoFiles {
		source, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("reading %s: %v", name, err)
		}
		preamble := cgoPreamble(string(source))
		for _, marker := range []string{"@interface", "@implementation", "static ", "dispatch_", "NSWindow", "CGImage"} {
			if strings.Contains(preamble, marker) {
				t.Errorf("%s holds native code in its cgo comment (%q); move it to a .m or .c file", name, marker)
			}
		}
	}

	// The header and implementation the preamble includes must exist, or the
	// rule is satisfied by having no native code rather than by separating it.
	for _, name := range []string{
		"capture_darwin.h", "capture_darwin.m",
		"capture_linux.h", "capture_linux.c",
		"window_native_darwin.h", "window_native_darwin.m",
		"window_native_linux.h", "window_native_linux.c",
	} {
		if _, err := os.Stat(filepath.Clean(name)); err != nil {
			t.Errorf("%s is missing: %v", name, err)
		}
	}
}

func TestScreenCaptureKitHasAnExplicitAvailabilityBoundary(t *testing.T) {
	bridge, err := os.ReadFile("capture_darwin.go")
	if err != nil {
		t.Fatal(err)
	}
	implementation, err := os.ReadFile("capture_darwin.m")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(bridge), "framework ScreenCaptureKit") {
		t.Error("ScreenCaptureKit must be discovered at runtime so older supported macOS releases can start")
	}
	if !strings.Contains(string(implementation), "@available(macOS 14.4, *)") {
		t.Error("the 14.4 current-process capture API must have a runtime availability guard")
	}
	if !strings.Contains(string(implementation), `NSClassFromString(@"SCShareableContent")`) {
		t.Error("the guarded capture path must discover ScreenCaptureKit without a load-time class reference")
	}
	if !strings.Contains(string(implementation), "dlopen(") {
		t.Error("the guarded capture path must load ScreenCaptureKit before discovering its classes")
	}
}

// cgoPreamble returns the comment block immediately preceding `import "C"`.
func cgoPreamble(source string) string {
	end := strings.Index(source, `import "C"`)
	if end < 0 {
		return ""
	}
	start := strings.LastIndex(source[:end], "/*")
	if start < 0 {
		return ""
	}
	return source[start:end]
}
