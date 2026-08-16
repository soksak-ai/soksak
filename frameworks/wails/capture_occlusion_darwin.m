#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

#include "capture_occlusion_darwin.h"

// Occlusion detection is what stops a covered window from drawing.
//
// A capture reads the window's own pixels rather than the screen, so it works
// while the window is behind another application — but a throttled web view has
// not drawn since it was covered, and the capture then holds a frame from
// whenever that was. Nothing in the image says which.
//
// The switch is a private AppKit selector on WKWebView. Private, so it is
// looked up by name and skipped where it is not there: a build on an OS that
// dropped it captures a stale frame instead of failing to launch.
static SEL occlusionSelector(void) {
    return NSSelectorFromString(@"_setWindowOcclusionDetectionEnabled:");
}

// Every web view under one view, the application's own and every native
// surface's. They are siblings in the window's content view, so one walk
// reaches all of them and this file names no surface kind.
static void collectWebViews(NSView *view, NSMutableArray<WKWebView *> *found) {
    if (view == nil) return;
    if ([view isKindOfClass:[WKWebView class]]) [found addObject:(WKWebView *)view];
    for (NSView *child in view.subviews) collectWebViews(child, found);
}

int soksakSetWindowOcclusionDetection(void *windowPointer, int enabled) {
    if (windowPointer == NULL) return 0;
    __block int applied = 0;
    dispatch_block_t block = ^{
        NSView *content = ((NSWindow *)windowPointer).contentView;
        if (content == nil) return;
        NSMutableArray<WKWebView *> *views = [NSMutableArray array];
        collectWebViews(content, views);

        SEL selector = occlusionSelector();
        for (WKWebView *view in views) {
            if (![view respondsToSelector:selector]) continue;
            // Typed through an IMP rather than performSelector:, which cannot
            // pass a BOOL: it would send the pointer value of the argument and
            // every call would read as YES.
            void (*setter)(id, SEL, BOOL) = (void (*)(id, SEL, BOOL))[view methodForSelector:selector];
            setter(view, selector, enabled != 0);
            applied++;
        }
    };
    if ([NSThread isMainThread]) block(); else dispatch_sync(dispatch_get_main_queue(), block);
    return applied;
}
