#ifndef SOKSAK_CAPTURE_LINUX_H
#define SOKSAK_CAPTURE_LINUX_H

#include <stddef.h>

typedef struct {
  unsigned char *png;
  size_t png_len;
  char *error;
} SoksakLinuxCapture;

SoksakLinuxCapture soksakCaptureLinuxWindow(void *gtk_window, double x,
                                             double y, double width,
                                             double height);
void soksakCaptureLinuxFree(SoksakLinuxCapture capture);

#endif
