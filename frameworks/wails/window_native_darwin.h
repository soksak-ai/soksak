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

typedef struct {
  int op;
  double x1;
  double y1;
  double x2;
  double y2;
} SoksakNativePathCommand;

typedef struct {
  const char *identifier;
  const SoksakNativePathCommand *commands;
  int commandCount;
  double strokeR;
  double strokeG;
  double strokeB;
  double strokeA;
  double strokeWidth;
  const double *dash;
  int dashCount;
} SoksakNativeDecoration;

// Replaces the complete pointer-transparent decoration plane and raises it
// above every current child surface. Coordinates are CSS points from the
// content area's top-left. applied receives the number of shape layers.
int soksakApplyNativeDecorations(void *nsWindow,
                                 const SoksakNativeDecoration *decorations,
                                 int count,
                                 int *applied);

// Order the window in front of every other window in this application without
// making it the key window. Plain front ordering is not used: an occluded
// window can have its display callbacks suspended, and then it never paints a
// frame anyone can observe.
//
// Must be called on the main thread.
void soksakOrderFrontRegardless(void *nsWindow);

// Keep a capture-only window in the compositor without putting light or an
// input target on the user's desktop. AppKit may consider a fully transparent
// ordered window visible for occlusion purposes, so WebKit keeps delivering
// display callbacks while the window remains non-key and mouse-transparent.
//
// Must be called on the main thread.
void soksakPresentCaptureOnlyWindow(void *nsWindow);

// Bring this application forward. Returns false where the supported request
// does not exist, so "this OS cannot do it" stays distinct from "it was done".
// The deprecated activateIgnoringOtherApps: is not used as a second attempt —
// current macOS ignores it from a background application, and a request that
// reports success while nothing came forward is worse than a refusal.
//
// Must be called on the main thread.
bool soksakActivateApplication(void);

// Return the process that currently receives application-level input. This is
// a read-only NSWorkspace query and requires no Apple Events permission.
int soksakFrontmostProcessID(void);

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

// Copy the frame of the view a document actually renders into, in
// device-independent points.
//
// Between the window and the document there is a view hierarchy this
// application did not build, and a discrepancy between the two has to be
// attributed to one of them. Measured 2026-08-15: window content 700x500,
// document 701x501 — and without this the layer responsible could only be
// guessed at.
//
// Must be called on the main thread.
void soksakWebviewFrame(void *nsWindow, double *x, double *y, double *width, double *height);

// Fit the document's view to the window's content area.
//
// The framework creates its content NSView one point smaller than the window
// (`width-1, height-1`) and then lets autoresizing carry that offset, so the web
// view ends up one point larger than the area it can be seen in. Measured
// 2026-08-15: content 999x617, view 1000x618 — the document's last column and
// row were outside the window, and anything drawn there was invisible rather
// than absent.
//
// Called once per window, after the window exists. Autoresizing keeps the fit
// afterwards, because the margins it preserves are zero once they start at zero.
//
// Must be called on the main thread.
void soksakFitWebviewToWindow(void *nsWindow);


// SoksakWindowPresence is whether a window is putting light on the screen right now.
//
// Frame, size and the surface inventory all describe a window that may be behind another
// application, minimised, or never ordered in. Every one of those reads correct while nobody can
// see the window, so "where it is" and "whether it is there" are separate questions and this
// answers the second (measured 2026-08-16: two windows both answered a frame on the display and
// neither answer said which one a person was looking at).
//
// principal is AppKit's main window — the application's chief one, which is not always the one
// receiving keys. occluded is AppKit's own word too: the window is on screen and something is over
// it. It is false for
// a window that is not visible at all — that is what visible is for.
typedef struct {
  bool visible;
  bool key;
  bool principal;
  bool miniaturized;
  bool occluded;
  double alpha;
} SoksakWindowPresence;

SoksakWindowPresence soksakWindowPresence(void *nsWindow);

// Platform result types use copied strings. The Go adapter owns and frees
// inputOwner, hitOwner and errorMessage after every call.
typedef struct {
  bool windowFocused;
  bool marked;
  char *inputOwner;
  char *errorMessage;
} SoksakWindowInputState;

// Read and drive the native text-input contract. Coordinates have a top-left
// origin and are expressed in device-independent content points, matching the
// document command surface.
//
// Must be called on the main thread.
SoksakWindowInputState soksakWindowInputState(void *nsWindow);
SoksakWindowInputState soksakSetWindowMarkedText(void *nsWindow, const char *text);

typedef struct {
  bool delivered;
  bool windowFocused;
  bool foregroundPreserved;
  char *errorMessage;
} SoksakNativeInputDelivery;

// Deliver input to the window's WKWebView through AppKit without activating
// the application, moving the system pointer or making the window key.
// Coordinates use the window content's top-left origin in device-independent
// points, the same space returned by ui.measure.
SoksakNativeInputDelivery soksakClickWindowPointer(void *nsWindow,
                                                    unsigned long long sequence,
                                                    double x,
                                                    double y);
SoksakNativeInputDelivery soksakPressWindowKey(void *nsWindow,
                                               unsigned long long sequence,
                                               const char *key,
                                               bool ctrl,
                                               bool meta,
                                               bool shift,
                                               bool alt);

// Observe physical left-button edges before WebKit decides whether its DOM
// receives them. The returned token owns exactly one local monitor and must be
// removed during application shutdown.
//
// Must be called on the main thread.
void *soksakInstallWindowInputMonitor(void);
void soksakRemoveWindowInputMonitor(void *token);

typedef struct {
  bool present;
  bool enabled;
  bool visible;
  bool windowVisible;
  double x;
  double y;
  double width;
  double height;
} SoksakNativeCloseStatus;

// Read and click the standard AppKit close button. The click enters NSApplication as a mouse
// down/up pair; it does not call performClose: or the application's window-close command.
SoksakNativeCloseStatus soksakNativeCloseStatus(void *nsWindow);
bool soksakClickNativeClose(void *nsWindow, unsigned long long sequence);

#endif
