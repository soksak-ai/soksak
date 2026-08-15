// The window operations this framework has no API for.
//
// Its only reveal is makeKeyAndOrderFront, which takes the keyboard — a
// background restore through it steals focus from whatever the user is doing.
// And its own focus path activates the application with
// activateIgnoringOtherApps:, which current macOS ignores for a background
// app, so a window comes forward while the keyboard never arrives.

#ifndef SOKSAK_WINDOW_NATIVE_DARWIN_H
#define SOKSAK_WINDOW_NATIVE_DARWIN_H

#include <stdbool.h>

// Order the window in front of every other window in this application without
// making it the key window. Plain front ordering is not used: an occluded
// window can have its display callbacks suspended, and then it never paints a
// frame anyone can observe.
//
// Must be called on the main thread.
void soksakOrderFrontRegardless(void *nsWindow);

// Bring this application forward. Returns false where the supported request
// does not exist, so "this OS cannot do it" stays distinct from "it was done".
// The deprecated activateIgnoringOtherApps: is not used as a second attempt —
// current macOS ignores it from a background application, and a request that
// reports success while nothing came forward is worse than a refusal.
//
// Must be called on the main thread.
bool soksakActivateApplication(void);

// Copy this window's title. The frontend writes its boot progress into
// document.title, and that is the one channel that keeps working when the
// binding path is dead — so a window that answers nothing else still says how
// far it got. Returns a string the caller frees, or NULL if there is none.
//
// The framework only sets titles; it never reads one back, and a stamp nobody
// can read is not an observation.
//
// Must be called on the main thread.
char *soksakCopyWindowTitle(void *nsWindow);

// Copy this window's content rect — the area a document actually occupies,
// in device-independent points, with the window's own chrome subtracted.
//
// The framework answers the *frame* and offers no reader for the content. Those
// are different rectangles, and comparing one against a document's own size
// reports a discrepancy that is only the two measurements disagreeing about what
// they measured. Measured 2026-08-15: frame 999x617, document 1000x618.
//
// Must be called on the main thread.
void soksakWindowContentSize(void *nsWindow, double *width, double *height);

#endif
