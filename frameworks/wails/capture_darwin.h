// Focus-free window capture on macOS.
//
// ScreenCaptureKit captures what the OS compositor produced, so the main
// webview and every native child land in one image with no holes — a
// per-webview snapshot cannot do that. Asking for this process's own shareable
// content means no screen-recording permission is required, the window need not
// be focused, and an occluded window still captures.
//
// CGWindowListCreateImage is obsolete on macOS 15 and blocks during rendering.
// It is not used here.

#ifndef SOKSAK_CAPTURE_DARWIN_H
#define SOKSAK_CAPTURE_DARWIN_H

#include <stddef.h>

// One capture result. `png` is malloc'd and owned by the caller; `error` is a
// malloc'd C string when the capture failed. Exactly one of them is non-NULL.
typedef struct {
  unsigned char *png;
  size_t png_len;
  char *error;
} SoksakCapture;

// Capture the window behind `nsWindow`, cropped to a rect in window-relative
// CSS points with a top-left origin. A zero-sized rect captures the whole
// window. Blocks until the asynchronous capture completes or `timeout_ms`
// elapses.
SoksakCapture soksakCaptureWindow(void *nsWindow, double x, double y, double w,
                                  double h, int timeout_ms);

// Capture the document alone, through the web view that draws it, cropped the same way.
//
// This asks the web view for its own pixels instead of asking the compositor for the
// window's, so it needs no screen-recording grant and works under any application identity.
// What it cannot show is a native child: a page drawn by another process is composited above
// this document and is not in this image. It is the evidence available when the window
// capture is refused, and it is a different picture, so it has a different name.
SoksakCapture soksakCaptureDocument(void *nsWindow, double x, double y, double w,
                                    double h, int timeout_ms);

int soksakCapturePresent(void *nsWindow);
void soksakCaptureRestore(void *nsWindow, int ordered);

void soksakCaptureFree(SoksakCapture capture);

#endif
