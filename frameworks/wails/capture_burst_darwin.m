#import "capture_burst_darwin.h"

#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <QuartzCore/QuartzCore.h>
#import <dlfcn.h>
#import <objc/message.h>
#import <objc/runtime.h>

static char *words(NSString *message) {
  return strdup((message != nil && message.length > 0)
      ? message.UTF8String
      : "the burst refused and said nothing; this message is missing at its source");
}

static SoksakBurst burstFailure(NSString *message) {
  SoksakBurst out = {0, NULL, 0, 0, NULL, words(message)};
  return out;
}

// Every completed frame the stream hands over, copied and encoded off the delivery queue.
//
// The stream reuses its pixel buffers once the handler returns, so a frame is copied before the
// handler ends. Encoding a PNG takes longer than one display interval, so it runs on a concurrent
// queue and the copy is what waits; the bytes waiting are what the budget bounds.
@interface SoksakBurstSink : NSObject {
 @public
  NSString *dir;
  NSString *statusKey;
  double mediaStart;
  int maxFrames;
  long long maxBytes;
  NSLock *lock;
  int taken;
  long long waiting;
  NSMutableArray<NSNumber *> *times;
  NSString *stopped;
  NSString *writeError;
  BOOL done;
  int width;
  int height;
  dispatch_group_t encoders;
  dispatch_queue_t encodeQueue;
  dispatch_semaphore_t finished;
}
@end

@implementation SoksakBurstSink

- (instancetype)init {
  self = [super init];
  if (self) {
    lock = [[NSLock alloc] init];
    times = [[NSMutableArray alloc] init];
    encoders = dispatch_group_create();
    encodeQueue = dispatch_queue_create("soksak.capture.burst.encode", DISPATCH_QUEUE_CONCURRENT);
    finished = dispatch_semaphore_create(0);
  }
  return self;
}

- (void)dealloc {
  [lock release];
  [times release];
  [dir release];
  [statusKey release];
  [stopped release];
  [writeError release];
  dispatch_release(encoders);
  dispatch_release(encodeQueue);
  dispatch_release(finished);
  [super dealloc];
}

- (void)endWith:(NSString *)reason {
  // Under the caller's lock.
  if (done) return;
  done = YES;
  if (reason != nil && stopped == nil) stopped = [reason copy];
  dispatch_semaphore_signal(finished);
}

- (void)stream:(id)stream didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer ofType:(long)type {
  if (type != 0) return;
  // Status 0 is a complete frame. The others (idle, blank, suspended, started, stopped) carry no new
  // picture and are not frames the compositor produced.
  CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, false);
  if (attachments != NULL && CFArrayGetCount(attachments) > 0) {
    CFDictionaryRef first = CFArrayGetValueAtIndex(attachments, 0);
    CFNumberRef status = CFDictionaryGetValue(first, (CFStringRef)statusKey);
    if (status != NULL) {
      int value = 0;
      CFNumberGetValue(status, kCFNumberIntType, &value);
      if (value != 0) return;
    }
  }
  CVPixelBufferRef pixels = CMSampleBufferGetImageBuffer(sampleBuffer);
  if (pixels == NULL) return;
  double stamp = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer));

  CVPixelBufferLockBaseAddress(pixels, kCVPixelBufferLock_ReadOnly);
  size_t w = CVPixelBufferGetWidth(pixels);
  size_t h = CVPixelBufferGetHeight(pixels);
  size_t stride = CVPixelBufferGetBytesPerRow(pixels);
  const unsigned char *base = CVPixelBufferGetBaseAddress(pixels);
  size_t rowBytes = w * 4;
  long long bytes = (long long)(rowBytes * h);

  [lock lock];
  if (done || base == NULL || w == 0 || h == 0) {
    [lock unlock];
    CVPixelBufferUnlockBaseAddress(pixels, kCVPixelBufferLock_ReadOnly);
    return;
  }
  if (waiting + bytes > maxBytes) {
    [self endWith:[NSString stringWithFormat:
        @"frame %d would put %lld raw bytes past the %lld byte budget before encoding caught up",
        taken, waiting + bytes, maxBytes]];
    [lock unlock];
    CVPixelBufferUnlockBaseAddress(pixels, kCVPixelBufferLock_ReadOnly);
    return;
  }
  int index = taken;
  taken += 1;
  waiting += bytes;
  width = (int)w;
  height = (int)h;
  [times addObject:@((stamp - mediaStart) * 1000.0)];
  if (taken >= maxFrames) [self endWith:nil];
  [lock unlock];

  unsigned char *copy = malloc((size_t)bytes);
  for (size_t row = 0; row < h; row++) {
    memcpy(copy + row * rowBytes, base + row * stride, rowBytes);
  }
  CVPixelBufferUnlockBaseAddress(pixels, kCVPixelBufferLock_ReadOnly);

  NSString *path = [dir stringByAppendingPathComponent:[NSString stringWithFormat:@"f%04d.png", index]];
  dispatch_group_async(encoders, encodeQueue, ^{
    CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGDataProviderRef provider = CGDataProviderCreateWithData(NULL, copy, (size_t)bytes, NULL);
    CGImageRef image = CGImageCreate(w, h, 8, 32, rowBytes, space,
                                     kCGBitmapByteOrder32Little | kCGImageAlphaNoneSkipFirst,
                                     provider, NULL, false, kCGRenderingIntentDefault);
    NSString *problem = nil;
    if (image == NULL) {
      problem = [NSString stringWithFormat:@"frame %d could not be read as an image", index];
    } else {
      NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithCGImage:image];
      NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
      [rep release];
      NSError *writeFailure = nil;
      if (png == nil) {
        problem = [NSString stringWithFormat:@"frame %d could not be encoded as PNG", index];
      } else if (![png writeToFile:path options:NSDataWritingAtomic error:&writeFailure]) {
        problem = [NSString stringWithFormat:@"frame %d could not be written: %@", index,
                   writeFailure.localizedDescription ?: @"unknown"];
      }
      CGImageRelease(image);
    }
    CGDataProviderRelease(provider);
    CGColorSpaceRelease(space);
    free(copy);
    [lock lock];
    waiting -= bytes;
    if (problem != nil && writeError == nil) writeError = [problem copy];
    [lock unlock];
  });
}

