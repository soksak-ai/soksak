package wails

import (
	"os"
	"strings"
	"testing"
)

// A DOM outline cannot cover an AppKit child surface. The final focus/relation
// stroke therefore belongs to one Core-owned native plane above every provider
// surface. The plane is generic: browser and terminal are inputs underneath it,
// never branches in its implementation.
func TestNativeDecorationPlaneIsAboveEveryChildSurface(t *testing.T) {
	source, err := os.ReadFile("window_native_darwin.m")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	required := []string{
		"@interface SoksakNativeDecorationOverlay : NSView",
		"- (NSView *)hitTest:(NSPoint)point { return nil; }",
		"- (BOOL)isFlipped { return YES; }",
		"CAShapeLayer",
		"[content addSubview:overlay positioned:NSWindowAbove relativeTo:nil]",
	}
	for _, fragment := range required {
		if !strings.Contains(text, fragment) {
			t.Errorf("native decoration plane is missing %q", fragment)
		}
	}
}

// Re-applying after a surface inventory commit is the ordering fence. Creating
// the overlay once is insufficient: both native providers add their own child
// above the current siblings when a view is created or re-enabled.
func TestSurfaceCommitRaisesTheDecorationPlaneLast(t *testing.T) {
	source, err := os.ReadFile("host.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	for _, fragment := range []string{
		"nativePresentationService",
		"decorations.Reapply(snapshot.Window)",
	} {
		if !strings.Contains(text, fragment) {
			t.Errorf("native surface commit has no final decoration ordering fence %q", fragment)
		}
	}
}
