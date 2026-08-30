#import "window_native_darwin.h"

#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <QuartzCore/QuartzCore.h>

#include <stdlib.h>
#include <string.h>

// Core chrome which has to remain visible over native provider children. It
// receives no input and uses the document's top-left coordinate direction.
@interface SoksakNativeDecorationOverlay : NSView
@end

@implementation SoksakNativeDecorationOverlay
- (NSView *)hitTest:(NSPoint)point { return nil; }
- (BOOL)isFlipped { return YES; }
@end

static SoksakNativeDecorationOverlay *soksakDecorationOverlay(NSView *content) {
  for (NSView *candidate in content.subviews) {
    if ([candidate isKindOfClass:[SoksakNativeDecorationOverlay class]]) {
      return (SoksakNativeDecorationOverlay *)candidate;
    }
  }
  SoksakNativeDecorationOverlay *overlay =
      [[SoksakNativeDecorationOverlay alloc] initWithFrame:content.bounds];
  overlay.wantsLayer = YES;
  overlay.layer.geometryFlipped = YES;
  overlay.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  [content addSubview:overlay positioned:NSWindowAbove relativeTo:nil];
  [overlay release];
  return overlay;
}

static CGPathRef soksakDecorationPath(const SoksakNativeDecoration *decoration) {
  CGMutablePathRef path = CGPathCreateMutable();
  for (int index = 0; index < decoration->commandCount; index++) {
    SoksakNativePathCommand command = decoration->commands[index];
    switch (command.op) {
      case 1:
        CGPathMoveToPoint(path, NULL, command.x1, command.y1);
        break;
      case 2:
        CGPathAddLineToPoint(path, NULL, command.x1, command.y1);
        break;
      case 3:
        CGPathAddQuadCurveToPoint(path, NULL, command.x1, command.y1,
                                  command.x2, command.y2);
        break;
      case 4:
        CGPathCloseSubpath(path);
        break;
    }
  }
  return path;
}

int soksakApplyNativeDecorations(void *nsWindow,
                                 const SoksakNativeDecoration *decorations,
                                 int count,
                                 int *applied) {
  NSWindow *window = (NSWindow *)nsWindow;
  if (window == nil || applied == NULL || count < 0) return 1;
  __block int status = 0;
  dispatch_block_t block = ^{
    NSView *content = window.contentView;
    if (content == nil) { status = 2; return; }
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    SoksakNativeDecorationOverlay *overlay = soksakDecorationOverlay(content);
    if (overlay == nil) { status = 3; [CATransaction commit]; return; }
    if (!NSEqualRects(overlay.frame, content.bounds)) overlay.frame = content.bounds;
    NSArray<CALayer *> *old = [overlay.layer.sublayers copy];
    for (CALayer *layer in old) [layer removeFromSuperlayer];
    [old release];
    CGFloat scale = window.backingScaleFactor > 0 ? window.backingScaleFactor : 1;
    for (int index = 0; index < count; index++) {
      const SoksakNativeDecoration *decoration = &decorations[index];
      CAShapeLayer *shape = [CAShapeLayer layer];
      shape.frame = overlay.bounds;
      shape.geometryFlipped = YES;
      shape.contentsScale = scale;
      shape.fillColor = nil;
      shape.strokeColor = [NSColor colorWithSRGBRed:decoration->strokeR
                                              green:decoration->strokeG
                                               blue:decoration->strokeB
                                              alpha:decoration->strokeA].CGColor;
      shape.lineWidth = decoration->strokeWidth;
      shape.lineJoin = kCALineJoinRound;
      shape.lineCap = kCALineCapButt;
      if (decoration->identifier != NULL) {
        shape.name = [NSString stringWithUTF8String:decoration->identifier];
      }
      if (decoration->dashCount > 0 && decoration->dash != NULL) {
        NSMutableArray<NSNumber *> *dash =
            [NSMutableArray arrayWithCapacity:decoration->dashCount];
        for (int dashIndex = 0; dashIndex < decoration->dashCount; dashIndex++) {
          [dash addObject:@(decoration->dash[dashIndex])];
        }
        shape.lineDashPattern = dash;
      }
      CGPathRef path = soksakDecorationPath(decoration);
      shape.path = path;
      CGPathRelease(path);
      [overlay.layer addSublayer:shape];
    }
    overlay.hidden = count == 0;
    // A provider may have added a new child since the last decoration commit.
    // Reorder only when needed; doing it unconditionally detaches the layer on
    // every geometry frame.
    if (overlay.superview != content || content.subviews.lastObject != overlay) {
      [content addSubview:overlay positioned:NSWindowAbove relativeTo:nil];
    }
    *applied = count;
    [CATransaction commit];
  };
  if ([NSThread isMainThread]) block();
  else dispatch_sync(dispatch_get_main_queue(), block);
  return status;
}

