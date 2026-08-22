//go:build windows

package wails

import (
	"fmt"
	"syscall"
	"unsafe"

	"github.com/soksak-ai/soksak-core/core/i18n"
	"github.com/wailsapp/wails/v3/pkg/w32"
)

const pwRenderFullContent = 2

var (
	captureUser32             = syscall.NewLazyDLL("user32.dll")
	captureGDI32              = syscall.NewLazyDLL("gdi32.dll")
	capturePrintWindow        = captureUser32.NewProc("PrintWindow")
	captureCreateCompatibleDC = captureGDI32.NewProc("CreateCompatibleDC")
)

type windowsCapturedFrame struct {
	frame    nativeFrame
	dc       w32.HDC
	bitmap   w32.HBITMAP
	previous w32.HGDIOBJ
}

func (frame *windowsCapturedFrame) Frame() nativeFrame { return frame.frame }
func (frame *windowsCapturedFrame) Release() {
	if frame.previous != 0 {
		w32.SelectObject(frame.dc, frame.previous)
	}
	if frame.bitmap != 0 {
		w32.DeleteObject(w32.HGDIOBJ(frame.bitmap))
	}
	if frame.dc != 0 {
		w32.DeleteDC(frame.dc)
	}
}

func CaptureWindow(window unsafe.Pointer, rect Rect) ([]byte, error) {
	return captureNativeFrame(window, rect, captureWindowsFrame)
}

func CaptureDocument(window unsafe.Pointer, rect Rect) ([]byte, error) {
	return CaptureWindow(window, rect)
}

func captureWindowsFrame(window unsafe.Pointer) (capturedFrame, float64, error) {
	hwnd := w32.HWND(uintptr(window))
	extent := w32.GetWindowRect(hwnd)
	width := int(extent.Right - extent.Left)
	height := int(extent.Bottom - extent.Top)
	if width < 1 || height < 1 {
		return nil, 0, i18n.Errorf("wails.capture.windowsEmptyExtent", nil)
	}

	rawDC, _, dcErr := captureCreateCompatibleDC.Call(0)
	if rawDC == 0 {
		return nil, 0, i18n.Errorf("wails.capture.windowsDC", map[string]string{"reason": dcErr.Error()})
	}
	dc := w32.HDC(rawDC)
	frame := &windowsCapturedFrame{dc: dc}
	info := w32.BITMAPINFO{BmiHeader: w32.BITMAPINFOHEADER{
		BiSize: uint32(unsafe.Sizeof(w32.BITMAPINFOHEADER{})), BiWidth: int32(width),
		BiHeight: -int32(height), BiPlanes: 1, BiBitCount: 32,
		BiCompression: w32.BI_RGB, BiSizeImage: uint32(width * height * 4),
	}}
	var bits unsafe.Pointer
	frame.bitmap = w32.CreateDIBSection(dc, &info, w32.DIB_RGB_COLORS, &bits, 0, 0)
	if frame.bitmap == 0 || bits == nil {
		frame.Release()
		return nil, 0, i18n.Errorf("wails.capture.windowsBitmap", nil)
	}
	frame.previous = w32.SelectObject(dc, w32.HGDIOBJ(frame.bitmap))
	if frame.previous == 0 {
		frame.Release()
		return nil, 0, i18n.Errorf("wails.capture.windowsSelectBitmap", nil)
	}
	rendered, _, callErr := capturePrintWindow.Call(uintptr(hwnd), uintptr(dc), pwRenderFullContent)
	if rendered == 0 {
		frame.Release()
		return nil, 0, i18n.Errorf("wails.capture.windowsPrint", map[string]string{"reason": callErr.Error()})
	}

	byteCount := width * height * 4
	pixels := unsafe.Slice((*byte)(bits), byteCount)
	frame.frame = nativeFrame{Width: width, Height: height, Stride: width * 4, BGRA: append([]byte(nil), pixels...)}
	dpi := float64(w32.GetDpiForWindow(hwnd))
	if dpi <= 0 {
		dpi = 96
	}
	return frame, dpi / 96, nil
}
