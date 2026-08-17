#import "capture_darwin.h"

#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <WebKit/WebKit.h>

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
    // What a timeout here has meant every time it has happened: the screen recording
    // permission is granted per application identity, and this identity does not have it.
    // Measured 2026-08-17 — the same binary, the same window, the same code: with the
    // installation's own identifier the capture answered in 0.3s, and with any other one it
    // waited out the deadline and said only that it had. macOS asks for the permission by
    // showing a panel to a foreground application; a gate's application is launched by a
    // test and is not one, so nothing is ever asked and nothing is ever granted.
    return failure([NSString stringWithFormat:
        @"capture timed out after %.0fms — this usually means screen recording is not "
         "permitted for this application identity. The permission is per identity: grant it "
         "in System Settings > Privacy & Security > Screen Recording, or run under an "
         "identity that already has it.", (double)timeout_ms]);
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

// The web view that draws this window's document: the first one found in the view tree.
//
// A window holds one document web view and, on top of it, one child per native surface. The
// document's is the one that was there first and the one every child is placed over, so the tree is
// walked breadth-first and the first hit is it.
static WKWebView *documentWebView(NSView *root) {
  if (root == nil) return nil;
  for (NSView *child in root.subviews) {
    if ([child isKindOfClass:[WKWebView class]]) return (WKWebView *)child;
  }
  for (NSView *child in root.subviews) {
    WKWebView *found = documentWebView(child);
    if (found != nil) return found;
  }
  return nil;
}

SoksakCapture soksakCaptureDocument(void *nsWindow, double x, double y, double w,
                                    double h, int timeout_ms) {
  if (nsWindow == NULL) return failure(@"capture received a nil window");

  NSWindow *window = (NSWindow *)nsWindow;
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  __block NSData *png = nil;
  __block NSString *error = nil;

  dispatch_block_t ask = ^{
    WKWebView *view = documentWebView(window.contentView);
    if (view == nil) {
      error = @"this window draws its document in no web view";
      dispatch_semaphore_signal(done);
      return;
    }
    WKSnapshotConfiguration *config = [[WKSnapshotConfiguration alloc] init];
    // The rect is in the web view's own coordinates, which are the document's — the same space the
    // caller crops in. A zero-sized rect asks for the whole view.
    if (w > 0 && h > 0) {
      config.rect = CGRectMake(x, y, w, h);
    }
    [view takeSnapshotWithConfiguration:config
                      completionHandler:^(NSImage *image, NSError *snapshotError) {
                        if (image == nil || snapshotError != nil) {
                          error = [NSString
                              stringWithFormat:@"the web view refused a snapshot: %@",
                                               snapshotError.localizedDescription ?: @"unknown"];
                          dispatch_semaphore_signal(done);
                          return;
                        }
                        CGImageRef cg = [image CGImageForProposedRect:NULL context:nil hints:nil];
                        if (cg == NULL) {
                          error = @"the snapshot carried no image";
                          dispatch_semaphore_signal(done);
                          return;
                        }
                        png = [pngFromCGImage(cg) retain];
                        dispatch_semaphore_signal(done);
                      }];
    [config release];
  };
  if ([NSThread isMainThread]) ask(); else dispatch_async(dispatch_get_main_queue(), ask);

  dispatch_time_t deadline =
      dispatch_time(DISPATCH_TIME_NOW, (int64_t)timeout_ms * NSEC_PER_MSEC);
  if (dispatch_semaphore_wait(done, deadline) != 0) {
    return failure(@"the web view did not answer with a snapshot in time");
  }
  if (error != nil) {
    [png release];
    return failure(error);
  }
  if (png == nil || png.length == 0) {
    return failure(@"the web view answered with an empty snapshot");
  }
  SoksakCapture out = {malloc(png.length), png.length, NULL};
  memcpy(out.png, png.bytes, png.length);
  [png release];
  return out;
}
