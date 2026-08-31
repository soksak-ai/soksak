package wails

import (
	"errors"
	"testing"
	"unsafe"
)

func TestCaptureRefusesAMissingWindow(t *testing.T) {
	// A nil window and a blank capture must not be the same answer.
	if _, err := CaptureWindow(nil, Whole); err == nil {
		t.Fatal("capturing a nil window must fail by name")
	}
}

func TestSnapshotNeedsAPath(t *testing.T) {
	service := NewCaptureService("main", func() unsafe.Pointer { return nil }, PresentationInteractive)

	if _, err := service.Snapshot(""); err == nil {
		t.Fatal("an empty path must fail rather than pick one")
	}
}

func TestCaptureWithoutAWindowSaysSo(t *testing.T) {
	service := NewCaptureService("main", nil, PresentationInteractive)

	_, err := service.Snapshot("/tmp/soksak-capture-test.png")
	if err == nil {
		t.Fatal("capture with no window source must fail")
	}
}

func TestCaptureBeforeTheWindowExists(t *testing.T) {
	// Capture can be requested during boot, before the window is created. That
	// is a distinct failure from a capture that produced nothing.
	service := NewCaptureService("main", func() unsafe.Pointer { return nil }, PresentationInteractive)

	if _, err := service.Pixels(Whole); err == nil {
		t.Fatal("capture before the window exists must fail by name")
	}
}

func TestCaptureOnlyReadsTheDocumentAndDeclaresTheMissingNativeChildren(t *testing.T) {
	handle := byte(1)
	service := NewCaptureService("main", func() unsafe.Pointer { return unsafe.Pointer(&handle) }, PresentationCaptureOnly)
	windowCaptures := 0
	documentCaptures := 0
	service.capture = func(unsafe.Pointer, Rect) ([]byte, error) {
		windowCaptures++
		return solidPNG(t, 2, 2, background), nil
	}
	service.captureDocument = func(unsafe.Pointer, Rect) ([]byte, error) {
		documentCaptures++
		return solidPNG(t, 2, 2, background), nil
	}

	pixels, err := service.Pixels(Whole)
	if err != nil {
		t.Fatal(err)
	}
	if windowCaptures != 0 || documentCaptures != 1 || !pixels.Note.DocumentOnly {
		t.Fatalf("capture-only source window=%d document=%d note=%+v", windowCaptures, documentCaptures, pixels.Note)
	}
}

func TestOrderedCaptureOnlyPresentationCompletesOneDocumentSnapshot(t *testing.T) {
	handle := byte(1)
	service := NewCaptureService("main", func() unsafe.Pointer { return unsafe.Pointer(&handle) }, PresentationCaptureOnly)
	documentCaptures := 0
	service.captureDocument = func(got unsafe.Pointer, rect Rect) ([]byte, error) {
		if got != unsafe.Pointer(&handle) || rect != Whole {
			t.Fatalf("preparation target=%p rect=%+v", got, rect)
		}
		documentCaptures++
		return solidPNG(t, 2, 2, background), nil
	}

	if err := service.preparePresentedDocument(unsafe.Pointer(&handle), false); err != nil {
		t.Fatal(err)
	}
	if documentCaptures != 0 {
		t.Fatalf("visible presentation performed %d document captures", documentCaptures)
	}
	if err := service.preparePresentedDocument(unsafe.Pointer(&handle), true); err != nil {
		t.Fatal(err)
	}
	if documentCaptures != 1 {
		t.Fatalf("ordered capture-only presentation performed %d document captures", documentCaptures)
	}
}

func TestUnsupportedPlatformIsNamed(t *testing.T) {
	// The sentinel exists so a caller can tell "not implemented here" from
	// "the capture failed", rather than reading a message.
	if ErrCaptureUnsupported == nil || !errors.Is(ErrCaptureUnsupported, ErrCaptureUnsupported) {
		t.Fatal("the unsupported-platform error must be a usable sentinel")
	}
}