static NSView *soksakFindWebview(NSWindow *window) {
  NSView *content = window.contentView;
  if (content == nil) return nil;
  NSMutableArray *pending = [NSMutableArray arrayWithObject:content];
  while ([pending count] > 0) {
    NSView *view = [pending objectAtIndex:0];
    [pending removeObjectAtIndex:0];
    if ([view isKindOfClass:NSClassFromString(@"WKWebView")]) return view;
    [pending addObjectsFromArray:[view subviews]];
  }
  return nil;
}

extern void soksakWindowInputPointer(void *nsWindow,
                                     unsigned long long sequence,
                                     int phase,
                                     double x,
                                     double y,
                                     double atUnixMs);
extern bool soksakWindowNativeClosePointer(void *nsWindow,
                                           unsigned long long sequence,
                                           int phase,
                                           double x,
                                           double y,
                                           double atUnixMs);

void soksakOrderFrontRegardless(void *nsWindow) {
  [(NSWindow *)nsWindow orderFrontRegardless];
}

void soksakPresentCaptureOnlyWindow(void *nsWindow) {
  NSWindow *window = (NSWindow *)nsWindow;
  if (window == nil) return;
  window.animationBehavior = NSWindowAnimationBehaviorNone;
  window.hasShadow = NO;
  window.opaque = NO;
  window.alphaValue = 0.0;
  window.ignoresMouseEvents = YES;
  [window orderFrontRegardless];
}

bool soksakActivateApplication(void) {
  if (@available(macOS 14.0, *)) {
    [[NSApplication sharedApplication] activate];
    return true;
  }
  return false;
}

int soksakFrontmostProcessID(void) {
  NSRunningApplication *application = [[NSWorkspace sharedWorkspace] frontmostApplication];
  return application == nil ? 0 : application.processIdentifier;
}

char *soksakCopyWindowTitle(void *nsWindow) {
  NSString *title = [(NSWindow *)nsWindow title];
  if (title == nil) {
    return NULL;
  }
  return strdup([title UTF8String]);
}

void soksakWindowContentSize(void *nsWindow, double *width, double *height) {
  NSWindow *window = (NSWindow *)nsWindow;
  NSRect content = [window contentRectForFrameRect:[window frame]];
  *width = content.size.width;
  *height = content.size.height;
}

void soksakWebviewFrame(void *nsWindow, double *x, double *y, double *width, double *height) {
  NSWindow *window = (NSWindow *)nsWindow;
  // The hierarchy is the framework's, so it is walked rather than assumed.
  NSView *found = soksakFindWebview(window);
  if (found == nil) {
    *x = *y = *width = *height = -1;
    return;
  }
  NSRect frame = [found frame];
  *x = frame.origin.x;
  *y = frame.origin.y;
  *width = frame.size.width;
  *height = frame.size.height;
}

