#import "capture_darwin.h"

#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

static SoksakCapture failure(NSString *message) {
  SoksakCapture out = {NULL, 0, strdup(message.UTF8String)};
  return out;
}

// Output size comes from one filter snapshot: contentRect is the filter
// target's size in screen points and pointPixelScale converts those to pixels.
// Mixing an NSWindow frame read earlier with pixels captured later resamples a
// later moment to an earlier size, producing a stretched frame that was never
// on screen during a live resize.
static BOOL pixelExtent(CGFloat widthPoints, CGFloat heightPoints, double scale,
                        size_t *outWidth, size_t *outHeight) {
  if (!(widthPoints > 0 && heightPoints > 0 && scale > 0)) return NO;
  size_t w = (size_t)llround(widthPoints * scale);
  size_t h = (size_t)llround(heightPoints * scale);
  *outWidth = w > 0 ? w : 1;
  *outHeight = h > 0 ? h : 1;
  return YES;
}

// Clamp a CSS-point rect into the captured pixel image. A rect that survives
// clamping to less than a pixel is refused rather than encoded as an empty
// image, so "nothing was there" and "the crop was wrong" stay distinct.
static BOOL cropRect(double x, double y, double w, double h, double scale,
                     size_t imgW, size_t imgH, CGRect *out) {
  if (!(scale > 0) || w <= 0 || h <= 0) return NO;
  double x0 = fmin(fmax(x * scale, 0.0), (double)imgW);
  double y0 = fmin(fmax(y * scale, 0.0), (double)imgH);
  double x1 = fmin(fmax((x + w) * scale, 0.0), (double)imgW);
  double y1 = fmin(fmax((y + h) * scale, 0.0), (double)imgH);
  if (x1 - x0 < 1.0 || y1 - y0 < 1.0) return NO;
  *out = CGRectMake(x0, y0, x1 - x0, y1 - y0);
  return YES;
}

static NSData *pngFromCGImage(CGImageRef image) {
  NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithCGImage:image];
  NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
  [rep release];
  return png;
}

SoksakCapture soksakCaptureWindow(void *nsWindow, double x, double y, double w,
                                  double h, int timeout_ms) {
  if (nsWindow == NULL) return failure(@"capture received a nil window");

  NSWindow *window = (NSWindow *)nsWindow;
  __block CGWindowID target = 0;
  if ([NSThread isMainThread]) {
    target = (CGWindowID)window.windowNumber;
  } else {
    dispatch_sync(dispatch_get_main_queue(), ^{
      target = (CGWindowID)window.windowNumber;
    });
  }
  if (target == 0) return failure(@"the window has no window number yet");

  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  __block NSData *png = nil;
  __block NSString *error = nil;

  // getCurrentProcessShareableContent limits the query to this process's own
  // windows, which is what makes the capture work without a TCC grant.
  [SCShareableContent getCurrentProcessShareableContentWithCompletionHandler:^(
                          SCShareableContent *content, NSError *contentError) {
    if (content == nil || contentError != nil) {
      error = [NSString stringWithFormat:@"shareable content unavailable: %@",
                                         contentError.localizedDescription ?: @"unknown"];
      dispatch_semaphore_signal(done);
      return;
    }

    SCWindow *match = nil;
    for (SCWindow *candidate in content.windows) {
      if (candidate.windowID == target) {
        match = candidate;
        break;
      }
    }
    if (match == nil) {
      error = [NSString stringWithFormat:@"window %u is not in this process's shareable content", target];
      dispatch_semaphore_signal(done);
      return;
    }

    SCContentFilter *filter =
        [[SCContentFilter alloc] initWithDesktopIndependentWindow:match];
    CGRect contentRect = filter.contentRect;
    double scale = (double)filter.pointPixelScale;

    size_t width = 0, height = 0;
    if (!pixelExtent(contentRect.size.width, contentRect.size.height, scale, &width, &height)) {
      error = [NSString stringWithFormat:@"invalid capture extent %.1fx%.1f@%.2f",
                                         contentRect.size.width, contentRect.size.height, scale];
      [filter release];
      dispatch_semaphore_signal(done);
      return;
    }

    SCStreamConfiguration *config = [[SCStreamConfiguration alloc] init];
    config.width = width;
    config.height = height;

    BOOL wantsCrop = (w > 0 && h > 0);
    CGRect crop = CGRectZero;
    if (wantsCrop && !cropRect(x, y, w, h, scale, width, height, &crop)) {
      error = @"the requested region is empty after clamping to the window";
      [config release];
      [filter release];
      dispatch_semaphore_signal(done);
      return;
    }

    [SCScreenshotManager
        captureImageWithFilter:filter
                 configuration:config
             completionHandler:^(CGImageRef image, NSError *captureError) {
               if (image == NULL || captureError != nil) {
                 error = [NSString stringWithFormat:@"capture failed: %@",
                                                    captureError.localizedDescription ?: @"unknown"];
                 dispatch_semaphore_signal(done);
                 return;
               }
               CGImageRef encoded = image;
               CGImageRef cropped = NULL;
               if (wantsCrop) {
                 cropped = CGImageCreateWithImageInRect(image, crop);
                 if (cropped == NULL) {
                   error = @"cropping the captured image failed";
                   dispatch_semaphore_signal(done);
                   return;
                 }
                 encoded = cropped;
               }
               png = [pngFromCGImage(encoded) retain];
               if (cropped != NULL) CGImageRelease(cropped);
               if (png == nil) error = @"encoding the captured image as PNG failed";
               dispatch_semaphore_signal(done);
             }];

    [config release];
    [filter release];
  }];

  // A bounded wait: the completion chain is asynchronous, and a capture that
  // never completes must surface as a timeout rather than hold the caller.
  dispatch_time_t deadline =
      dispatch_time(DISPATCH_TIME_NOW, (int64_t)timeout_ms * NSEC_PER_MSEC);
  if (dispatch_semaphore_wait(done, deadline) != 0) {
    return failure(@"capture timed out");
  }

  if (error != nil) {
    [png release];
    return failure(error);
  }
  if (png == nil) return failure(@"capture produced no image");

  SoksakCapture out;
  out.png_len = png.length;
  out.png = malloc(out.png_len);
  memcpy(out.png, png.bytes, out.png_len);
  out.error = NULL;
  [png release];
  return out;
}

void soksakCaptureFree(SoksakCapture capture) {
  free(capture.png);
  free(capture.error);
}
