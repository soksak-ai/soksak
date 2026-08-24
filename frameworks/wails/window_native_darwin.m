#import "window_native_darwin.h"

#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>

#include <stdlib.h>
#include <string.h>

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
  // The deepest WKWebView under the content view. The hierarchy is the
  // framework's, so it is walked rather than assumed.
  NSView *found = nil;
  NSMutableArray *pending = [NSMutableArray arrayWithObject:[window contentView]];
  while ([pending count] > 0) {
    NSView *view = [pending objectAtIndex:0];
    [pending removeObjectAtIndex:0];
    if ([view isKindOfClass:NSClassFromString(@"WKWebView")]) {
      found = view;
      break;
    }
    [pending addObjectsFromArray:[view subviews]];
  }
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
