#import "window_native_darwin.h"

#import <AppKit/AppKit.h>

#include <string.h>

void soksakOrderFrontRegardless(void *nsWindow) {
  [(NSWindow *)nsWindow orderFrontRegardless];
}

bool soksakActivateApplication(void) {
  if (@available(macOS 14.0, *)) {
    [[NSApplication sharedApplication] activate];
    return true;
  }
  return false;
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