void soksakFitWebviewToWindow(void *nsWindow) {
  NSWindow *window = (NSWindow *)nsWindow;
  NSView *content = [window contentView];
  if (content == nil) {
    return;
  }
  // The content view first: it is the one the framework made a point small, and
  // every view under it inherits that offset through autoresizing.
  NSRect area = [window contentRectForFrameRect:[window frame]];
  [content setFrame:NSMakeRect(0, 0, area.size.width, area.size.height)];

  NSMutableArray *pending = [NSMutableArray arrayWithObject:content];
  while ([pending count] > 0) {
    NSView *view = [pending objectAtIndex:0];
    [pending removeObjectAtIndex:0];
    if ([view isKindOfClass:NSClassFromString(@"WKWebView")]) {
      [view setFrame:[[view superview] bounds]];
      continue;
    }
    [pending addObjectsFromArray:[view subviews]];
  }
}

SoksakWindowPresence soksakWindowPresence(void *nsWindow) {
    SoksakWindowPresence out = {false, false, false, false, false, 0};
    if (nsWindow == NULL) return out;
    NSWindow *window = (NSWindow *)nsWindow;
    out.visible = window.isVisible;
    out.key = window.isKeyWindow;
    out.principal = window.isMainWindow;
    out.miniaturized = window.isMiniaturized;
    // Occluded is only meaningful for a window that is on screen; AppKit reports the bit as clear
    // for a hidden window too, and reading that as "covered" would make an unopened window and a
    // covered one the same answer.
    out.occluded = window.isVisible && (window.occlusionState & NSWindowOcclusionStateVisible) == 0;
    out.alpha = window.alphaValue;
    return out;
}

static char *soksakCopyClassName(id value) {
  if (value == nil) return strdup("");
  return strdup([NSStringFromClass([value class]) UTF8String]);
}

static bool soksakResponderHasMarkedText(id responder) {
  return responder != nil &&
         [responder respondsToSelector:@selector(hasMarkedText)] &&
         [(id<NSTextInputClient>)responder hasMarkedText];
}

static SoksakWindowInputState soksakReadWindowInputState(NSWindow *window) {
  SoksakWindowInputState out = {false, false, NULL, NULL};
  if (window == nil) {
    out.inputOwner = strdup("");
    out.errorMessage = strdup("window has no native lifetime");
    return out;
  }
  id responder = window.firstResponder;
  out.windowFocused = window.isKeyWindow;
  out.marked = soksakResponderHasMarkedText(responder);
  out.inputOwner = soksakCopyClassName(responder);
  return out;
}

SoksakWindowInputState soksakWindowInputState(void *nsWindow) {
  return soksakReadWindowInputState((NSWindow *)nsWindow);
}

SoksakWindowInputState soksakSetWindowMarkedText(void *nsWindow, const char *text) {
  NSWindow *window = (NSWindow *)nsWindow;
  SoksakWindowInputState out = soksakReadWindowInputState(window);
  if (out.errorMessage != NULL) return out;

  id responder = window.firstResponder;
  if (responder == nil ||
      ![responder respondsToSelector:@selector(setMarkedText:selectedRange:replacementRange:)] ||
      ![responder respondsToSelector:@selector(unmarkText)]) {
    out.errorMessage = strdup("input owner does not implement marked text");
    return out;
  }

  NSString *marked = text == NULL ? @"" : [NSString stringWithUTF8String:text];
  if (marked.length == 0) {
    [(id<NSTextInputClient>)responder unmarkText];
  } else {
    [(id<NSTextInputClient>)responder
        setMarkedText:marked
        selectedRange:NSMakeRange(marked.length, 0)
        replacementRange:NSMakeRange(NSNotFound, 0)];
  }

  free(out.inputOwner);
  return soksakReadWindowInputState(window);
}

static SoksakNativeInputDelivery soksakNativeInputFailure(const char *message,
                                                           NSWindow *window) {
  SoksakNativeInputDelivery out = {false, false, false, NULL};
  out.windowFocused = window != nil && window.isKeyWindow;
  out.errorMessage = strdup(message);
  return out;
}

static int soksakFrontmostApplicationPID(void) {
  NSRunningApplication *frontmost = [[NSWorkspace sharedWorkspace] frontmostApplication];
  return frontmost == nil ? 0 : frontmost.processIdentifier;
}

static bool soksakForegroundPreserved(int processID, BOOL applicationActive) {
  return soksakFrontmostApplicationPID() == processID &&
         NSApp.isActive == applicationActive;
}

