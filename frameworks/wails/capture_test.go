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
	service := NewCaptureService("main", func() unsafe.Pointer { return nil })

	if _, err := service.Snapshot(""); err == nil {
		t.Fatal("an empty path must fail rather than pick one")
	}
}

func TestCaptureWithoutAWindowSaysSo(t *testing.T) {
	service := NewCaptureService("main", nil)

	_, err := service.Snapshot("<local-evidence>/soksak-capture-test.png")
	if err == nil {
		t.Fatal("capture with no window source must fail")
	}
}

func TestCaptureBeforeTheWindowExists(t *testing.T) {
	// Capture can be requested during boot, before the window is created. That
	// is a distinct failure from a capture that produced nothing.
	service := NewCaptureService("main", func() unsafe.Pointer { return nil })

	if _, err := service.Pixels(Whole); err == nil {
		t.Fatal("capture before the window exists must fail by name")
	}
}

func TestZeroAlphaPresentationCapturesTheDocumentWithoutReadingTheDarkWindowLayer(t *testing.T) {
	handle := byte(1)
	want := []byte("document pixels")
	windowCaptureCalled := false
	service := NewCaptureService("measurement", func() unsafe.Pointer { return unsafe.Pointer(&handle) })
	service.documentOnly = true
	service.capture = func(unsafe.Pointer, Rect) ([]byte, error) {
		windowCaptureCalled = true
		return []byte("zero-alpha window"), nil
	}
	service.captureDocument = func(unsafe.Pointer, Rect) ([]byte, error) { return want, nil }
	service.occlusion = nil

	result, err := service.Pixels(Whole)
	if err != nil {
		t.Fatal(err)
	}
	if windowCaptureCalled {
		t.Fatal("zero-alpha capture read the native window layer")
	}
	if !result.Note.DocumentOnly {
		t.Fatal("capture receipt hid that the document was the pixel source")
	}
	if result.PNG != "ZG9jdW1lbnQgcGl4ZWxz" {
		t.Fatalf("captured %q instead of the document", result.PNG)
	}
}

func TestUnsupportedPlatformIsNamed(t *testing.T) {
	// The sentinel exists so a caller can tell "not implemented here" from
	// "the capture failed", rather than reading a message.
	if ErrCaptureUnsupported == nil || !errors.Is(ErrCaptureUnsupported, ErrCaptureUnsupported) {
		t.Fatal("the unsupported-platform error must be a usable sentinel")
	}
}
