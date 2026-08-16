#ifndef SOKSAK_CAPTURE_OCCLUSION_H
#define SOKSAK_CAPTURE_OCCLUSION_H

// soksakSetWindowOcclusionDetection turns occlusion detection off or on for
// every web view in one window, and answers how many it reached.
//
// The count is the answer rather than a success flag: a window holds the
// application's own view and one per native surface, and turning it off for the
// first alone leaves every browser pane throttled while the caller reads a
// clean result.
int soksakSetWindowOcclusionDetection(void *window, int enabled);

#endif
