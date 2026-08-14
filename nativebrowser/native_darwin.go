//go:build darwin

package nativebrowser

/*
#cgo CFLAGS: -x objective-c -fblocks -Wno-deprecated-declarations
#cgo LDFLAGS: -framework Cocoa -framework WebKit

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#include <stdlib.h>

typedef struct {
    double x;
    double y;
    double width;
    double height;
} BrowserFrame;

static void runOnMainSync(void (^block)(void)) {
    if ([NSThread isMainThread]) {
        block();
    } else {
        dispatch_sync(dispatch_get_main_queue(), block);
    }
}

static NSRect browserRect(NSView *contentView, BrowserFrame frame) {
    CGFloat y = NSHeight(contentView.bounds) - frame.y - frame.height;
    return NSMakeRect(frame.x, y, frame.width, frame.height);
}

static void* createBrowser(void *windowPointer, const char *rawURL, BrowserFrame frame) {
    __block WKWebView *browser = nil;
    NSString *urlString = [NSString stringWithUTF8String:rawURL];
    runOnMainSync(^{
        NSWindow *window = (NSWindow *)windowPointer;
        NSView *contentView = window.contentView;
        WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
        browser = [[WKWebView alloc] initWithFrame:browserRect(contentView, frame) configuration:configuration];
        browser.autoresizingMask = NSViewNotSizable;
        browser.hidden = NO;
        [contentView addSubview:browser positioned:NSWindowAbove relativeTo:nil];
        NSURL *url = [NSURL URLWithString:urlString];
        if (url != nil) {
            [browser loadRequest:[NSURLRequest requestWithURL:url]];
        }
        [configuration release];
    });
    return browser;
}

static void destroyBrowser(void *browserPointer) {
    if (browserPointer == NULL) return;
    runOnMainSync(^{
        WKWebView *browser = (WKWebView *)browserPointer;
        [browser stopLoading];
        [browser removeFromSuperview];
        [browser release];
    });
}

static void setBrowserFrame(void *browserPointer, BrowserFrame frame) {
    runOnMainSync(^{
        WKWebView *browser = (WKWebView *)browserPointer;
        browser.frame = browserRect(browser.superview, frame);
    });
}

static BrowserFrame getBrowserFrame(void *browserPointer) {
    __block BrowserFrame result = {0, 0, 0, 0};
    runOnMainSync(^{
        WKWebView *browser = (WKWebView *)browserPointer;
        NSRect frame = browser.frame;
        result.x = frame.origin.x;
        result.y = NSHeight(browser.superview.bounds) - NSMaxY(frame);
        result.width = frame.size.width;
        result.height = frame.size.height;
    });
    return result;
}

static int navigateBrowser(void *browserPointer, const char *rawURL) {
    __block int result = 0;
    NSString *urlString = [NSString stringWithUTF8String:rawURL];
    runOnMainSync(^{
        NSURL *url = [NSURL URLWithString:urlString];
        if (url == nil) {
            result = 1;
            return;
        }
        [(WKWebView *)browserPointer loadRequest:[NSURLRequest requestWithURL:url]];
    });
    return result;
}
*/
import "C"

import (
	"fmt"
	"unsafe"
)

func cFrame(frame Frame) C.BrowserFrame {
	return C.BrowserFrame{x: C.double(frame.X), y: C.double(frame.Y), width: C.double(frame.Width), height: C.double(frame.Height)}
}

func createNativeBrowser(window unsafe.Pointer, url string, frame Frame) (unsafe.Pointer, error) {
	rawURL := C.CString(url)
	defer C.free(unsafe.Pointer(rawURL))
	browser := C.createBrowser(window, rawURL, cFrame(frame))
	if browser == nil {
		return nil, fmt.Errorf("create native WKWebView")
	}
	return browser, nil
}

func destroyNativeBrowser(browser unsafe.Pointer) {
	C.destroyBrowser(browser)
}

func setNativeBrowserFrame(browser unsafe.Pointer, frame Frame) {
	C.setBrowserFrame(browser, cFrame(frame))
}

func nativeBrowserFrame(browser unsafe.Pointer) Frame {
	frame := C.getBrowserFrame(browser)
	return Frame{X: float64(frame.x), Y: float64(frame.y), Width: float64(frame.width), Height: float64(frame.height)}
}

func navigateNativeBrowser(browser unsafe.Pointer, url string) error {
	rawURL := C.CString(url)
	defer C.free(unsafe.Pointer(rawURL))
	if C.navigateBrowser(browser, rawURL) != 0 {
		return fmt.Errorf("browser URL is invalid: %s", url)
	}
	return nil
}
