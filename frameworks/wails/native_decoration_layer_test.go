package wails

import (
	"os"
	"strings"
	"testing"
)

// A DOM outline cannot cover an AppKit child surface. The final focus/relation
// Core therefore draws the stroke in one native plane above every provider
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

func TestNativeDecorationPathAcceptsThePublishedRoundedSubset(t *testing.T) {
	commands, err := parseNativeDecorationPath("M 0.5 0.5 L 9.5 0.5 Q 10 0.5 10 1 L 10 9 Z M 2 2 L 4 2")
	if err != nil {
		t.Fatal(err)
	}
	got := make([]int, 0, len(commands))
	for _, command := range commands {
		got = append(got, command.op)
	}
	want := []int{
		nativePathMove, nativePathLine, nativePathQuad, nativePathLine,
		nativePathClose, nativePathMove, nativePathLine,
	}
	if len(got) != len(want) {
		t.Fatalf("path operations = %v, want %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("path operations = %v, want %v", got, want)
		}
	}
}

func TestNativeDecorationPathRefusesAnythingOutsideTheContract(t *testing.T) {
	for _, path := range []string{"", "L 1 1", "M 0 0 C 1 1 2 2 3 3", "M NaN 0"} {
		if _, err := parseNativeDecorationPath(path); err == nil {
			t.Errorf("path %q was accepted", path)
		}
	}
}
