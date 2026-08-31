import { describe, expect, it, vi } from "vitest";
import { paneChromeExtentPx } from "./paneChrome";

const rect = (top: number, height: number): DOMRect =>
  ({ top, bottom: top + height, height, left: 0, right: 100, width: 100 } as DOMRect);

describe("pane chrome geometry", () => {
  it("uses the public native surface rect to preserve provider chrome", () => {
    const container = document.createElement("div");
    const pane = document.createElement("div");
    pane.dataset.pane = "browser";
    const surface = document.createElement("div");
    surface.dataset.nativeSurface = "webview";
    surface.dataset.nativeSurfaceId = "webview.test";
    pane.append(surface);
    container.append(pane);
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(rect(100, 255.5));
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(rect(164, 167.5));

    expect(paneChromeExtentPx(container, 57)).toBeCloseTo(88, 10);
  });

  it("keeps the shared fallback when no visible native surface is declared", () => {
    const container = document.createElement("div");
    expect(paneChromeExtentPx(container, 57)).toBe(57);
  });

  it("includes both pane insets in the minimum body requirement", () => {
    const container = document.createElement("div");
    expect(paneChromeExtentPx(container, 57, 5)).toBe(67);
  });

  it("finds a public surface declaration inside an open shadow root", () => {
    const container = document.createElement("div");
    const pane = document.createElement("div");
    pane.dataset.pane = "browser";
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const surface = document.createElement("div");
    surface.dataset.nativeSurface = "webview";
    surface.dataset.nativeSurfaceId = "webview.shadow";
    shadow.append(surface);
    pane.append(host);
    container.append(pane);
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(rect(100, 255.5));
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(rect(164, 167.5));

    expect(paneChromeExtentPx(container, 57)).toBeCloseTo(88, 10);
  });

  it("includes public surface chrome when the native declaration is outside the light DOM", () => {
    const container = document.createElement("div");
    const pane = document.createElement("div");
    pane.dataset.pane = "browser";
    const host = document.createElement("div");
    host.dataset.node = "surface";
    const chrome = document.createElement("div");
    chrome.dataset.node = "chrome";
    host.append(chrome);
    pane.append(host);
    container.append(pane);
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(rect(100, 255.5));
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(rect(133, 198.5));
    vi.spyOn(chrome, "getBoundingClientRect").mockReturnValue(rect(133, 31));

    expect(paneChromeExtentPx(container, 57)).toBeCloseTo(88, 10);
  });

  it("reads sibling public chrome for a surface host", () => {
    const container = document.createElement("div");
    const pane = document.createElement("div");
    pane.dataset.pane = "browser";
    const view = document.createElement("div");
    const chrome = document.createElement("div");
    chrome.dataset.node = "chrome";
    const host = document.createElement("div");
    host.dataset.node = "surface";
    view.append(chrome, host);
    pane.append(view);
    container.append(pane);
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(rect(100, 255.5));
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(rect(133, 198.5));
    vi.spyOn(chrome, "getBoundingClientRect").mockReturnValue(rect(133, 31));

    expect(paneChromeExtentPx(container, 57)).toBeCloseTo(88, 10);
  });
});
