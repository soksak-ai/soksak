// @vitest-environment jsdom
// Surface reconciliation is window-scoped by the public three-field label grammar. Searching for
// a separator inside the label predates that grammar and makes every current surface disappear.
import { afterEach, describe, expect, it, vi } from "vitest";

const labels = [
  "webview.win-test.tab-browser",
  "terminal.win-test.tab-terminal-1",
  "webview.win-other.tab-away",
];

vi.mock("../lib/webviewLabels", () => ({ currentWindowLabel: () => "win-test" }));
vi.mock("../lib/contentViews", () => ({
  CONTENT_VIEW_BODY: "data-content-view-body",
  contentViewDomFacts: () => [],
  nativeSurfaceDomFacts: () => [
    { id: "webview.win-test.tab-browser", ownerViewId: "tab-browser" },
    { id: "terminal.win-test.tab-terminal-1", ownerViewId: "tab-terminal" },
  ],
  contentViewHost: () => ({
    list: async () => labels,
    picture: async (label: string) => label === "terminal.win-test.tab-terminal-1"
      ? "data:image/png;base64,c3VyZmFjZQ==" : null,
  }),
}));
vi.mock("../state/sessions", () => ({
  allViews: (layout: { views: Array<{ id: string }> }) => layout.views,
  useSessions: {
    getState: () => ({
      workspaces: [{ spaces: [{ layout: { views: [{ id: "tab-browser" }, { id: "tab-terminal" }] } }] }],
    }),
  },
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
  unregister("surface.snapshot");
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
      "terminal.win-test.tab-terminal-1",
    ]);
    expect((result.data as { ghosts: string[] }).ghosts).toEqual([]);
    expect((result.data as { unowned: string[] }).unowned).toEqual([]);
    expect(getSpec("webview.surfaces")).toBeUndefined();
  });

  it("returns the exact applied surface pixels through a public snapshot command", async () => {
    registerWebviewCatalog();

    const result = await execute("surface.snapshot", {
      id: "terminal.win-test.tab-terminal-1",
    }, {});

    expect(result).toMatchObject({
      ok: true,
      data: {
        id: "terminal.win-test.tab-terminal-1",
      },
      media: { kind: "image/png", base64: "c3VyZmFjZQ==" },
    });
    await expect(execute("surface.snapshot", { id: "terminal.win-other.tab-away" }, {}))
      .resolves.toMatchObject({ ok: false, code: "TARGET_NOT_FOUND" });
  });
});