static NSEvent *soksakWindowMouseEvent(NSWindow *window,
                                       NSPoint location,
                                       NSEventType type,
                                       unsigned long long sequence) {
  NSEvent *event = [NSEvent mouseEventWithType:type
                                      location:location
                                 modifierFlags:0
                                     timestamp:NSProcessInfo.processInfo.systemUptime
                                  windowNumber:window.windowNumber
                                       context:nil
                                   eventNumber:(NSInteger)(sequence & 0x7fffffff)
                                    clickCount:1
                                      pressure:type == NSEventTypeLeftMouseDown ? 1.0 : 0.0];
  CGEventRef native = event.CGEvent;
  if (native != NULL) {
    CGEventSetIntegerValueField(native, kCGEventSourceUserData, (int64_t)sequence);
  }
  return event;
}

SoksakNativeInputDelivery soksakClickWindowPointer(void *nsWindow,
                                                    unsigned long long sequence,
                                                    double x,
                                                    double y) {
  NSWindow *window = (NSWindow *)nsWindow;
  if (window == nil) return soksakNativeInputFailure("window has no native lifetime", nil);
  NSView *webview = soksakFindWebview(window);
  if (webview == nil) return soksakNativeInputFailure("window has no WKWebView", window);
  NSRect bounds = webview.bounds;
  if (x < 0 || y < 0 || x >= NSWidth(bounds) || y >= NSHeight(bounds)) {
    return soksakNativeInputFailure("pointer coordinates are outside the WKWebView", window);
  }
  NSPoint local = NSMakePoint(x, webview.isFlipped ? y : NSHeight(bounds) - y);
  NSPoint location = [webview convertPoint:local toView:nil];
  NSEvent *down = soksakWindowMouseEvent(window, location, NSEventTypeLeftMouseDown, sequence);
  NSEvent *up = soksakWindowMouseEvent(window, location, NSEventTypeLeftMouseUp, sequence);
  if (down == nil || up == nil) {
    return soksakNativeInputFailure("AppKit did not create the pointer events", window);
  }
  int frontmostProcessID = soksakFrontmostApplicationPID();
  BOOL applicationActive = NSApp.isActive;
  if (!applicationActive || !window.isKeyWindow) {
    SoksakNativeInputDelivery out = soksakNativeInputFailure(
        "native WebKit input requires an already active application and key window", window);
    out.foregroundPreserved = true;
    return out;
  }
  [NSApp sendEvent:down];
  [NSApp sendEvent:up];
  bool preserved = soksakForegroundPreserved(frontmostProcessID, applicationActive);
  SoksakNativeInputDelivery out = {true, window.isKeyWindow, preserved, NULL};
  if (!preserved) {
    out.delivered = false;
    out.errorMessage = strdup("native input changed the foreground application");
  }
  return out;
}

static bool soksakKeyIdentity(NSString *key, unsigned short *code, NSString **characters) {
  if ([key isEqualToString:@"Enter"]) {
    *code = 36; *characters = @"\r";
  } else if ([key isEqualToString:@"Tab"]) {
    *code = 48; *characters = @"\t";
  } else if ([key isEqualToString:@"Escape"]) {
    *code = 53; *characters = [NSString stringWithFormat:@"%C", (unichar)0x1b];
  } else if ([key isEqualToString:@"Backspace"]) {
    *code = 51; *characters = [NSString stringWithFormat:@"%C", (unichar)0x7f];
  } else if ([key isEqualToString:@"Delete"]) {
    *code = 117; *characters = [NSString stringWithFormat:@"%C", (unichar)NSDeleteFunctionKey];
  } else if ([key isEqualToString:@"ArrowLeft"]) {
    *code = 123; *characters = [NSString stringWithFormat:@"%C", (unichar)NSLeftArrowFunctionKey];
  } else if ([key isEqualToString:@"ArrowRight"]) {
    *code = 124; *characters = [NSString stringWithFormat:@"%C", (unichar)NSRightArrowFunctionKey];
  } else if ([key isEqualToString:@"ArrowDown"]) {
    *code = 125; *characters = [NSString stringWithFormat:@"%C", (unichar)NSDownArrowFunctionKey];
  } else if ([key isEqualToString:@"ArrowUp"]) {
    *code = 126; *characters = [NSString stringWithFormat:@"%C", (unichar)NSUpArrowFunctionKey];
  } else if ([key length] == 1) {
    *code = 0; *characters = key;
  } else {
    return false;
  }
  return true;
}

