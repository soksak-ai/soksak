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
