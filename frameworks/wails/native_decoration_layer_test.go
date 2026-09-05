package wails

import (
	"os"
	"strings"
	"testing"
	"unsafe"
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
		"overlay.layer.zPosition = 1000000",
		"if (content.subviews.lastObject != overlay)",
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

// What the native plane draws is the last snapshot it was given, and a reading of the plane has
// to state it: a stroke standing where the document no longer declares one is invisible to every
// reading that only counts. Measured 2026-09-05: a pane frame stood 41 points inside the pane
// after a rail travel, the document declared four strokes at the right places, and the receipt
// answered count 3.
func TestDecorationStatusStatesTheAppliedPaths(t *testing.T) {
	store := newNativeDecorationStore(func(string) unsafe.Pointer { return unsafe.Pointer(&struct{ int }{}) })
	store.applyFn = func(_ unsafe.Pointer, decorations []preparedNativeDecoration) (bool, int, error) {
		return true, len(decorations), nil
	}
	first := NativeDecoration{ID: "frame/a", Path: "M 0.5 0.5 L 9.5 0.5 Z", StrokeA: 1, StrokeWidth: 1}
	second := NativeDecoration{ID: "frame/b", Path: "M 20.5 0.5 L 29.5 0.5 Z", StrokeA: 1, StrokeWidth: 1}
	if _, err := store.Commit("w", []NativeDecoration{first, second}); err != nil {
		t.Fatal(err)
	}
	status := store.Status("w")
	if len(status.Applied) != 2 || status.Applied[0].ID != "frame/a" || status.Applied[0].Path != first.Path ||
		status.Applied[1].ID != "frame/b" || status.Applied[1].Path != second.Path {
		t.Fatalf("applied = %+v, want both strokes with their paths", status.Applied)
	}
	if _, err := store.Commit("w", []NativeDecoration{second}); err != nil {
		t.Fatal(err)
	}
	status = store.Status("w")
	if len(status.Applied) != 1 || status.Applied[0].ID != "frame/b" {
		t.Fatalf("applied after the second commit = %+v, want only frame/b", status.Applied)
	}
}