@end

SoksakBurst soksakCaptureBurst(void *nsWindow, double x, double y, double w, double h,
                               int duration_ms, int max_frames, int interval_ms,
                               long long max_bytes, const char *dir, int timeout_ms) {
  if (nsWindow == NULL) return burstFailure(@"burst received a nil window");
  if (dir == NULL || dir[0] == '\0') return burstFailure(@"burst received no directory");
  if (@available(macOS 14.4, *)) {
  } else {
    return burstFailure(@"window burst requires macOS 14.4 or newer");
  }

  static void *screenCaptureKit = NULL;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    screenCaptureKit = dlopen(
        "/System/Library/Frameworks/ScreenCaptureKit.framework/ScreenCaptureKit",
        RTLD_LAZY | RTLD_LOCAL);
    if (screenCaptureKit != NULL) {
      // The stream checks its output against the protocol, and the protocol is only known once the
      // framework is loaded. The class gains it here, once.
      Protocol *output = objc_getProtocol("SCStreamOutput");
      if (output != NULL) class_addProtocol([SoksakBurstSink class], output);
    }
  });
  if (screenCaptureKit == NULL) return burstFailure(@"ScreenCaptureKit could not be loaded");

  Class shareableContentClass = NSClassFromString(@"SCShareableContent");
  Class contentFilterClass = NSClassFromString(@"SCContentFilter");
  Class streamConfigurationClass = NSClassFromString(@"SCStreamConfiguration");
  Class streamClass = NSClassFromString(@"SCStream");
  NSString *const *statusKeyPointer = dlsym(screenCaptureKit, "SCStreamFrameInfoStatus");
  if (shareableContentClass == Nil || contentFilterClass == Nil ||
      streamConfigurationClass == Nil || streamClass == Nil || statusKeyPointer == NULL) {
    return burstFailure(@"ScreenCaptureKit streaming is unavailable on this system");
  }

  NSError *dirFailure = nil;
  NSString *directory = [NSString stringWithUTF8String:dir];
  if (![[NSFileManager defaultManager] createDirectoryAtPath:directory
                                 withIntermediateDirectories:YES
                                                  attributes:nil
                                                       error:&dirFailure]) {
    return burstFailure([NSString stringWithFormat:@"the burst directory could not be created: %@",
                         dirFailure.localizedDescription ?: @"unknown"]);
  }

  NSWindow *window = (NSWindow *)nsWindow;
  __block CGWindowID target = 0;
  if ([NSThread isMainThread]) {
    target = (CGWindowID)window.windowNumber;
  } else {
    dispatch_sync(dispatch_get_main_queue(), ^{
      target = (CGWindowID)window.windowNumber;
    });
  }
  if (target == 0) return burstFailure(@"the window has no window number yet");

  SoksakBurstSink *sink = [[SoksakBurstSink alloc] init];
  sink->dir = [directory copy];
  sink->statusKey = [*statusKeyPointer copy];
  sink->maxFrames = max_frames;
  sink->maxBytes = max_bytes;

  dispatch_semaphore_t started = dispatch_semaphore_create(0);
  dispatch_queue_t delivery = dispatch_queue_create("soksak.capture.burst.frames", DISPATCH_QUEUE_SERIAL);
  __block id stream = nil;
  __block NSString *error = nil;

  SEL shareableContentSelector =
      NSSelectorFromString(@"getCurrentProcessShareableContentWithCompletionHandler:");
  void (^shareableContentCompletion)(id, NSError *) = ^(id content, NSError *contentError) {
    if (content == nil || contentError != nil) {
      error = [[NSString stringWithFormat:@"shareable content unavailable: %@",
                                          contentError.localizedDescription ?: @"unknown"] retain];
      dispatch_semaphore_signal(started);
      return;
    }
    id match = nil;
    for (id candidate in [content valueForKey:@"windows"]) {
      if ([[candidate valueForKey:@"windowID"] unsignedIntValue] == target) {
        match = candidate;
        break;
      }
    }
    if (match == nil) {
      error = [[NSString stringWithFormat:@"window %u is not in this process's shareable content",
                                          target] retain];
      dispatch_semaphore_signal(started);
      return;
    }

    id filter = [[contentFilterClass alloc]
        performSelector:NSSelectorFromString(@"initWithDesktopIndependentWindow:")
             withObject:match];
    CGRect contentRect = [[filter valueForKey:@"contentRect"] rectValue];
    double scale = [[filter valueForKey:@"pointPixelScale"] doubleValue];
    if (!(contentRect.size.width > 0 && contentRect.size.height > 0 && scale > 0)) {
      error = [[NSString stringWithFormat:@"invalid capture extent %.1fx%.1f@%.2f",
                                          contentRect.size.width, contentRect.size.height, scale] retain];
      [filter release];
      dispatch_semaphore_signal(started);
      return;
    }

    // The region is clamped into the window in points; the stream scales its output to the
    // region's own pixel extent, so a crop is captured at native resolution and nothing else.
    CGRect source = CGRectMake(0, 0, contentRect.size.width, contentRect.size.height);
    if (w > 0 && h > 0) {
      double x0 = fmin(fmax(x, 0.0), contentRect.size.width);
      double y0 = fmin(fmax(y, 0.0), contentRect.size.height);
      double x1 = fmin(fmax(x + w, 0.0), contentRect.size.width);
      double y1 = fmin(fmax(y + h, 0.0), contentRect.size.height);
      if (x1 - x0 < 1.0 || y1 - y0 < 1.0) {
        error = [@"the requested region is empty after clamping to the window" retain];
        [filter release];
        dispatch_semaphore_signal(started);
        return;
      }
      source = CGRectMake(x0, y0, x1 - x0, y1 - y0);
    }

    id config = [[streamConfigurationClass alloc] init];
    // A configuration key this system's ScreenCaptureKit does not know raises, and an exception
    // on this queue ends the application: the first burst did, on colorSpaceName. It is answered
    // as a refusal instead.
    @try {
    [config setValue:@((size_t)llround(source.size.width * scale)) forKey:@"width"];
    [config setValue:@((size_t)llround(source.size.height * scale)) forKey:@"height"];
    [config setValue:[NSValue valueWithRect:NSRectFromCGRect(source)] forKey:@"sourceRect"];
    [config setValue:@(kCVPixelFormatType_32BGRA) forKey:@"pixelFormat"];
    // A CF-typed property is not key-value coding compliant; the setter is called by name.
    ((void (*)(id, SEL, CFStringRef))objc_msgSend)(
        config, NSSelectorFromString(@"setColorSpaceName:"), kCGColorSpaceSRGB);
    [config setValue:@NO forKey:@"showsCursor"];
    [config setValue:@8 forKey:@"queueDepth"];
    CMTime least = interval_ms > 0 ? CMTimeMake(interval_ms, 1000) : CMTimeMake(1, 240);
    ((void (*)(id, SEL, CMTime))objc_msgSend)(
        config, NSSelectorFromString(@"setMinimumFrameInterval:"), least);
    } @catch (NSException *raised) {
      error = [[NSString stringWithFormat:@"the stream configuration refused a setting: %@",
                                          raised.reason ?: raised.name] retain];
      [config release];
      [filter release];
      dispatch_semaphore_signal(started);
      return;
    }

    stream = ((id (*)(id, SEL, id, id, id))objc_msgSend)(
        [streamClass alloc], NSSelectorFromString(@"initWithFilter:configuration:delegate:"),
        filter, config, nil);
    [config release];
    [filter release];
    if (stream == nil) {
      error = [@"the capture stream could not be created" retain];
      dispatch_semaphore_signal(started);
      return;
    }
    NSError *outputFailure = nil;
    BOOL added = ((BOOL (*)(id, SEL, id, long, dispatch_queue_t, NSError **))objc_msgSend)(
        stream, NSSelectorFromString(@"addStreamOutput:type:sampleHandlerQueue:error:"),
        sink, 0, delivery, &outputFailure);
    if (!added) {
      error = [[NSString stringWithFormat:@"the capture stream refused its output: %@",
                                          outputFailure.localizedDescription ?: @"unknown"] retain];
      dispatch_semaphore_signal(started);
      return;
    }
    sink->mediaStart = CACurrentMediaTime();
    void (^startCompletion)(NSError *) = ^(NSError *startFailure) {
      if (startFailure != nil) {
        error = [[NSString stringWithFormat:@"the capture stream did not start: %@",
                                            startFailure.localizedDescription] retain];
      }
      dispatch_semaphore_signal(started);
    };
    ((void (*)(id, SEL, id))objc_msgSend)(
        stream, NSSelectorFromString(@"startCaptureWithCompletionHandler:"), startCompletion);
  };
  ((void (*)(id, SEL, id))objc_msgSend)(
      shareableContentClass, shareableContentSelector, shareableContentCompletion);

  dispatch_time_t startDeadline =
      dispatch_time(DISPATCH_TIME_NOW, (int64_t)timeout_ms * NSEC_PER_MSEC);
  if (dispatch_semaphore_wait(started, startDeadline) != 0) {
    [sink->lock lock];
    [sink endWith:nil];
    [sink->lock unlock];
    if (stream != nil) {
      ((void (*)(id, SEL, id))objc_msgSend)(
          stream, NSSelectorFromString(@"stopCaptureWithCompletionHandler:"), nil);
      [stream release];
    }
    dispatch_release(delivery);
    dispatch_release(started);
    [sink release];
    return burstFailure([NSString stringWithFormat:
        @"the capture stream did not start within %dms — screen recording is granted per "
         "application identity; this identity may not have it", timeout_ms]);
  }
  if (error != nil) {
    [sink->lock lock];
    [sink endWith:nil];
    [sink->lock unlock];
    if (stream != nil) {
      ((void (*)(id, SEL, id))objc_msgSend)(
          stream, NSSelectorFromString(@"stopCaptureWithCompletionHandler:"), nil);
      [stream release];
    }
    dispatch_release(delivery);
    dispatch_release(started);
    [sink release];
    SoksakBurst out = burstFailure(error);
    [error release];
    return out;
  }

  // The burst runs until its duration or until the sink ends it (frames taken, or the budget).
  dispatch_semaphore_wait(sink->finished,
                          dispatch_time(DISPATCH_TIME_NOW, (int64_t)duration_ms * NSEC_PER_MSEC));
  [sink->lock lock];
  [sink endWith:nil];
  [sink->lock unlock];

  dispatch_semaphore_t stoppedStream = dispatch_semaphore_create(0);
  void (^stopCompletion)(NSError *) = ^(NSError *stopFailure) {
    dispatch_semaphore_signal(stoppedStream);
  };
  ((void (*)(id, SEL, id))objc_msgSend)(
      stream, NSSelectorFromString(@"stopCaptureWithCompletionHandler:"), stopCompletion);
  dispatch_semaphore_wait(stoppedStream, dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC));
  dispatch_release(stoppedStream);
  // Frames still on the delivery queue are refused by the sink (done); the encoders drain.
  dispatch_group_wait(sink->encoders, dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC));
  [stream release];
  dispatch_release(delivery);
  dispatch_release(started);

  SoksakBurst out = {0, NULL, 0, 0, NULL, NULL};
  [sink->lock lock];
  if (sink->writeError != nil) {
    out.error = words(sink->writeError);
  } else {
    out.frames = sink->taken;
    out.width = sink->width;
    out.height = sink->height;
    if (sink->taken > 0) {
      out.times_ms = malloc(sizeof(double) * (size_t)sink->taken);
      for (int i = 0; i < sink->taken; i++) out.times_ms[i] = sink->times[(NSUInteger)i].doubleValue;
    }
    if (sink->stopped != nil) out.stopped = words(sink->stopped);
  }
  [sink->lock unlock];
  [sink release];
  return out;
}

void soksakBurstFree(SoksakBurst burst) {
  free(burst.times_ms);
  free(burst.stopped);
  free(burst.error);
}
