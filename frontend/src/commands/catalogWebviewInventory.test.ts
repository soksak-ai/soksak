// @vitest-environment jsdom
// Surface reconciliation is window-scoped by the public three-field label grammar. Searching for
// a separator inside the label predates that grammar and makes every current surface disappear.
import { afterEach, describe, expect, it, vi } from "vitest";

const labels = [
  "webview.win-test.tab-browser",
  "terminal.win-test.tab-terminal",
  "webview.win-other.tab-away",
];

vi.mock("../lib/webviewLabels", () => ({ currentWindowLabel: () => "win-test" }));
vi.mock("../lib/contentViews", () => ({
  CONTENT_VIEW_BODY: "data-content-view-body",
  contentViewDomFacts: () => [],
  contentViewHost: () => ({ list: async () => labels }),
}));
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: vi.fn(async (name: string) => {
    if (name === "window_list") return ["win-test", "win-other"];
    if (name === "engine_surface_stats") return { registered: labels.length, providerParentPresent: true };
    return {};
  }),
}));

import { registerWebviewCatalog } from "./catalogWebview";
import { execute, getSpec, unregister } from "./registry";

afterEach(() => {
  unregister("surface.inventory");
  unregister("webview.surfaces");
  unregister("webview.health.query");
  unregister("webview.recover");
});

describe("surface.inventory window inventory", () => {
  it("includes every native surface whose declared window field is current", async () => {
    registerWebviewCatalog();

    const result = await execute("surface.inventory", {}, {});

    expect(result.ok).toBe(true);
    expect((result.data as { actual: string[] }).actual).toEqual([
      "webview.win-test.tab-browser",
      "terminal.win-test.tab-terminal",
    ]);
    expect(getSpec("webview.surfaces")).toBeUndefined();
  });
});