SoksakNativeInputDelivery soksakPressWindowKey(void *nsWindow,
                                               unsigned long long sequence,
                                               const char *rawKey,
                                               bool ctrl,
                                               bool meta,
                                               bool shift,
                                               bool alt) {
  NSWindow *window = (NSWindow *)nsWindow;
  if (window == nil) return soksakNativeInputFailure("window has no native lifetime", nil);
  NSView *webview = soksakFindWebview(window);
  if (webview == nil) return soksakNativeInputFailure("window has no WKWebView", window);
  NSString *key = rawKey == NULL ? nil : [NSString stringWithUTF8String:rawKey];
  unsigned short code = 0;
  NSString *characters = nil;
  if (key == nil || !soksakKeyIdentity(key, &code, &characters)) {
    return soksakNativeInputFailure("key must be one character or a supported named key", window);
  }
  int frontmostProcessID = soksakFrontmostApplicationPID();
  BOOL applicationActive = NSApp.isActive;
  if (!applicationActive || !window.isKeyWindow) {
    SoksakNativeInputDelivery out = soksakNativeInputFailure(
        "native WebKit input requires an already active application and key window", window);
    out.foregroundPreserved = true;
    return out;
  }
  NSResponder *responder = window.firstResponder;
  if (![responder isKindOfClass:[NSView class]] ||
      ![(NSView *)responder isDescendantOf:webview]) {
    SoksakNativeInputDelivery out = soksakNativeInputFailure(
        "WKWebView has no hit-tested native input responder", window);
    out.foregroundPreserved = soksakForegroundPreserved(frontmostProcessID, applicationActive);
    return out;
  }
  NSEventModifierFlags flags = 0;
  if (ctrl) flags |= NSEventModifierFlagControl;
  if (meta) flags |= NSEventModifierFlagCommand;
  if (shift) flags |= NSEventModifierFlagShift;
  if (alt) flags |= NSEventModifierFlagOption;
  NSEvent *down = [NSEvent keyEventWithType:NSEventTypeKeyDown
                                    location:NSZeroPoint
                               modifierFlags:flags
                                   timestamp:NSProcessInfo.processInfo.systemUptime
                                windowNumber:window.windowNumber
                                     context:nil
                                  characters:characters
                 charactersIgnoringModifiers:characters
                                   isARepeat:NO
                                     keyCode:code];
  NSEvent *up = [NSEvent keyEventWithType:NSEventTypeKeyUp
                                  location:NSZeroPoint
                             modifierFlags:flags
                                 timestamp:NSProcessInfo.processInfo.systemUptime
                              windowNumber:window.windowNumber
                                   context:nil
                                characters:characters
               charactersIgnoringModifiers:characters
                                 isARepeat:NO
                                   keyCode:code];
  if (down == nil || up == nil) {
    SoksakNativeInputDelivery out = soksakNativeInputFailure(
        "AppKit did not create the keyboard events", window);
    out.foregroundPreserved = soksakForegroundPreserved(frontmostProcessID, applicationActive);
    return out;
  }
  [NSApp sendEvent:down];
  [NSApp sendEvent:up];
  bool preserved = soksakForegroundPreserved(frontmostProcessID, applicationActive);
  SoksakNativeInputDelivery out = {true, window.isKeyWindow, preserved, NULL};
  if (!preserved) {
    out.delivered = false;
    out.errorMessage = strdup("native input changed the foreground application");
  }
  return out;
}

