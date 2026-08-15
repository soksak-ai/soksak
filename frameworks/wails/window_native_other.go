//go:build !darwin

package wails

import (
	"errors"
	"unsafe"
)

// ErrRevealWithoutKeyUnsupported is returned where no focus-free reveal exists.
//
// This framework's only reveal takes the keyboard, and there is no portable way
// to bring a window forward without it. Returning success would make a restored
// window steal the focus from whatever the user is doing and report that it did
// not — so the platform is named instead.
var ErrRevealWithoutKeyUnsupported = errors.New("bringing a window forward without taking the keyboard is not implemented on this platform")

// ErrActivationUnsupported is returned where no application activation request
// exists. A window brought forward while the application stays in the
// background receives no keys, and reporting success would leave the caller
// waiting for input that never arrives.
var ErrActivationUnsupported = errors.New("application activation is not implemented on this platform")

func orderWindowFrontWithoutKey(unsafe.Pointer) error { return ErrRevealWithoutKeyUnsupported }

func activateApplication() error { return ErrActivationUnsupported }

// ErrTitleUnsupported is returned where the title cannot be read back.
//
// The boot stamp the frontend writes there is the observation channel that
// survives a dead binding path, so an empty string would look like a window
// that booted silently rather than one nobody can see into.
var ErrTitleUnsupported = errors.New("reading a window title is not implemented on this platform")

func nativeWindowTitle(unsafe.Pointer) (string, error) { return "", ErrTitleUnsupported }

// ErrContentSizeUnsupported is returned where the content rect cannot be read
// back. Answering the frame instead would be a different rectangle wearing this
// one's name.
var ErrContentSizeUnsupported = errors.New("reading a window's content size is not implemented on this platform")

func contentSize(unsafe.Pointer) (float64, float64, error) { return 0, 0, ErrContentSizeUnsupported }

// ErrWebviewFrameUnsupported is returned where the document's view cannot be
// located. Answering the window's own rect would attribute the document's size
// to the window, which is the question this exists to separate.
var ErrWebviewFrameUnsupported = errors.New("reading the web view's frame is not implemented on this platform")

func webviewFrame(unsafe.Pointer) (x, y, width, height float64, err error) {
	return 0, 0, 0, 0, ErrWebviewFrameUnsupported
}

// ErrFitUnsupported is returned where the view hierarchy cannot be corrected.
// The overflow is then reported by ui.verify rather than silently tolerated.
var ErrFitUnsupported = errors.New("fitting the web view to its window is not implemented on this platform")

func fitWebviewToWindow(unsafe.Pointer) error { return ErrFitUnsupported }
