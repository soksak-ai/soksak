// @vitest-environment jsdom
// The adapter's install leaves a content view implementation registered.
//
// The core commits every tab's visibility through that implementation
// (lib/viewPark.commitViewVisibility). With none registered the call throws
// inside a render effect and React unmounts the whole tree: measured
// 2026-08-15, ui.tree went from 64 exposed nodes to 0 the moment a view opened,
// and the window was blank with no message on screen.
import { beforeEach, describe, expect, it, vi } from "vitest";

// A commit names the window that declared the surfaces; the install starts the observer, so this
// window needs a name for that first commit to be made at all.
vi.mock("../../lib/webviewLabels", () => ({ currentWindowLabel: () => "win-test" }));

vi.mock("../../../bindings/github.com/soksak-ai/wails-service-native-compositor/service", () => ({
  Commit: vi.fn(async () => ({ sequence: 1, accepted: true, surfaces: [] })),
}));
vi.mock("../../../bindings/github.com/soksak-ai/wails-service-native-compositor/models", () => ({
  Snapshot: { createFrom: (value: unknown) => value },
}));

// jsdom has no ResizeObserver, and the surface observer observes declared
// elements for size changes. Supplying it keeps the failure about this file
// rather than about the environment.
vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

import {
  __resetContentViewHostForTest,
  contentViewHost,
  hasContentViewHost,
} from "../../lib/contentViews";
import { installWailsSurfaces } from "./install";

describe("the wails adapter's install", () => {
  beforeEach(() => {
    __resetContentViewHostForTest();
  });

  it("registers a content view implementation", async () => {
    expect(hasContentViewHost()).toBe(false);
    await installWailsSurfaces();
    expect(hasContentViewHost()).toBe(true);
  });

  it("commits a view's visibility without throwing, surface or not", async () => {
    await installWailsSurfaces();
    // A plugin view inside the document has no native surface, and
    // parking it is the core's ordinary path for every tab.
    await expect(contentViewHost().visible("browser:pan-aaaaaa", false)).resolves.toBeUndefined();
  });

  it("refuses what this host does not do, by name", async () => {
    // navigate and the other four verbs now travel to the surface that owns them. What is left is
    // still refused with the method in the message, because a caller that gets one line with no
    // name cannot tell "not built here" from "broken".
    await installWailsSurfaces();
    await expect(contentViewHost().evalJs("browser:pan-aaaaaa", "1"))
      .rejects.toThrow(/evalJs/);
  });
});
