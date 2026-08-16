import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./webviewLabels", () => ({ currentWindowLabel: () => "win-a" }));

import {
  orphanSurfaceLabels,
  surfaceLabel,
  surfaceLabelIn,
  surfaceLabelOfView,
  surfaceLabelPrefixIn,
  viewIdFromSurfaceLabel,
} from "./surfaceLabels";

describe("the shape", () => {
  it("puts the window between the kind and the view", () => {
    expect(surfaceLabelIn("browser", "win-a", "tab-1")).toBe("browser.win-a.tab-1");
    expect(surfaceLabel("browser", "tab-1")).toBe("browser.win-a.tab-1");
    expect(surfaceLabelPrefixIn("browser", "win-a")).toBe("browser.win-a.");
  });

  // Two windows showing the same view id must not produce one label. Without the window part they
  // do, and the second window addresses the first window's surface.
  it("separates two windows holding the same view id", () => {
    expect(surfaceLabelIn("browser", "win-a", "tab-1")).not.toBe(
      surfaceLabelIn("browser", "win-b", "tab-1"),
    );
  });
});

describe("reading a label back", () => {
  it("answers the view for this window", () => {
    expect(viewIdFromSurfaceLabel("browser.win-a.tab-1")).toBe("tab-1");
  });

  it("answers nothing for another window", () => {
    expect(viewIdFromSurfaceLabel("browser.win-b.tab-1")).toBeNull();
  });

  // The point of the module: a kind this core has never been told about still reads back. A reader
  // that matched on a known kind would answer null and the surface would have no view.
  it("reads a kind it has never been told about", () => {
    expect(viewIdFromSurfaceLabel("video.win-a.tab-9")).toBe("tab-9");
    expect(viewIdFromSurfaceLabel("anything-at-all.win-a.tab-9")).toBe("tab-9");
  });

  it("refuses a label with no kind in front of the window", () => {
    expect(viewIdFromSurfaceLabel("win-a-tab-1")).toBeNull();
  });
});

describe("a surface whose window is gone", () => {
  it("is named when no live window matches", () => {
    expect(orphanSurfaceLabels(["browser.win-dead.tab-1"], ["win-a", "main"])).toEqual([
      "browser.win-dead.tab-1",
    ]);
  });

  it("is not named while its window is alive", () => {
    expect(orphanSurfaceLabels(["browser.win-a.tab-1"], ["win-a"])).toEqual([]);
  });
});

describe("reading the declaration", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  // The plugin wrote the label. Rebuilding it here needs the kind, and a rebuild agrees with itself
  // about a label the plugin never used.
  it("answers the label the plugin declared", () => {
    document.body.innerHTML = `
      <div data-node="layout/tab/tab-1">
        <div data-native-surface="browser" data-native-surface-id="browser.win-a.tab-1"></div>
      </div>`;
    expect(surfaceLabelOfView("tab-1")).toBe("browser.win-a.tab-1");
  });

  it("answers nothing for a view that declares no surface", () => {
    document.body.innerHTML = `<div data-node="layout/tab/tab-2"><span>terminal</span></div>`;
    expect(surfaceLabelOfView("tab-2")).toBeNull();
  });

  it("answers nothing for a view that is not on screen", () => {
    expect(surfaceLabelOfView("tab-3")).toBeNull();
  });
});

describe("a surface declared outside its pane", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  // A surface travelling between panes, or parked, is declared on an element the pane does not
  // contain right now. Answering null there parks nothing and unparks nothing.
  it("is still found by the view it names", () => {
    document.body.innerHTML = `
      <div data-node="layout/tab/tab-1"></div>
      <div data-native-surface="browser" data-native-surface-id="browser.win-a.tab-1"></div>`;
    expect(surfaceLabelOfView("tab-1")).toBe("browser.win-a.tab-1");
  });

  // Another view's surface, declared outside every pane, is not handed to this view.
  it("is not confused with another view's", () => {
    document.body.innerHTML = `
      <div data-node="layout/tab/tab-1"></div>
      <div data-native-surface="browser" data-native-surface-id="browser.win-a.tab-2"></div>`;
    expect(surfaceLabelOfView("tab-1")).toBeNull();
  });
});
