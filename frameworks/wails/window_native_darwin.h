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

#endif
