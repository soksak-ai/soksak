#import "window_native_darwin.h"

#import <AppKit/AppKit.h>

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
