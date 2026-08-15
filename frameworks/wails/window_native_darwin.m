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
