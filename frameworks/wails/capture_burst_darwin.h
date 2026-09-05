// Display-rate window capture on macOS.
//
// A single capture answers one frame in about 120ms, and a one-frame change is over in 16ms:
// measured 2026-09-05, a blank pane between a surface and its picture was never in a snapshot burst.
// A ScreenCaptureKit stream delivers every frame the compositor produces for this window while it
// runs, so what happened between two snapshots is on disk with its time.

#ifndef SOKSAK_CAPTURE_BURST_DARWIN_H
#define SOKSAK_CAPTURE_BURST_DARWIN_H

#include <stddef.h>

// One burst. `times_ms` holds one entry per frame written, milliseconds from the start of the
// stream, malloc'd. `stopped` names why the burst ended before its duration, or is NULL. `error`
// is set when no frame could be taken at all.
typedef struct {
  int frames;
  double *times_ms;
  int width;
  int height;
  char *stopped;
  char *error;
} SoksakBurst;

// Stream the window behind `nsWindow` for `duration_ms`, cropped to a rect in window-relative CSS
// points with a top-left origin (a zero-sized rect is the whole window), writing dir/f0000.png ...
// for every completed frame the compositor produced. The burst ends early once `max_frames` frames
// are taken or the raw pixel bytes waiting to be encoded pass `max_bytes`. `interval_ms` is the
// least time between two frames; zero takes every frame the display produces. `timeout_ms` bounds
// the start of the stream.
SoksakBurst soksakCaptureBurst(void *nsWindow, double x, double y, double w, double h,
                               int duration_ms, int max_frames, int interval_ms,
                               long long max_bytes, const char *dir, int timeout_ms);

void soksakBurstFree(SoksakBurst burst);

#endif