void *soksakInstallWindowInputMonitor(void) {
  __block unsigned long long sequence = 0;
  __block unsigned long long gesture = 0;
  id token = [NSEvent
      addLocalMonitorForEventsMatchingMask:(NSEventMaskLeftMouseDown | NSEventMaskLeftMouseUp)
      handler:^NSEvent *(NSEvent *event) {
        NSWindow *window = event.window;
        NSView *content = window.contentView;
        if (window == nil || content == nil) return event;

        int phase = event.type == NSEventTypeLeftMouseDown ? 0 : 1;
        if (phase == 0 || gesture == 0) {
          CGEventRef native = event.CGEvent;
          int64_t posted = native == NULL ? 0
              : CGEventGetIntegerValueField(native, kCGEventSourceUserData);
          gesture = posted > 0 ? (unsigned long long)posted : ++sequence;
        }
        NSPoint local = [content convertPoint:event.locationInWindow fromView:nil];
        double top = content.isFlipped ? local.y : NSHeight(content.bounds) - local.y;
        double bootEpochMs = NSDate.date.timeIntervalSince1970 * 1000.0
                           - NSProcessInfo.processInfo.systemUptime * 1000.0;
        double atUnixMs = bootEpochMs + event.timestamp * 1000.0;
        NSButton *close = [window standardWindowButton:NSWindowCloseButton];
        NSPoint closePoint = close == nil
            ? NSZeroPoint
            : [close convertPoint:event.locationInWindow fromView:nil];
        BOOL nativeClose = close != nil && close.isEnabled && !close.isHidden &&
            NSPointInRect(closePoint, close.bounds);
        BOOL consumed = nativeClose && soksakWindowNativeClosePointer(
            (__bridge void *)window, gesture, phase, local.x, top, atUnixMs);
        if (!nativeClose) {
          soksakWindowInputPointer((__bridge void *)window, gesture, phase,
                                   local.x, top, atUnixMs);
        }
        if (phase == 1) gesture = 0;
        return consumed ? nil : event;
      }];
  return (__bridge void *)token;
}

void soksakRemoveWindowInputMonitor(void *token) {
  if (token == NULL) return;
  [NSEvent removeMonitor:(__bridge id)token];
}

SoksakNativeCloseStatus soksakNativeCloseStatus(void *nsWindow) {
  SoksakNativeCloseStatus out = {false, false, false, false, 0, 0, 0, 0};
  NSWindow *window = (NSWindow *)nsWindow;
  if (window == nil) return out;
  NSButton *button = [window standardWindowButton:NSWindowCloseButton];
  out.windowVisible = window.isVisible;
  if (button == nil) return out;
  NSRect frame = [button convertRect:button.bounds toView:nil];
  out.present = true;
  out.enabled = button.isEnabled;
  out.visible = !button.isHidden;
  out.x = frame.origin.x;
  out.y = frame.origin.y;
  out.width = frame.size.width;
  out.height = frame.size.height;
  return out;
}

static NSEvent *soksakCloseMouseEvent(NSWindow *window, NSButton *button,
                                      NSEventType type, unsigned long long sequence) {
  NSPoint centre = NSMakePoint(NSMidX(button.bounds), NSMidY(button.bounds));
  NSPoint location = [button convertPoint:centre toView:nil];
  return soksakWindowMouseEvent(window, location, type, sequence);
}

bool soksakClickNativeClose(void *nsWindow, unsigned long long sequence) {
  NSWindow *window = (NSWindow *)nsWindow;
  if (window == nil) return false;
  NSButton *button = [window standardWindowButton:NSWindowCloseButton];
  if (button == nil || !button.isEnabled || button.isHidden) return false;
  NSEvent *down = soksakCloseMouseEvent(window, button, NSEventTypeLeftMouseDown, sequence);
  NSEvent *up = soksakCloseMouseEvent(window, button, NSEventTypeLeftMouseUp, sequence);
  if (down == nil || up == nil) {
    return false;
  }
  [NSApp postEvent:down atStart:NO];
  [NSApp postEvent:up atStart:NO];
  return true;
}
